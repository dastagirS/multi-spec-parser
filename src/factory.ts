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

import { collectReachableDefs, normalizeDefs, normalizeSchemaRefs } from "./schema-closure.js";
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
  const defs = normalizeDefs(parsed.schemas) as unknown as Record<string, unknown>;
  const tools: CompiledTool[] = [];
  const seen = new Map<string, number>();

  for (const op of parsed.operations) {
    const name = ensureUniqueName(op.toolName, seen);
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

    tools.push({
      name,
      description: buildDescription(op),
      method: op.method,
      path: op.path,
      inputSchema,
      outputSchema,
      operation: op,
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
    properties[param.name] = param.schema;
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
    if (canFlatten) {
      for (const [name, schema] of Object.entries(formProps)) {
        properties[name] = schema;
      }
      for (const name of rb.schema!.required ?? []) {
        if (!required.includes(name)) required.push(name);
      }
    } else if (rb.schema) {
      properties.body = rb.schema;
    }
    if (isOctet) {
      properties.bodyBase64 = {
        type: "string",
        contentEncoding: "base64",
        contentMediaType: "application/octet-stream",
        description: "Base64-encoded bytes for application/octet-stream bodies.",
      };
    }
    if (rb.required) {
      if (isOctet && rb.schema) required.push("bodyBase64");
      else if (properties.body !== undefined) required.push("body");
    }
    if (contents && contents.length > 1) {
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
      if (!(name in variableDefs)) variableDefs[name] = v;
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

function ensureUniqueName(candidate: string, seen: Map<string, number>): string {
  const count = seen.get(candidate) ?? 0;
  seen.set(candidate, count + 1);
  return count === 0 ? candidate : `${candidate}_${count}`;
}

// ---------------------------------------------------------------------------
// Source-level convenience with content-addressed caching
// ---------------------------------------------------------------------------

interface SourceCacheEntry {
  parsed: ParsedSpec;
  compiled: CompileResult;
}

const textCache = new Map<string, SourceCacheEntry>();
const objectCache = new WeakMap<object, SourceCacheEntry>();

/**
 * Parse + compile a spec from URL text or a pre-parsed object. Content-
 * addressed: identical text/URL yields the same parsed+compiled result, so a
 * multi-MB spec (GitHub 12.9MB) is parsed once per process instead of per call.
 */
export async function compileSpecSource(
  source: string | Record<string, unknown>,
): Promise<CompileResult> {
  if (typeof source !== "string") {
    const hit = objectCache.get(source);
    if (hit) return hit.compiled;
    const parsed = parseSpec(source);
    const compiled = compileSpecToTools(parsed);
    objectCache.set(source, { parsed, compiled });
    return compiled;
  }
  const hit = textCache.get(source);
  if (hit) return hit.compiled;
  const text = source.startsWith("http://") || source.startsWith("https://")
    ? await fetchSpecText(source)
    : source;
  const parsed = parseSpec(parseSpecText(text));
  const compiled = compileSpecToTools(parsed);
  textCache.set(source, { parsed, compiled });
  return compiled;
}

/** Test-only: drop cached entries so tests observe cold-cache behavior. */
export function clearSpecCache(): void {
  textCache.clear();
}
