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

import assert from "node:assert/strict";

import { assertValidParsedSpecModel } from "./model-validation.js";
import { collectReachableDefs, normalizeDefs, normalizeSchemaRefs, removeDanglingRefs, setOwn } from "./schema-closure.js";
import { fetchSpecText, MAX_SPEC_BYTES, parseSpec, parseSpecText } from "./parse-spec.js";
import {
  assignUniqueToolName,
  createUniqueToolNameState,
  TOOL_NAME_LOOKUP_LENGTH_MAX,
} from "./tool-names.js";
import type {
  ExtractedOperation,
  NormalizedParameter,
  ParsedSpec,
  SchemaObject,
  ServerInfo,
} from "./types.js";
import type { BuiltRequest, ExecuteResult } from "./request-builder.js";

export interface CompiledTool {
  name: string;
  /** Stable method + path identity, independent of the LLM-facing name. */
  operationKey: string;
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
   * Cap on a tool's serialized per-tool $defs UTF-8 byte size. When a tool's
   * closure exceeds
   * it, the FULL shared defs map is attached by reference instead (Option A:
   * Ajv-safe, zero extra memory). Default 1MB — Stripe's hyper-connected
   * schema graph (anyOf web) naturally reaches ~1MB per tool; GitHub stays
   * far below this and proves the closure works.
   */
  maxDefsBytes?: number;
  /** Open compile-time filter: return true to keep an op. A filtered op never
   *  becomes a tool — it can't be listed, described, or executed (the safety
   *  boundary). Runs pre-dedup, so kept ops' names are unaffected by dropped
   *  ones. Examples: readOnly → op => !["POST","PUT","PATCH","DELETE"].includes(op.method); denylist → op =>
   *  !BLOCKED.has(op.toolName); scope-gate → op => op.requiredScopes?.includes(x). */
  filterOps?: (op: ExtractedOperation) => boolean;
  /** Item 5: ordered rules for consumer-supplied input properties. Every
   *  matching rule adds LLM-visible fields ignored by buildRequest. */
  extraParameterRules?: ExtraParameterRule[];
  /** Consumer-owned compile and request/response transformation seams. */
  transforms?: TransformOptions;
}

export interface TransformOptions {
  operation?: (operation: ExtractedOperation) => ExtractedOperation;
  schema?: (schema: SchemaObject, context: SchemaTransformContext) => SchemaObject;
  request?: (request: BuiltRequest, context: RequestTransformContext) => BuiltRequest;
  response?: (
    result: ExecuteResult,
    context: ResponseTransformContext,
  ) => ExecuteResult | Promise<ExecuteResult>;
}

export interface SchemaTransformContext {
  kind: "definition" | "parameter" | "request-body" | "response";
  name?: string;
  operation?: ExtractedOperation;
}

export interface RequestTransformContext {
  tool: CompiledTool;
  args: Record<string, unknown>;
  /** Opaque execution-local dependencies; absent during public buildRequest(). */
  runtimeContext?: unknown;
}

export interface ResponseTransformContext {
  tool: CompiledTool;
  args: Record<string, unknown>;
  /** Opaque execution-local dependencies for this execution. */
  runtimeContext?: unknown;
  request: BuiltRequest;
  signal?: AbortSignal;
}

/** Item 5: a consumer-supplied input property merged into a tool's schema. */
export interface ExtraParameter {
  name: string;
  schema: SchemaObject;
  description?: string;
  required?: boolean;
}

export interface ExtraParameterRule {
  matches: (operation: ExtractedOperation) => boolean;
  parameters: ExtraParameter[];
}

const DEFAULT_MAX_DEFS_BYTES = 1_000_000;
const UTF8_ENCODER = new TextEncoder();
const MAX_EXTRA_PARAMETER_RULES = 1_000;
const MAX_EXTRA_PARAMETERS_PER_RULE = 100;

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

export interface LazyToolCompiler {
  readonly defs: Record<string, unknown>;
  getTool(name: string): CompiledTool | undefined;
  getToolByOperationKey(operationKey: string): CompiledTool | undefined;
  compileAll(): CompileResult;
}

export interface ToolLocator {
  name: string;
  path: string;
  method: string;
  operationKey: string;
}

export interface ToolNameIndex {
  has(name: string): boolean;
  get(name: string): ToolLocator | undefined;
}

export function createToolNameIndex(
  parsed: ParsedSpec,
  options: CompileOptions = {},
): ToolNameIndex {
  const locators = new Map<string, ToolLocator>(prepareOperations(parsed, options).map((operation) => [
    operation.name,
    {
      name: operation.name,
      path: operation.sourceOperation.path,
      method: operation.sourceOperation.method,
      operationKey: operation.sourceOperation.operationKey,
    },
  ]));
  return {
    has(name: string): boolean {
      assert(typeof name === "string", "tool name must be a string");
      assert(name.length <= TOOL_NAME_LOOKUP_LENGTH_MAX, "tool name exceeds the lookup length limit");
      return locators.has(name);
    },
    get(name: string): ToolLocator | undefined {
      assert(typeof name === "string", "tool name must be a string");
      assert(name.length <= TOOL_NAME_LOOKUP_LENGTH_MAX, "tool name exceeds the lookup length limit");
      return locators.get(name);
    },
  };
}

export function createLazyToolCompiler(
  parsed: ParsedSpec,
  options: CompileOptions = {},
): LazyToolCompiler {
  return new PreparedToolCompiler(parsed, options);
}

export function compileSpecToTools(
  parsed: ParsedSpec,
  options: CompileOptions = {},
): CompileResult {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "compile options must be an object");
  return createLazyToolCompiler(parsed, options).compileAll();
}

class PreparedToolCompiler implements LazyToolCompiler {
  private readonly parsed: ParsedSpec;
  private readonly options: CompileOptions;
  private readonly prepared: PreparedCompile;
  private readonly byName = new Map<string, PreparedOperation>();
  private readonly compiledByName = new Map<string, CompiledTool>();
  private allResult: CompileResult | undefined;

  constructor(parsed: ParsedSpec, options: CompileOptions) {
    assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
    assert(options !== null && typeof options === "object" && !Array.isArray(options), "compile options must be an object");
    this.parsed = parsed;
    this.options = options;
    this.prepared = prepareCompile(parsed, options);
    for (const operation of this.prepared.operations) this.byName.set(operation.name, operation);
  }

  get defs(): Record<string, unknown> {
    assert(this.prepared.defs !== null && typeof this.prepared.defs === "object", "prepared defs must be an object");
    assert(typeof this.prepared.specFormat === "string", "prepared spec format must be a string");
    return this.prepared.defs;
  }

  getTool(name: string): CompiledTool | undefined {
    assert(typeof name === "string", "tool name must be a string");
    assert(name.length <= TOOL_NAME_LOOKUP_LENGTH_MAX, "tool name exceeds the lookup length limit");
    const prepared = this.byName.get(name);
    return prepared ? this.compileOperation(prepared) : undefined;
  }

  getToolByOperationKey(operationKey: string): CompiledTool | undefined {
    assert(typeof operationKey === "string" && operationKey.length > 0, "operation key must be non-empty");
    assert(operationKey.length <= TOOL_NAME_LOOKUP_LENGTH_MAX, "operation key exceeds the lookup length limit");
    const prepared = this.prepared.operations.find((operation) => operation.sourceOperation.operationKey === operationKey);
    return prepared ? this.compileOperation(prepared) : undefined;
  }

  private compileOperation(prepared: PreparedOperation): CompiledTool {
    assert(prepared !== null && typeof prepared === "object", "prepared operation must be an object");
    assert(typeof prepared.name === "string" && prepared.name.length > 0, "prepared operation name must be non-empty");
    const cached = this.compiledByName.get(prepared.name);
    if (cached) return cached;
    const compiled = compilePreparedOperation(this.parsed, this.options, this.prepared, prepared);
    this.compiledByName.set(prepared.name, compiled);
    return compiled;
  }

  compileAll(): CompileResult {
    assert(Array.isArray(this.prepared.operations), "prepared operations must be an array");
    assert(this.prepared.operations.length <= 1_000_000, "prepared operations exceed the safety limit");
    if (this.allResult) return this.allResult;
    const tools: CompiledTool[] = [];
    for (const prepared of this.prepared.operations) tools.push(this.compileOperation(prepared));
    this.allResult = {
      tools,
      defs: this.prepared.defs,
      specFormat: this.prepared.specFormat,
      baseUrl: this.prepared.baseUrl,
    };
    return this.allResult;
  }
}

function prepareCompile(parsed: ParsedSpec, options: CompileOptions): PreparedCompile {
  assertValidParsedSpecModel(parsed);
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "compile options must be an object");
  const maxDefsBytes = options.maxDefsBytes ?? DEFAULT_MAX_DEFS_BYTES;
  const transformedSchemas: Record<string, SchemaObject> = {};
  for (const [name, schema] of Object.entries(parsed.schemas)) {
    setOwn(transformedSchemas, name, applySchemaTransform(schema, {
      kind: "definition",
      name,
    }, options.transforms));
  }
  // Pruning the shared graph once avoids repeating the same walk for every
  // tool while preserving per-tool unresolved-ref reporting below.
  const rawDefs = normalizeDefs(transformedSchemas) as unknown as Record<string, unknown>;
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
  const operations = prepareOperations(parsed, options);
  return {
    defs,
    prunedRefsByDef,
    operations,
    maxDefsBytes,
    specFormat: parsed.specFormat,
    baseUrl: parsed.baseUrl,
  };
}

function prepareOperations(parsed: ParsedSpec, options: CompileOptions): PreparedOperation[] {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "compile options must be an object");
  const operations: PreparedOperation[] = [];
  const uniqueNames = createUniqueToolNameState();
  for (const sourceOperation of parsed.operations) {
    const transformedOperation = options.transforms?.operation
      ? options.transforms.operation(sourceOperation)
      : sourceOperation;
    if (!isExtractedOperation(transformedOperation)) {
      throw new TypeError("Operation transform must return an ExtractedOperation.");
    }
    if (options.filterOps && !options.filterOps(transformedOperation)) continue;
    operations.push({
      name: assignUniqueToolName(transformedOperation.toolName, uniqueNames),
      sourceOperation: transformedOperation,
    });
  }
  return operations;
}

function compilePreparedOperation(
  parsed: ParsedSpec,
  options: CompileOptions,
  preparedCompile: PreparedCompile,
  prepared: PreparedOperation,
): CompiledTool {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(prepared !== null && typeof prepared === "object", "prepared operation must be an object");
  const operation = assignInputNames(prepared.sourceOperation, parsed.servers);
  const rawInput = buildInputSchema(operation, parsed.servers, options.transforms);
  mergeExtraParameters(rawInput, resolveExtraParameters(operation, options.extraParameterRules));
  const inputSchema = normalizeSchemaRefs(rawInput) as Record<string, unknown>;
  const outputSchema = operation.outputSchema
    ? (normalizeSchemaRefs(applySchemaTransform(operation.outputSchema, {
        kind: "response",
        operation,
      }, options.transforms)) as Record<string, unknown>)
    : undefined;
  let reachable = collectReachableDefs(
    [inputSchema, outputSchema as unknown],
    preparedCompile.defs as unknown as Record<string, SchemaObject>,
  );
  if (Object.keys(reachable).length > 0) {
    if (UTF8_ENCODER.encode(JSON.stringify(reachable)).byteLength > preparedCompile.maxDefsBytes) {
      // The full map is shared by reference, so dense closures do not clone a
      // large schema graph into every tool.
      reachable = preparedCompile.defs as unknown as Record<string, SchemaObject>;
    }
    (inputSchema.$defs as Record<string, unknown>) = reachable;
  }
  // Shared definitions were already pruned; this pass only checks the tool's
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
  transforms: TransformOptions | undefined,
): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const param of op.parameters) {
    const inputName = param.inputName ?? param.name;
    setOwn(properties, inputName, applySchemaTransform(param.schema, {
      kind: "parameter",
      name: param.name,
      operation: op,
    }, transforms));
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
        setOwn(properties, name, applySchemaTransform(schema, {
          kind: "request-body",
          name,
          operation: op,
        }, transforms));
      }
      for (const name of rb.schema!.required ?? []) {
        if (!required.includes(name)) required.push(name);
      }
    } else if (rb.schema && !Object.prototype.hasOwnProperty.call(properties, "body")) {
      properties.body = applySchemaTransform(rb.schema, {
        kind: "request-body",
        operation: op,
      }, transforms);
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

function resolveExtraParameters(
  operation: ExtractedOperation,
  rules: ExtraParameterRule[] | undefined,
): ExtraParameter[] | undefined {
  if (!operation || typeof operation !== "object") {
    throw new TypeError("compileSpecToTools: operation must be an object.");
  }
  if (rules === undefined) return undefined;
  if (!Array.isArray(rules)) {
    throw new TypeError("compileSpecToTools: extraParameterRules must be an array of rules.");
  }
  assert(operation !== null && typeof operation === "object", "operation must be an object");
  assert(Array.isArray(rules), "extraParameterRules must be an array");
  if (rules.length > MAX_EXTRA_PARAMETER_RULES) {
    throw new RangeError(
      `compileSpecToTools: extraParameterRules exceeds ${MAX_EXTRA_PARAMETER_RULES} rules.`,
    );
  }
  const matched: ExtraParameter[] = [];
  for (const [index, rule] of rules.entries()) {
    if (
      rule === null ||
      typeof rule !== "object" ||
      typeof rule.matches !== "function" ||
      !Array.isArray(rule.parameters)
    ) {
      throw new TypeError(
        `compileSpecToTools: extraParameterRules[${index}] must contain matches and parameters[].`,
      );
    }
    if (rule.parameters.length > MAX_EXTRA_PARAMETERS_PER_RULE) {
      throw new RangeError(
        `compileSpecToTools: extraParameterRules[${index}] exceeds ${MAX_EXTRA_PARAMETERS_PER_RULE} parameters.`,
      );
    }
    for (const [parameterIndex, parameter] of rule.parameters.entries()) {
      validateExtraParameter(parameter, `extraParameterRules[${index}].parameters[${parameterIndex}]`);
    }
    let matches: unknown;
    try {
      matches = rule.matches(operation);
    } catch (error: unknown) {
      throw new Error(`extraParameterRules[${index}].matches failed.`, { cause: error });
    }
    if (typeof matches !== "boolean") {
      throw new TypeError(`extraParameterRules[${index}].matches must return a boolean.`);
    }
    if (matches) matched.push(...rule.parameters);
  }
  return matched;
}

function validateExtraParameter(extra: unknown, location: string): asserts extra is ExtraParameter {
  assert(typeof location === "string" && location.length > 0, "parameter location must be named");
  assert(extra !== undefined, "extra parameter must be provided");
  if (
    !extra ||
    typeof extra !== "object" ||
    typeof (extra as Record<string, unknown>).name !== "string" ||
    (extra as Record<string, unknown>).name === "" ||
    typeof (extra as Record<string, unknown>).schema !== "object" ||
    (extra as Record<string, unknown>).schema === null ||
    Array.isArray((extra as Record<string, unknown>).schema)
  ) {
    throw new TypeError(
      `compileSpecToTools: ${location} must be { name, schema } — got ${JSON.stringify(extra)}.`,
    );
  }
}

/** Item 5: merge consumer-supplied input properties into a tool's schema. */
function mergeExtraParameters(
  input: Record<string, unknown>,
  extras: ExtraParameter[] | undefined,
): void {
  assert(input !== null && typeof input === "object" && !Array.isArray(input), "input schema must be an object");
  assert(extras === undefined || Array.isArray(extras), "extra parameters must be an array");
  if (!extras || extras.length === 0) return;
  const properties = (input.properties ??= {}) as Record<string, unknown>;
  const seen = new Set<string>();
  for (const extra of extras) {
    validateExtraParameter(extra, "extraParameter");
    if (seen.has(extra.name)) {
      throw new TypeError(
        `compileSpecToTools: duplicate extraParameter "${extra.name}" matched multiple rules.`,
      );
    }
    seen.add(extra.name);
    if (Object.prototype.hasOwnProperty.call(properties, extra.name)) {
      throw new TypeError(
        `compileSpecToTools: extraParameter "${extra.name}" collides with a spec-declared input.`,
      );
    }
    setOwn(properties, extra.name, {
      ...extra.schema,
      ...(extra.description ? { description: extra.description } : {}),
    });
    if (extra.required) {
      const required = (input.required as string[] | undefined) ?? [];
      if (!required.includes(extra.name)) required.push(extra.name);
      (input as Record<string, unknown>).required = required;
    }
  }
}

function applySchemaTransform(
  schema: SchemaObject,
  context: SchemaTransformContext,
  transforms: TransformOptions | undefined,
): SchemaObject {
  const transform = transforms?.schema;
  if (!transform) return schema;
  const transformed = transform(schema, context);
  if (typeof transformed !== "object" || transformed === null || Array.isArray(transformed)) {
    throw new TypeError("Schema transform must return a schema object.");
  }
  return transformed;
}

function isExtractedOperation(value: unknown): value is ExtractedOperation {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const operation = value as Partial<ExtractedOperation>;
  return typeof operation.operationKey === "string" && operation.operationKey.length > 0 &&
    typeof operation.toolName === "string" && typeof operation.path === "string" &&
    Array.isArray(operation.parameters);
}

// ---------------------------------------------------------------------------
// Source-level convenience with content-addressed caching
// ---------------------------------------------------------------------------

const textCache = new Map<string, LoadedSpec>();
interface CachedParsedSpec {
  parsed: ParsedSpec;
  cachedAtMs: number;
}

let objectCache = new WeakMap<object, CachedParsedSpec>();
const DEFAULT_CACHE_MAX_ENTRIES = 32;
const DEFAULT_CACHE_TTL_MS = 0;
const MAX_SOURCE_OBJECT_NODES = 1_000_000;
// In-flight string-source loads: two concurrent loads of the same URL must
// fetch + parse once, not twice (PR6).
const inflightText = new Map<string, Promise<LoadedSpec>>();
const inflightSourceText = new Map<string, Promise<string>>();

/** A loaded string source: the raw parsed document (JSON/YAML → object, pre-
 *  normalization — what parser.parse() returns for typed access) + the
 *  normalized model derived from it. */
interface LoadedSpec {
  document: Record<string, unknown>;
  parsed: ParsedSpec;
  sourceText?: string;
  cachedAtMs: number;
}

export interface SourceCacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  ttlMs?: number;
}

function assertObjectSourceWithinLimit(source: Record<string, unknown>): void {
  const pending: unknown[] = [source];
  const visited = new WeakSet<object>();
  let estimatedBytes = 2;
  let nodes = 0;
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (value === null) {
      estimatedBytes += 4;
      continue;
    }
    if (typeof value === "string") {
      estimatedBytes += new TextEncoder().encode(value).byteLength + 2;
      continue;
    }
    if (typeof value !== "object") {
      estimatedBytes += String(value).length + 1;
      continue;
    }
    if (visited.has(value)) continue;
    visited.add(value);
    nodes += 1;
    if (nodes > MAX_SOURCE_OBJECT_NODES) throw new Error("Spec object exceeds the supported node limit");
    if (Array.isArray(value)) {
      for (const item of value) pending.push(item);
      continue;
    }
    for (const [key, child] of Object.entries(value)) {
      estimatedBytes += new TextEncoder().encode(key).byteLength + 3;
      pending.push(child);
    }
    if (estimatedBytes > MAX_SPEC_BYTES) {
      throw new Error(`Spec too large: object exceeds ${MAX_SPEC_BYTES} byte limit`);
    }
  }
}

// Bounded LRU: a long-lived process loading many distinct specs shouldn't
// retain every raw text + parsed model forever (G2). Re-insert on hit.
function textCacheGet(key: string, cache: SourceCacheOptions): LoadedSpec | undefined {
  if (cache.enabled === false) return undefined;
  const hit = textCache.get(key);
  if (hit === undefined) return undefined;
  if (cache.ttlMs !== undefined && cache.ttlMs > DEFAULT_CACHE_TTL_MS && Date.now() - hit.cachedAtMs > cache.ttlMs) {
    textCache.delete(key);
    return undefined;
  }
  textCache.delete(key);
  textCache.set(key, hit);
  return hit;
}

function textCacheSet(key: string, loaded: LoadedSpec, cache: SourceCacheOptions): void {
  if (cache.enabled === false) return;
  textCache.delete(key);
  textCache.set(key, loaded);
  const maxEntries = cache.maxEntries ?? DEFAULT_CACHE_MAX_ENTRIES;
  while (textCache.size > maxEntries) {
    const oldest = textCache.keys().next().value;
    if (oldest === undefined) break;
    textCache.delete(oldest);
  }
}

/** Load source bytes without constructing the parsed document. */
export async function loadSpecTextSource(
  source: string | Record<string, unknown>,
  signal?: AbortSignal,
): Promise<string | Record<string, unknown>> {
  assert(source !== null && (typeof source === "string" || typeof source === "object"), "source must be text or an object");
  assert(signal === undefined || typeof signal === "object", "signal must be an AbortSignal or undefined");
  if (typeof source !== "string") return source;
  if (!source.startsWith("http://") && !source.startsWith("https://")) return source;
  const existing = inflightSourceText.get(source);
  if (existing) return existing;
  const pending = fetchSpecText(source, signal);
  inflightSourceText.set(source, pending);
  try {
    return await pending;
  } finally {
    inflightSourceText.delete(source);
  }
}

/**
 * Load a spec source (URL, raw text, or pre-parsed object) into a parsed
 * model + compiled tools. Parse is content-addressed (identical URL/text
 * parses once per process — a 12.9MB GitHub spec parses once); compile runs
 * fresh per call so per-call options (maxDefsBytes) always apply.
 */
export interface LoadSpecOptions extends CompileOptions {
  signal?: AbortSignal;
  cache?: SourceCacheOptions;
  compile?: boolean;
  cacheParsed?: boolean;
}

export async function loadSpecSource(
  source: string | Record<string, unknown>,
  options: LoadSpecOptions = {},
): Promise<{ document: Record<string, unknown>; parsed: ParsedSpec; sourceText?: string; compiled: CompileResult | undefined }> {
  if (typeof source !== "string") {
    // The raw document of an object source IS the passed object (identity —
    // parser.parse() returns it typed as the consumer's spec).
    assertObjectSourceWithinLimit(source);
    const cache = options.cache ?? {};
    const cached = options.cacheParsed === false || cache.enabled === false ? undefined : objectCache.get(source);
    const cacheFresh = cached === undefined || cache.ttlMs === undefined ||
      cache.ttlMs <= DEFAULT_CACHE_TTL_MS || Date.now() - cached.cachedAtMs <= cache.ttlMs;
    const parsed = cached && cacheFresh ? cached.parsed : parseSpec(source);
    if (!cached || !cacheFresh) objectCache.delete(source);
    if (options.cacheParsed !== false && cache.enabled !== false && (!cached || !cacheFresh)) {
      objectCache.set(source, { parsed, cachedAtMs: Date.now() });
    }
    return { document: source, parsed, compiled: compileLoadedSpec(parsed, options) };
  }
  const cache = options.cache ?? {};
  const cached = options.cacheParsed === false ? undefined : textCacheGet(source, cache);
  if (cached) return { ...cached, compiled: compileLoadedSpec(cached.parsed, options) };
  const existing = inflightText.get(source);
  if (existing) {
    const shared = await existing;
    return { ...shared, compiled: compileLoadedSpec(shared.parsed, options) };
  }
  const promise = (async (): Promise<LoadedSpec> => {
    const text =
      source.startsWith("http://") || source.startsWith("https://")
        ? await fetchSpecText(source, options.signal)
        : source;
    const document = parseSpecText(text);
    const loaded: LoadedSpec = {
      document,
      parsed: parseSpec(document),
      sourceText: text,
      cachedAtMs: Date.now(),
    };
    if (options.cacheParsed !== false) {
      textCacheSet(source, { document, parsed: loaded.parsed, cachedAtMs: loaded.cachedAtMs }, cache);
    }
    return loaded;
  })();
  inflightText.set(source, promise);
  let loaded: LoadedSpec;
  try {
    loaded = await promise;
  } finally {
    inflightText.delete(source);
  }
  return { ...loaded, compiled: compileLoadedSpec(loaded.parsed, options) };
}

function compileLoadedSpec(parsed: ParsedSpec, options: LoadSpecOptions): CompileResult | undefined {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "load options must be an object");
  return options.compile === false ? undefined : compileSpecToTools(parsed, options);
}

/**
 * Parse + compile a spec from URL text or a pre-parsed object. Convenience
 * one-shot for callers who don't need the MultiSpecParser lifecycle.
 */
export async function compileSpecSource(
  source: string | Record<string, unknown>,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const compiled = (await loadSpecSource(source, options)).compiled;
  assert(compiled !== undefined, "compileSpecSource must compile the loaded spec");
  return compiled;
}

/** Test-only: drop cached entries so tests observe cold-cache behavior. */
export interface SpecCacheStats {
  textEntries: number;
  inflightEntries: number;
}

export function clearSpecCache(): void {
  textCache.clear();
  inflightText.clear();
  inflightSourceText.clear();
  objectCache = new WeakMap();
}

export function specCacheStats(): SpecCacheStats {
  return { textEntries: textCache.size, inflightEntries: inflightText.size + inflightSourceText.size };
}
