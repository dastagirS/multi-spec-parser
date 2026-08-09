/**
 * Compile a parsed spec into LLM-tool definitions with JSON-Schema inputs.
 *
 * Memory model (the fix for the OOM + opaque-$ref problems):
 *   - Component schemas are normalized ONCE per spec (normalizeDefs) and
 *     referenced — never cloned — by every tool.
 *   - Each tool's input schema carries params + body only, `$ref`s as strings.
 *   - Each tool attaches ONLY the transitive $ref closure its own input +
 *     output schemas reach (collectReachableDefs), so per-tool $defs are KBs,
 *     not the full spec. Ajv compiles these without mutating them (verified:
 *     shared $defs across tools are safe).
 */

import { collectReachableDefs, normalizeDefs, normalizeSchemaRefs, removeDanglingRefs, setOwn } from "./schema-closure.js";
import { fetchSpecText, parseSpec, parseSpecText } from "./parse-spec.js";
import type {
  ExtractedOperation,
  ParsedSpec,
  SchemaObject,
  ServerInfo,
} from "./types.js";

export interface CompiledTool {
  name: string;
  description: string;
  method: ExtractedOperation["method"];
  path: string;
  /** JSON Schema (draft-07-compatible) with per-tool $defs closure. */
  inputSchema: Record<string, unknown>;
  /** Success-response schema; $refs resolve against inputSchema.$defs. */
  outputSchema: Record<string, unknown> | undefined;
  operation: ExtractedOperation;
  /** Refs that could not be resolved: top-level refs dropped at parse time
   *  (original form, e.g. #/components/parameters/X) + schema refs pruned at
   *  compile time (rewritten #/$defs/ form). Absent when none. */
  unresolvedRefs?: string[];
}

export interface CompileResult {
  tools: CompiledTool[];
  /** Hoisted normalized defs (shared, referenced by every tool). */
  defs: Record<string, unknown>;
  specFormat: ParsedSpec["specFormat"];
  baseUrl?: string;
}

export interface CompileOptions {
  /**
   * Cap on a tool's per-tool $defs JSON size. When a tool's closure exceeds
   * it, the FULL shared defs map is attached by reference instead (Option A:
   * Ajv-safe, zero extra memory). Default 1MB — Stripe's hyper-connected
   * schema graph (anyOf web) naturally reaches ~1MB per tool; GitHub stays
   * far below this and proves the closure works.
   */
  maxDefsBytes?: number;
}

const DEFAULT_MAX_DEFS_BYTES = 1_000_000;

export function compileSpecToTools(
  parsed: ParsedSpec,
  options: CompileOptions = {},
): CompileResult {
  const maxDefsBytes = options.maxDefsBytes ?? DEFAULT_MAX_DEFS_BYTES;

  // P1: prune the shared defs ONCE per compile. Transitivity means a ref
  // inside a def can only dangle if its name is missing from the WHOLE defs
  // map (the closure BFS includes everything reachable), so one global pass —
  // memoized per def object since defs are shared across tools — replaces the
  // old per-tool walk of the attached $defs subtree (Stripe: 1.2s → 3.0s).
  const rawDefs = normalizeDefs(parsed.schemas) as unknown as Record<string, unknown>;
  const allDefNames = new Set(Object.keys(rawDefs));
  const defPruneMemo = new WeakMap<object, unknown>();
  const prunedRefsByDef = new Map<string, Set<string>>();
  const defs: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(rawDefs)) {
    const cached = defPruneMemo.get(def as object);
    if (cached !== undefined) {
      setOwn(defs, name, cached);
      continue;
    }
    const prunedHere = new Set<string>();
    const prunedDef = removeDanglingRefs(def, allDefNames, prunedHere);
    defPruneMemo.set(def as object, prunedDef);
    if (prunedHere.size > 0) prunedRefsByDef.set(name, prunedHere);
    setOwn(defs, name, prunedDef);
  }

  const tools: CompiledTool[] = [];
  const seen = new Map<string, number>();
  const used = new Set<string>();

  for (const op of parsed.operations) {
    const name = ensureUniqueName(op.toolName, seen, used);
    // Op-level schemas carry native refs (#/components/schemas, #/definitions);
    // rewrite them at the boundary so $refs resolve against the hoisted $defs.
    const inputSchema = normalizeSchemaRefs(
      buildInputSchema(op, parsed.servers),
    ) as Record<string, unknown>;
    const outputSchema = op.outputSchema
      ? (normalizeSchemaRefs(op.outputSchema) as Record<string, unknown>)
      : undefined;

    // Closure of input + output refs, attached to the input schema so the LLM
    // can resolve $refs in BOTH schemas from one $defs block.
    let reachable = collectReachableDefs(
      [inputSchema, outputSchema as unknown],
      defs as unknown as Record<string, SchemaObject>,
    );
    if (Object.keys(reachable).length > 0) {
      if (JSON.stringify(reachable).length > maxDefsBytes) {
        // Pathological tool: its closure spans most of a huge spec. Share the
        // whole hoisted defs map by reference (never cloned) — Ajv compiles
        // against it without mutating, so validation stays correct.
        reachable = defs as unknown as Record<string, SchemaObject>;
      }
      (inputSchema.$defs as Record<string, unknown>) = reachable;
    }

    // Per-tool pruning covers ONLY the input/output graphs — the attached
    // $defs subtree was already pruned globally (P1), so it is skipped.
    const pruned = new Set<string>();
    const valid = new Set(Object.keys(reachable));
    const prunedInput = removeDanglingRefs(
      inputSchema,
      valid,
      pruned,
      "$defs",
    ) as Record<string, unknown>;
    const prunedOutput = outputSchema
      ? (removeDanglingRefs(outputSchema, valid, pruned) as Record<string, unknown>)
      : undefined;
    if (prunedInput !== inputSchema) {
      // Pruning returned a new graph — carry the $defs attachment over.
      (prunedInput as Record<string, unknown>).$defs = inputSchema.$defs;
    }

    // Defs that were globally pruned AND are in this tool's closure surface
    // their dangling refs here too (B1 + B3 discipline: per-tool reporting).
    const unresolvedRefs = new Set<string>(op.unresolvedRefs ?? []);
    for (const ref of pruned) unresolvedRefs.add(ref);
    for (const [defName, refs] of prunedRefsByDef) {
      if (defName in reachable) {
        for (const ref of refs) unresolvedRefs.add(ref);
      }
    }

    tools.push({
      name,
      description: buildDescription(op),
      method: op.method,
      path: op.path,
      inputSchema: prunedInput,
      outputSchema: prunedOutput,
      operation: op,
      ...(unresolvedRefs.size > 0 ? { unresolvedRefs: [...unresolvedRefs] } : {}),
    });
  }

  return { tools, defs, specFormat: parsed.specFormat, baseUrl: parsed.baseUrl };
}

/** Per-op input schema: params + body + optional contentType/server inputs. */
function buildInputSchema(
  op: ExtractedOperation,
  docServers: ServerInfo[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of op.parameters) {
    setOwn(properties, param.name, param.schema);
    if (param.required) required.push(param.name);
  }

  const servers = op.servers ?? docServers;
  const serverProperty = buildServerInput(servers);
  if (serverProperty && !("server" in properties)) properties.server = serverProperty;

  if (op.requestBody) {
    const rb = op.requestBody;
    const contents = rb.contents;
    const base = rb.contentType.split(";")[0]!.trim().toLowerCase();
    const isOctet = base === "application/octet-stream";
    const isForm = base === "application/x-www-form-urlencoded" || base === "multipart/form-data";
    // Form-style bodies are flat HTTP fields (Slack formData), so expose them
    // top-level instead of nesting under `body`. Fall back to nesting when the
    // schema isn't an object with properties, or a name collides with a param.
    const formProps =
      isForm && rb.schema?.type === "object" && rb.schema.properties
        ? rb.schema.properties
        : undefined;
    const reserved = [
      ...Object.keys(properties),
      ...(contents && contents.length > 1 ? ["contentType"] : []),
    ];
    const canFlatten =
      formProps !== undefined &&
      Object.keys(formProps).length > 0 &&
      !Object.keys(formProps).some((name) => reserved.includes(name));
    // A param named body/bodyBase64/contentType would be clobbered by the body
    // property — params are declared explicitly, so they win; the body input
    // is simply not exposed (N2, spec is ambiguous).
    let bodyAdded = false;
    let bodyBase64Added = false;
    if (canFlatten) {
      for (const [name, schema] of Object.entries(formProps)) {
        setOwn(properties, name, schema);
      }
      for (const name of rb.schema!.required ?? []) {
        if (!required.includes(name)) required.push(name);
      }
    } else if (rb.schema && !("body" in properties)) {
      properties.body = rb.schema;
      bodyAdded = true;
    }
    if (isOctet && !("bodyBase64" in properties)) {
      properties.bodyBase64 = {
        type: "string",
        contentEncoding: "base64",
        contentMediaType: "application/octet-stream",
        description: "Base64-encoded bytes for application/octet-stream bodies.",
      };
      bodyBase64Added = true;
    }
    if (rb.required) {
      if (isOctet && bodyBase64Added) required.push("bodyBase64");
      else if (bodyAdded) required.push("body");
    }
    if (contents && contents.length > 1 && !("contentType" in properties)) {
      properties.contentType = {
        type: "string",
        enum: contents.map((c) => c.contentType),
        default: rb.contentType,
        description: "Content-Type for the request body; spec order, first is default.",
      };
    }
  }

  if (Object.keys(properties).length === 0) return { type: "object", properties: {} };

  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

/** Optional server input: host selection + server-URL {variables}. */
function buildServerInput(servers: ServerInfo[]): Record<string, unknown> | undefined {
  const variableDefs: Record<string, { default: string; enum?: string[]; description?: string }> = {};
  for (const server of servers) {
    for (const [name, v] of Object.entries(server.variables ?? {})) {
      if (!(name in variableDefs)) setOwn(variableDefs, name, v);
    }
  }
  const variableNames = Object.keys(variableDefs);
  if (servers.length <= 1 && variableNames.length === 0) return undefined;

  const properties: Record<string, unknown> = {};
  if (servers.length > 1) {
    properties.url = {
      type: "string",
      enum: servers.map((s) => s.url),
      default: servers[0]!.url,
      description: "Which of the spec's servers to send the request to.",
    };
  }
  if (variableNames.length > 0) {
    properties.variables = {
      type: "object",
      additionalProperties: false,
      properties: Object.fromEntries(
        Object.entries(variableDefs).map(([name, v]) => [
          name,
          {
            type: "string",
            default: v.default,
            ...(v.enum ? { enum: v.enum } : {}),
            ...(v.description ? { description: v.description } : {}),
          },
        ]),
      ),
      description: "Values for server URL {variables}; spec defaults apply when omitted.",
    };
  }
  return {
    type: "object",
    additionalProperties: false,
    properties,
    description: "Optional host selection and server-URL variables.",
  };
}

function buildDescription(op: ExtractedOperation): string {
  const parts: string[] = [];
  if (op.summary) parts.push(op.summary);
  if (op.description && op.description !== op.summary) parts.push(op.description);
  if (parts.length === 0) parts.push(`${op.method} ${op.path}`);
  if (op.requiredScopes && op.requiredScopes.length > 0) {
    parts.push(`Required OAuth scopes: ${op.requiredScopes.join(", ")}`);
  }
  if (op.deprecated) parts.push("⚠️ DEPRECATED");
  return parts.join("\n\n");
}

function ensureUniqueName(
  candidate: string,
  seen: Map<string, number>,
  used: Set<string>,
): string {
  // Occurrence k of a candidate is named `candidate` (k=0) else `candidate_k`;
  // a real operationId may already occupy that name (getPet_1) — keep bumping
  // the suffix until the name is free (B4).
  const prior = seen.get(candidate) ?? 0;
  let name = prior === 0 ? candidate : `${candidate}_${prior}`;
  let n = prior;
  while (used.has(name)) {
    n += 1;
    name = `${candidate}_${n}`;
  }
  seen.set(candidate, n + 1);
  used.add(name);
  return name;
}

// ---------------------------------------------------------------------------
// Source-level convenience with content-addressed caching
// ---------------------------------------------------------------------------

const textCache = new Map<string, ParsedSpec>();
let objectCache = new WeakMap<object, ParsedSpec>();
// In-flight string-source loads: two concurrent loads of the same URL must
// fetch + parse once, not twice (PR6).
const inflightText = new Map<string, Promise<ParsedSpec>>();

// Bounded LRU: a long-lived process loading many distinct specs shouldn't
// retain every raw text + parsed model forever (G2). Re-insert on hit.
const TEXT_CACHE_MAX = 32;

function textCacheGet(key: string): ParsedSpec | undefined {
  const hit = textCache.get(key);
  if (hit !== undefined) {
    textCache.delete(key);
    textCache.set(key, hit);
  }
  return hit;
}

function textCacheSet(key: string, parsed: ParsedSpec): void {
  textCache.delete(key);
  textCache.set(key, parsed);
  if (textCache.size > TEXT_CACHE_MAX) {
    const oldest = textCache.keys().next().value;
    if (oldest !== undefined) textCache.delete(oldest);
  }
}

/**
 * Load a spec source (URL, raw text, or pre-parsed object) into a parsed
 * model + compiled tools. Parse is content-addressed (identical URL/text
 * parses once per process — a 12.9MB GitHub spec parses once); compile runs
 * fresh per call so per-call options (maxDefsBytes) always apply.
 */
export async function loadSpecSource(
  source: string | Record<string, unknown>,
  options: CompileOptions = {},
): Promise<{ parsed: ParsedSpec; compiled: CompileResult }> {
  if (typeof source !== "string") {
    let parsed = objectCache.get(source);
    if (!parsed) {
      parsed = parseSpec(source);
      objectCache.set(source, parsed);
    }
    return { parsed, compiled: compileSpecToTools(parsed, options) };
  }
  let parsed = textCacheGet(source);
  if (parsed) return { parsed, compiled: compileSpecToTools(parsed, options) };
  const existing = inflightText.get(source);
  if (existing) {
    const shared = await existing;
    return { parsed: shared, compiled: compileSpecToTools(shared, options) };
  }
  const promise = (async (): Promise<ParsedSpec> => {
    const text =
      source.startsWith("http://") || source.startsWith("https://")
        ? await fetchSpecText(source)
        : source;
    const parsedSpec = parseSpec(parseSpecText(text));
    textCacheSet(source, parsedSpec);
    return parsedSpec;
  })();
  inflightText.set(source, promise);
  try {
    parsed = await promise;
  } finally {
    inflightText.delete(source);
  }
  return { parsed, compiled: compileSpecToTools(parsed, options) };
}

/**
 * Parse + compile a spec from URL text or a pre-parsed object. Convenience
 * one-shot for callers who don't need the MultiSpecParser lifecycle.
 */
export async function compileSpecSource(
  source: string | Record<string, unknown>,
  options: CompileOptions = {},
): Promise<CompileResult> {
  return (await loadSpecSource(source, options)).compiled;
}

/** Test-only: drop cached entries so tests observe cold-cache behavior. */
export function clearSpecCache(): void {
  textCache.clear();
  inflightText.clear();
  objectCache = new WeakMap();
}
