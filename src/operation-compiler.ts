/**
 * Compile a normalized API description into operation-level JSON Schemas.
 * Definitions are normalized once, and each operation receives only the
 * transitive definition closure reachable from its input and output schemas.
 */

import assert from "node:assert/strict";

import { assertValidParsedSpecModel } from "./model-validation.js";
import { collectReachableDefs, normalizeDefs, normalizeSchemaRefs, removeDanglingRefs, setOwn } from "./schema-closure.js";
import {
  assignUniqueOperationName,
  createUniqueOperationNameState,
} from "./operation-names.js";
import type {
  ExtractedOperation,
  NormalizedParameter,
  ParsedSpec,
  SchemaObject,
  ServerInfo,
} from "./types.js";

export interface CompiledOperation {
  name: string;
  /** Stable method and path identity, independent of the generated name. */
  operationKey: string;
  description: string;
  method: ExtractedOperation["method"];
  path: string;
  /** JSON Schema (draft-07-compatible) with an operation-level $defs closure. */
  inputSchema: Record<string, unknown>;
  /** Success-response schema; $refs resolve against inputSchema.$defs. */
  outputSchema: Record<string, unknown> | undefined;
  operation: ExtractedOperation;
  /** Refs that could not be resolved: top-level refs dropped at parse time
   *  (original form, e.g. #/components/parameters/X) + schema refs pruned at
   *  compile time (rewritten #/$defs/ form). Absent when none. */
  unresolvedRefs?: string[];
}

export interface OperationCompileResult {
  operations: CompiledOperation[];
  /** Hoisted normalized defs shared across operation projections. */
  defs: Record<string, unknown>;
  specFormat: ParsedSpec["specFormat"];
  baseUrl?: string;
}

export interface CompileOptions {
  /** Use the shared definition map when a closure exceeds this UTF-8 budget. */
  maxDefsBytes?: number;
}

const DEFAULT_MAX_DEFS_BYTES = 1_000_000;
const UTF8_ENCODER = new TextEncoder();

interface PreparedOperation {
  name: string;
  sourceOperation: ExtractedOperation;
}

interface PreparedCompile {
  defs: Record<string, unknown>;
  prunedRefsByDef: Map<string, Set<string>>;
  operations: PreparedOperation[];
  maxDefsBytes: number;
  specFormat: ParsedSpec["specFormat"];
  baseUrl?: string;
}

export function compileSpecToOperations(
  parsed: ParsedSpec,
  options: CompileOptions = {},
): OperationCompileResult {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "compile options must be an object");
  const prepared = prepareCompile(parsed, options);
  const operations: CompiledOperation[] = [];
  for (const operation of prepared.operations) {
    operations.push(compilePreparedOperation(parsed, prepared, operation));
  }
  return {
    operations,
    defs: prepared.defs,
    specFormat: prepared.specFormat,
    baseUrl: prepared.baseUrl,
  };
}

function prepareCompile(parsed: ParsedSpec, options: CompileOptions): PreparedCompile {
  assertValidParsedSpecModel(parsed);
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "compile options must be an object");
  const maxDefsBytes = options.maxDefsBytes ?? DEFAULT_MAX_DEFS_BYTES;
  if (!Number.isFinite(maxDefsBytes) || maxDefsBytes <= 0) {
    throw new TypeError("compileSpecToOperations: maxDefsBytes must be positive.");
  }
  // Pruning the shared graph once avoids repeating the same walk for every
  // operation while preserving per-operation unresolved-ref reporting below.
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
  const operations = prepareOperations(parsed);
  return {
    defs,
    prunedRefsByDef,
    operations,
    maxDefsBytes,
    specFormat: parsed.specFormat,
    baseUrl: parsed.baseUrl,
  };
}

function prepareOperations(parsed: ParsedSpec): PreparedOperation[] {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(Array.isArray(parsed.operations), "parsed operations must be an array");
  const operations: PreparedOperation[] = [];
  const uniqueNames = createUniqueOperationNameState();
  for (const sourceOperation of parsed.operations) {
    operations.push({
      name: assignUniqueOperationName(sourceOperation.operationName, uniqueNames),
      sourceOperation,
    });
  }
  return operations;
}

function compilePreparedOperation(
  parsed: ParsedSpec,
  preparedCompile: PreparedCompile,
  prepared: PreparedOperation,
): CompiledOperation {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(prepared !== null && typeof prepared === "object", "prepared operation must be an object");
  const operation = assignInputNames(prepared.sourceOperation, parsed.servers);
  const inputSchema = normalizeSchemaRefs(
    buildInputSchema(operation, parsed.servers),
  ) as Record<string, unknown>;
  const outputSchema = operation.outputSchema
    ? (normalizeSchemaRefs(operation.outputSchema) as Record<string, unknown>)
    : undefined;
  let reachable = collectReachableDefs(
    [inputSchema, outputSchema as unknown],
    preparedCompile.defs as unknown as Record<string, SchemaObject>,
  );
  if (Object.keys(reachable).length > 0) {
    if (UTF8_ENCODER.encode(JSON.stringify(reachable)).byteLength > preparedCompile.maxDefsBytes) {
      // The full map is shared by reference, so dense closures do not clone a
      // large schema graph into every operation.
      reachable = preparedCompile.defs as unknown as Record<string, SchemaObject>;
    }
    (inputSchema.$defs as Record<string, unknown>) = reachable;
  }
  // Shared definitions were already pruned; this pass only checks the operation's
  // input/output boundary and carries its local unresolved refs forward.
  const pruned = new Set<string>();
  const valid = new Set(Object.keys(reachable));
  const prunedInput = removeDanglingRefs(inputSchema, valid, pruned, "$defs") as Record<string, unknown>;
  const prunedOutput = outputSchema
    ? (removeDanglingRefs(outputSchema, valid, pruned) as Record<string, unknown>)
    : undefined;
  if (prunedInput !== inputSchema) (prunedInput as Record<string, unknown>).$defs = inputSchema.$defs;
  const unresolvedRefs = new Set<string>(operation.unresolvedRefs ?? []);
  for (const ref of pruned) unresolvedRefs.add(ref);
  for (const [defName, refs] of preparedCompile.prunedRefsByDef) {
    if (Object.prototype.hasOwnProperty.call(reachable, defName)) {
      for (const ref of refs) unresolvedRefs.add(ref);
    }
  }
  return {
    name: prepared.name,
    operationKey: operation.operationKey,
    description: buildDescription(operation),
    method: operation.method,
    path: operation.path,
    inputSchema: prunedInput,
    outputSchema: prunedOutput,
    operation,
    ...(unresolvedRefs.size > 0 ? { unresolvedRefs: [...unresolvedRefs] } : {}),
  };
}

/** Per-op input schema: params + body + optional contentType/server inputs. */
function assignInputNames(
  operation: ExtractedOperation,
  documentServers: ServerInfo[],
): ExtractedOperation {
  const locationsByName = new Map<string, Set<NormalizedParameter["in"]>>();
  for (const parameter of operation.parameters) {
    const locations = locationsByName.get(parameter.name) ?? new Set();
    locations.add(parameter.in);
    locationsByName.set(parameter.name, locations);
  }

  const generated = generatedInputNames(operation, documentServers);
  const reserved = new Set(Object.values(generated).filter((name): name is string => name !== undefined));
  const used = new Set(reserved);
  const parameters = operation.parameters.map((parameter) => {
    const blocked = BLOCKED_INPUT_NAMES.has(parameter.name);
    const safeName = blocked ? `${parameter.name}_2` : parameter.name;
    const locations = locationsByName.get(parameter.name)!;
    const needsLocation = locations.size > 1 || reserved.has(parameter.name);
    const base = needsLocation && !blocked ? `${parameter.in}_${safeName}` : safeName;
    let inputName = base;
    let suffix = 2;
    while (used.has(inputName)) {
      inputName = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(inputName);
    return { ...parameter, inputName };
  });
  return { ...operation, parameters, generatedInputNames: generated };
}

function generatedInputNames(
  operation: ExtractedOperation,
  documentServers: ServerInfo[],
): NonNullable<ExtractedOperation["generatedInputNames"]> {
  const servers = operation.servers ?? documentServers;
  const names: NonNullable<ExtractedOperation["generatedInputNames"]> = {};
  if (servers.length > 1 || servers.some((server) => Object.keys(server.variables ?? {}).length > 0)) {
    names.server = "server";
  }
  if (operation.requestBody?.schema) {
    names.body = "body";
    const contentTypes = operation.requestBody.contents;
    if (contentTypes && contentTypes.length > 1) names.contentType = "contentType";
    if (operation.requestBody.contentType.split(";")[0]!.trim().toLowerCase() === "application/octet-stream") {
      names.bodyBase64 = "bodyBase64";
    }
  }
  return names;
}

const BLOCKED_INPUT_NAMES = new Set(["__proto__", "constructor", "prototype"]);

function buildInputSchema(
  op: ExtractedOperation,
  docServers: ServerInfo[],
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of op.parameters) {
    const inputName = param.inputName ?? param.name;
    setOwn(properties, inputName, param.schema);
    if (param.required) required.push(inputName);
  }

  const servers = op.servers ?? docServers;
  const serverProperty = buildServerInput(servers);
  if (serverProperty && !Object.prototype.hasOwnProperty.call(properties, "server")) setOwn(properties, "server", serverProperty);

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
    } else if (rb.schema && !Object.prototype.hasOwnProperty.call(properties, "body")) {
      properties.body = rb.schema;
      bodyAdded = true;
    }
    if (isOctet && !Object.prototype.hasOwnProperty.call(properties, "bodyBase64")) {
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
    if (contents && contents.length > 1 && !Object.prototype.hasOwnProperty.call(properties, "contentType")) {
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
      if (!Object.prototype.hasOwnProperty.call(variableDefs, name)) setOwn(variableDefs, name, v);
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
  if (op.security && op.security.length > 0) {
    const alternatives = op.security.map((alternative) =>
      alternative.schemes.length === 0
        ? "anonymous"
        : alternative.schemes.map((scheme) =>
            scheme.scopes.length > 0 ? `${scheme.name} [${scheme.scopes.join(", ")}]` : scheme.name,
          ).join(" AND "),
    );
    if (op.security.length === 1 && op.security[0]!.schemes.length === 1 &&
        op.security[0]!.schemes[0]!.name === "oauth2") {
      parts.push(`Required OAuth scopes: ${op.security[0]!.schemes[0]!.scopes.join(", ")}`);
    } else {
      parts.push(`Security alternatives: ${alternatives.join(" OR ")}`);
    }
  }
  if (op.deprecated) parts.push("⚠️ DEPRECATED");
  return parts.join("\n\n");
}
