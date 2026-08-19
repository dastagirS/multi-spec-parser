/**
 * MultiSpecParser — the single public entry point for the package.
 *
 * Owns the full lifecycle: config (URL / text / object) → load → parse →
 * compile → request building → execution. No dangling functions: everything
 * hangs off one class, and the module's internal functions are unreachable
 * through the package exports map.
 *
 * Usage:
 *   const parser = new MultiSpecParser({
 *     spec: { url: "https://petstore3.swagger.io/api/v3/openapi.json" },
 *     options: { baseUrl: "https://petstore3.swagger.io" },
 *   });
 *   await parser.parse();
 *   const tool = parser.tool("findPetsByStatus");
 *   const res = await parser.execute(tool, { status: "available" });
 */

import assert from "node:assert/strict";

import { loadSpecSource, clearSpecCache, specCacheStats } from "./factory.js";
import type {
  CompileResult,
  CompiledTool,
  ExtraParameterRule,
  TransformOptions,
} from "./factory.js";
import { buildRequest as buildRequestFor, executeRequest } from "./request-builder.js";
import type {
  BuiltRequest,
  ExecuteRequestOptions,
  ExecuteResult,
  RequestBuildOptions,
  RequestTransport,
} from "./request-builder.js";
import type { ExtractedOperation, ParsedSpec, SchemaObject, SpecFormat } from "./types.js";
import type { ValidateFunction } from "ajv";
import {
  cloneForDefaultApplication,
  createStandardSchemaAdapter,
  type DefaultPolicy,
  type StandardSchemaLike,
} from "./standard-schema-adapter.js";
import { registerOpenApiFormats, resolveAjvFormatsPlugin } from "./openapi-formats.js";

/** Exactly one spec source. URL fetches (content-addressed cache); text is raw
 *  JSON or YAML (sniffed, never extension-guessed); spec is a pre-parsed object.
 *  T is the spec's own shape for object sources (parse() returns it typed). */
export type SpecSource<T = Record<string, unknown>> =
  | { url: string }
  | { text: string }
  | { spec: T };

export interface MultiSpecParserOptions {
  /** Cap on a tool's per-tool $defs JSON size (default 1MB; see CompileOptions). */
  maxDefsBytes?: number;
  /** Default base URL for buildRequest/execute; also the origin that relative
   *  spec servers (petstore3's /api/v3) resolve against. */
  baseUrl?: string;
  /** Headers applied to every request (auth etc.); merged with per-call ones. */
  headers?: Record<string, string>;
  /** Default timeout for execute() calls (ms). */
  executeTimeoutMs?: number;
  /** Optional API request transport; global fetch is used when omitted. */
  transport?: RequestTransport;
  /** Open compile-time filter: return true to keep an op. A filtered op never
   *  becomes a tool — it can't be listed, described, or executed. Runs
   *  pre-dedup. Examples: readOnly → op => !["POST","PUT","PATCH","DELETE"].includes(op.method);
   *  denylist → op => !BLOCKED.has(op.toolName); scope-gate → op =>
   *  op.requiredScopes?.includes(x). */
  filterOps?: (op: ExtractedOperation) => boolean;
  /** Item 5: ordered rules for consumer-supplied input properties. */
  extraParameterRules?: ExtraParameterRule[];
  /** Ordered response processor rules. Every matching rule runs in
   *  declaration order, after response transforms and before truncation. */
  processors?: ProcessorRule[];
  /** Item 3: called on a 401 before each retry; return the new Authorization
   *  header value (your closure does the OAuth refresh). */
  onUnauthorized?: () => string | Promise<string>;
  /** Item 3: how many retries after the first 401 (default 1). */
  maxAuthRetries?: number;
  /** Item 4: serialized result size cap; oversized results become
   *  { status: "truncated", … }. Runs after processors. */
  maxResponseBytes?: number;
  /** Item 4: warning hook when a result is truncated (must not throw). */
  onTruncate?: (size: number, toolName: string) => void;
  /** Maximum raw response body retained before decoding (default 50 MiB). */
  maxResponseBodyBytes?: number;
  /** Consumer-owned compile and request/response transformations. */
  transforms?: TransformOptions;
  /** Parsed/document cache controls. */
  cache?: CacheOptions;
  /** Item 8: per-tool inputSchema byte budget for describeTools() (default 64KB). */
  describeMaxBytes?: number;
  /** Whether validation/execution preserves or applies schema defaults. */
  defaultPolicy?: DefaultPolicy;
}

/** Item 2: result transformer; may be async; may not throw (a throw degrades
 *  to an explicit error result, never an unhandled rejection). */
export type ExecuteProcessor = (
  result: ExecuteResult,
  ctx: {
    tool: CompiledTool;
    args: Record<string, unknown>;
    request: BuiltRequest;
    response?: ExecuteResult["response"];
    retryCount: number;
    signal?: AbortSignal;
  },
) => ExecuteResult | Promise<ExecuteResult>;

export interface ProcessorRule {
  matches: (tool: CompiledTool) => boolean;
  process: ExecuteProcessor;
}

/** Item 8: one entry of describeTools() — the LLM/prompt projection. */
export interface ToolDescription {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Success-response contract, bounded by the same describeMaxBytes budget
   *  (its $refs resolve against the entry's inputSchema.$defs). */
  outputSchema?: Record<string, unknown>;
}

/** Result of parser.validate() — never throws; issues carry Ajv messages. */
export type ValidationResult =
  | { valid: true; value?: unknown }
  | { valid: false; issues: Array<{ message: string }> };

export interface CacheOptions {
  enabled?: boolean;
  maxEntries?: number;
  ttlMs?: number;
}

export interface ParseOptions {
  signal?: AbortSignal;
}

export interface ValidationOptions {
  defaultPolicy?: DefaultPolicy;
}

export interface MultiSpecParserConfig<T = Record<string, unknown>> {
  spec: SpecSource<T>;
  options?: MultiSpecParserOptions;
}

const NOT_PARSED =
  "MultiSpecParser: call await parser.parse() before using tools/requests.";

/** Item 8: default per-tool schema budget for describeTools(). */
const DEFAULT_DESCRIBE_MAX_BYTES = 64 * 1024;

// validate() lazily loads ajv only when first called (dynamic import), so the
// core module never statically imports it — the standard-schema subpath is
// the only place ajv is required at module load.
const validators = new WeakMap<CompiledTool, Map<DefaultPolicy, ValidateFunction>>();

export class MultiSpecParser<
  T extends Record<string, unknown> = Record<string, unknown>,
> {
  private readonly source: SpecSource<T>;
  private readonly options: MultiSpecParserOptions;
  private parsed: ParsedSpec | undefined;
  private compiled: CompileResult | undefined;
  /** The raw parsed document (JSON/YAML → object, pre-normalization) that
   *  parse() returns — typed as T for object sources. */
  private raw: T | undefined;
  private readonly standardSchemaWrappers = new WeakMap<CompiledTool, StandardSchemaLike>();

  constructor(config: MultiSpecParserConfig<T>) {
    validateConfig(config);
    this.source = config.spec;
    this.options = config.options ?? {};
  }

  /** Load (fetch if URL) + parse. Memoized: repeated calls return the cached
   *  model. Returns the RAW parsed document, typed to the input spec for
   *  object sources — the parser's view of the underlying schema:
   *
   *     const { resources } = await parser.parse();
   *
   *  (URL/text sources are Record<string, unknown>; pass an explicit generic
   *  to type them: new MultiSpecParser<MyType>({ spec: { url } })). */
  async parse(parseOptions: ParseOptions = {}): Promise<T> {
    if (parseOptions.signal?.aborted) throw new Error("MultiSpecParser: parse aborted.");
    if (this.parsed) return this.raw as T;
    const source = this.sourceAsInput();
    const { document, parsed, compiled } = await loadSpecSource(source, {
      maxDefsBytes: this.options.maxDefsBytes,
      filterOps: this.options.filterOps,
      extraParameterRules: this.options.extraParameterRules,
      transforms: this.options.transforms,
      signal: parseOptions.signal,
      cache: this.options.cache,
    });
    this.raw = document as T;
    this.parsed = parsed;
    this.compiled = compiled;
    return this.raw;
  }

  /** Detected dialect (openapi3 / swagger2 / google-discovery). */
  get format(): SpecFormat {
    return this.requireParsed().specFormat;
  }

  /** First declared server URL (relative servers stay relative — pair with the
   *  options.baseUrl origin when building requests). Empty when none declared. */
  get baseUrl(): string {
    return this.requireParsed().baseUrl ?? "";
  }

  /** Hoisted shared defs map referenced by every tool's $defs closure. */
  get defs(): Record<string, unknown> {
    return this.requireCompiled().defs;
  }

  /** All compiled tools (per-tool $defs closures, Ajv-compilable). Returns a
   *  copy — mutating the result can't corrupt the parser's internal list. */
  tools(): CompiledTool[] {
    return [...this.requireCompiled().tools];
  }

  /** Item 8: LLM-facing tool list with a per-tool schema size budget. The
   *  full $defs closure stays on tool.inputSchema (Ajv side); here, schemas
   *  over describeMaxBytes drop $defs and expose the closure's ref NAMES
   *  instead — bounded, readable, token-cheap. */
  describeTools(): ToolDescription[] {
    const maxBytes = this.options.describeMaxBytes ?? DEFAULT_DESCRIBE_MAX_BYTES;
    return this.tools().map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: boundedSchema(tool.inputSchema, maxBytes),
      ...(tool.outputSchema
        ? { outputSchema: boundedSchema(tool.outputSchema, maxBytes) }
        : {}),
    }));
  }

  /** Return a combined Standard Schema + Standard JSON Schema adapter. The
   *  validator is asynchronous here so the core keeps Ajv lazy-loaded. */
  toStandardSchema(
    tool: string | CompiledTool,
    options: ValidationOptions = {},
  ): StandardSchemaLike {
    assert(options !== null && typeof options === "object" && !Array.isArray(options), "validation options must be an object");
    const defaultPolicy = options.defaultPolicy ?? this.options.defaultPolicy ?? "preserve";
    assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
    const resolved = this.resolveTool(tool);
    const cached = this.standardSchemaWrappers.get(resolved);
    if (cached && defaultPolicy === (this.options.defaultPolicy ?? "preserve")) return cached;
    const wrapper = createStandardSchemaAdapter(resolved, async (value) => {
      const result = await this.validate(resolved, value, { defaultPolicy });
      if (result.valid) return { value: "value" in result ? result.value : value };
      return { issues: result.issues };
    }, { defaultPolicy });
    if (defaultPolicy === (this.options.defaultPolicy ?? "preserve")) {
      this.standardSchemaWrappers.set(resolved, wrapper);
    }
    return wrapper;
  }

  /** Validate args against a tool's input schema. Never throws; ajv is loaded
   *  lazily on first call (the core module has no static ajv import). */
  async validate(
    tool: string | CompiledTool,
    args: unknown,
    options: ValidationOptions = {},
  ): Promise<ValidationResult> {
    const resolved = this.resolveTool(tool);
    try {
      assert(options !== null && typeof options === "object" && !Array.isArray(options), "validation options must be an object");
      const defaultPolicy = options.defaultPolicy ?? this.options.defaultPolicy ?? "preserve";
      assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
      const validate = await this.getValidator(resolved, defaultPolicy);
      const candidate = defaultPolicy === "apply" ? cloneForDefaultApplication(args) : args;
      if (validate(candidate)) {
        return defaultPolicy === "apply" ? { valid: true, value: candidate } : { valid: true };
      }
      return {
        valid: false,
        issues:
          validate.errors?.map((e) => ({ message: e.message ?? "invalid" })) ?? [],
      };
    } catch (err) {
      // A schema or validator failure must not escape validate() — surface it
      // as an issue so callers keep one error-handling path.
      return {
        valid: false,
        issues: [
          { message: err instanceof Error ? err.message : String(err) },
        ],
      };
    }
  }

  private async getValidator(tool: CompiledTool, defaultPolicy: DefaultPolicy): Promise<ValidateFunction> {
    assert(tool !== null && typeof tool === "object", "compiled tool must be an object");
    assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
    let cached = validators.get(tool);
    if (!cached) {
      cached = new Map();
      validators.set(tool, cached);
    }
    const existing = cached.get(defaultPolicy);
    if (existing) return existing;
    const [{ Ajv }, addFormatsModule] = await Promise.all([
      import("ajv"),
      import("ajv-formats"),
    ]);
    const instance = new Ajv({
      strict: false,
      allErrors: true,
      ...(defaultPolicy === "apply" ? { useDefaults: true } : {}),
    });
    resolveAjvFormatsPlugin(addFormatsModule)(instance);
    registerOpenApiFormats(instance);
    const validator = instance.compile(tool.inputSchema as object);
    cached.set(defaultPolicy, validator);
    return validator;
  }

  private async applyConfiguredDefaults(
    tool: CompiledTool,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    assert(tool !== null && typeof tool === "object", "compiled tool must be an object");
    assert(args !== null && typeof args === "object" && !Array.isArray(args), "execution args must be an object");
    if ((this.options.defaultPolicy ?? "preserve") === "preserve") return args;
    const candidate = cloneForDefaultApplication(args);
    const validate = await this.getValidator(tool, "apply");
    validate(candidate);
    return candidate;
  }

  /** The tool with the given name, or undefined. */
  tool(name: string): CompiledTool | undefined {
    return this.tools().find((t) => t.name === name);
  }

  /** Success-response schema of a tool; refs resolve against its inputSchema.$defs. */
  outputSchema(tool: string | CompiledTool): SchemaObject | undefined {
    return this.resolveTool(tool).outputSchema as SchemaObject | undefined;
  }

  /** Build an HTTP request. Config options.baseUrl/headers are defaults;
   *  per-call options override (headers merge). */
  buildRequest(
    tool: string | CompiledTool,
    args: Record<string, unknown>,
    options: RequestBuildOptions = {},
  ): BuiltRequest {
    const resolved = this.resolveTool(tool);
    const defaults: RequestBuildOptions = {
      ...(this.options.baseUrl !== undefined ? { baseUrl: this.options.baseUrl } : {}),
      headers: { ...(this.options.headers ?? {}) },
    };
    const request = buildRequestFor(resolved.operation, args, {
      ...defaults,
      ...options,
      headers: { ...defaults.headers, ...(options.headers ?? {}) },
    });
    const transform = this.options.transforms?.request;
    if (!transform) return request;
    const transformed = transform(request, { tool: resolved, args });
    if (!isBuiltRequest(transformed)) {
      throw new TypeError("Request transform returned an invalid request.");
    }
    return transformed;
  }

  /** Build + execute. Returns { status, httpStatus, data } — never throws on
   *  HTTP errors (non-2xx → status:"error"); network failures are surfaced the
   *  same way.
   *
   *  Pipeline: fetch → [401 → onUnauthorized() → retry] → processor → truncate.
   */
  async execute(
    tool: string | CompiledTool,
    args: Record<string, unknown>,
    options: ExecuteRequestOptions = {},
  ): Promise<ExecuteResult> {
    const resolved = this.resolveTool(tool);
    const timeoutMs = options.timeoutMs ?? this.options.executeTimeoutMs;
    const maxResponseBodyBytes = options.maxResponseBodyBytes ?? this.options.maxResponseBodyBytes;
    let effectiveArgs: Record<string, unknown>;
    try {
      effectiveArgs = await this.applyConfiguredDefaults(resolved, args);
    } catch (error: unknown) {
      return requestFailure(resolved, error);
    }

    // Item 3: 401 → onUnauthorized() → retry (maxAuthRetries times). The
    // retried request rebuilds with the new Authorization header; per-call
    // headers win over config defaults in buildRequest, so this overrides
    // any stale config Authorization. A failing refresher never loops — it
    // degrades to an explicit error result.
    const maxAuthRetries = this.options.maxAuthRetries ?? 1;
    let retries = 0;
    let request: BuiltRequest;
    try {
      request = this.buildRequest(resolved, effectiveArgs, options);
    } catch (error: unknown) {
      return requestFailure(resolved, error);
    }
    let result = await executeRequest(request, {
      timeoutMs,
      signal: options.signal,
      maxResponseBodyBytes,
      retryCount: 0,
      transport: this.options.transport,
    });
    while (
      result.status === "error" &&
      result.httpStatus === 401 &&
      retries < maxAuthRetries &&
      this.options.onUnauthorized
    ) {
      retries += 1;
      let header: string;
      try {
        header = await this.options.onUnauthorized();
      } catch (err) {
        const message = `onUnauthorized failed: ${errorMessage(err)}`;
        return {
          status: "error",
          data: null,
          httpStatus: 401,
          error: message,
          errorDetails: {
            code: "HTTP_ERROR",
            message,
            httpStatus: 401,
            url: request.url,
            method: request.method,
            retryCount: retries,
            causeMessage: errorMessage(err),
          },
        };
      }
      try {
        request = this.buildRequest(resolved, effectiveArgs, {
          ...options,
          headers: { ...(options.headers ?? {}), Authorization: header },
        });
      } catch (error: unknown) {
        return requestFailure(resolved, error);
      }
      result = await executeRequest(request, {
        timeoutMs,
        signal: options.signal,
        maxResponseBodyBytes,
        retryCount: retries,
        transport: this.options.transport,
      });
    }

    result = await this.applyResponseTransform(resolved, effectiveArgs, request, result, retries, options.signal);
    // Item 2: post-process (consumer closure owns S3/PII/etc.).
    result = await this.applyProcessor(resolved, effectiveArgs, result, request, retries, options.signal);

    // Item 4: uniform size guarantee AFTER processors (a processor can shrink
    // the result — truncating first would destroy its input).
    return this.maybeTruncate(resolved, result);
  }

  private async applyResponseTransform(
    tool: CompiledTool,
    args: Record<string, unknown>,
    request: BuiltRequest,
    result: ExecuteResult,
    retryCount: number,
    signal: AbortSignal | undefined,
  ): Promise<ExecuteResult> {
    const transform = this.options.transforms?.response;
    if (!transform) return result;
    try {
      const transformed = await transform(result, { tool, args, request, retryCount, signal });
      return isExecuteResult(transformed) ? transformed : processorFailure(result, `Response transform for "${tool.name}" returned an invalid result.`);
    } catch (error: unknown) {
      return processorFailure(result, `Response transform for "${tool.name}" failed: ${errorMessage(error)}`);
    }
  }

  private async applyProcessor(
    tool: CompiledTool,
    args: Record<string, unknown>,
    result: ExecuteResult,
    request: BuiltRequest,
    retryCount: number,
    signal: AbortSignal | undefined,
  ): Promise<ExecuteResult> {
    const rules = this.options.processors ?? [];
    for (const rule of rules) {
      let matches = false;
      try {
        matches = rule.matches(tool);
      } catch (error: unknown) {
        return processorFailure(
          result,
          `Processor matcher for "${tool.name}" failed: ${errorMessage(error)}`,
        );
      }
      if (!matches) continue;
      try {
        const processed = await rule.process(result, {
          tool,
          args,
          request,
          response: result.response,
          retryCount,
          signal,
        });
        if (!isExecuteResult(processed)) {
          return processorFailure(
            result,
            `Processor for "${tool.name}" returned an invalid result (expected an ExecuteResult).`,
          );
        }
        result = processed;
      } catch (error: unknown) {
        return processorFailure(
          result,
          `Processor for "${tool.name}" failed: ${errorMessage(error)}`,
        );
      }
    }
    return result;
  }

  private maybeTruncate(tool: CompiledTool, result: ExecuteResult): ExecuteResult {
    const maxBytes = this.options.maxResponseBytes;
    if (maxBytes === undefined) return result;
    let size: number;
    try {
      size = new TextEncoder().encode(JSON.stringify(result)).byteLength;
    } catch (error: unknown) {
      return {
        status: "error",
        data: null,
        httpStatus: result.httpStatus,
        error: `Response could not be serialized: ${errorMessage(error)}`,
        errorDetails: {
          code: "INVALID_RESPONSE",
          message: "Response could not be serialized",
          url: result.response?.url ?? "",
          method: tool.method,
          retryCount: result.errorDetails?.retryCount ?? 0,
          causeMessage: errorMessage(error),
        },
      };
    }
    if (size <= maxBytes) return result;
    try {
      this.options.onTruncate?.(size, tool.name);
    } catch {
      // A warning hook must never break execute() (swallow).
    }
    return {
      status: "truncated",
      data: null,
      httpStatus: result.httpStatus,
      size,
      toolName: tool.name,
      response: result.response,
      errorDetails: result.errorDetails,
      message:
        `Response was ${size} bytes — exceeds the ${maxBytes}-byte limit. ` +
        `Request a narrower response (fewer fields / more specific parameters).`,
    };
  }

  /** The normalized operation behind a tool (params, requestBody, servers…).
   *  NOTE: internal model — its shape may change in minor versions. Persist or
   *  key on the stable tool fields (name/method/path/inputSchema/outputSchema),
   *  not on operation internals. */
  operation(tool: string | CompiledTool): CompiledTool["operation"] {
    return this.resolveTool(tool).operation;
  }

  /** Clear shared source caches; useful after a spec deployment or in tests. */
  clearCache(): void {
    clearSpecCache();
  }

  /** Inspect shared text/in-flight source cache entries without exposing values. */
  cacheStats(): { textEntries: number; inflightEntries: number } {
    return specCacheStats();
  }

  private sourceAsInput(): string | Record<string, unknown> {
    if (isUrlSource(this.source)) return this.source.url;
    if (isTextSource(this.source)) return this.source.text;
    return this.source.spec;
  }

  private requireParsed(): ParsedSpec {
    if (!this.parsed) throw new Error(NOT_PARSED);
    return this.parsed;
  }

  private requireCompiled(): CompileResult {
    if (!this.compiled) throw new Error(NOT_PARSED);
    return this.compiled;
  }

  private resolveTool(tool: string | CompiledTool): CompiledTool {
    if (typeof tool !== "string") return tool;
    const found = this.tool(tool);
    if (!found) throw new Error(`MultiSpecParser: unknown tool "${tool}".`);
    return found;
  }
}

function validateConfig(config: MultiSpecParserConfig): void {
  if (!config || typeof config !== "object") {
    throw new TypeError("MultiSpecParser: config object required.");
  }
  // Fail loud on unknown top-level keys: a key that the implementation
  // never reads (e.g. processors/extraParameterRules at the top level instead
  // of inside options) would otherwise no-op forever with zero signal.
  const knownConfigKeys = ["spec", "options"];
  for (const key of Object.keys(config)) {
    if (!knownConfigKeys.includes(key)) {
      throw new TypeError(
        `MultiSpecParser: unknown config key "${key}" — config takes { spec, options }, so put it inside options.`,
      );
    }
  }
  const source = config.spec;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError(
      `MultiSpecParser: spec source required — got ${JSON.stringify(source)}.`,
    );
  }
  const present = (["url", "text", "spec"] as const).filter((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (present.length !== 1) {
    throw new TypeError(
      `MultiSpecParser: spec must be exactly one of {url}, {text}, {spec} — got ${JSON.stringify(source)}.`,
    );
  }
  // Runtime guards for JS consumers (TS already enforces these statically).
  if (hasOwnKey(source, "url")) {
    if (typeof source.url !== "string" || source.url.length === 0) {
      throw new TypeError("MultiSpecParser: spec.url must be a non-empty string.");
    }
  } else if (hasOwnKey(source, "text")) {
    if (typeof source.text !== "string" || source.text.length === 0) {
      throw new TypeError("MultiSpecParser: spec.text must be a non-empty string.");
    }
  } else if (typeof source.spec !== "object" || source.spec === null || Array.isArray(source.spec)) {
    throw new TypeError("MultiSpecParser: spec.spec must be a plain object.");
  }

  validateOptions(config.options);
}

/** Runtime guards for options (I3) — JS consumers can't rely on TS types. */
function validateOptions(options: MultiSpecParserOptions | undefined): void {
  if (options === undefined) return;
  if (typeof options !== "object" || options === null || Array.isArray(options)) {
    throw new TypeError("MultiSpecParser: options must be an object.");
  }
  const { maxDefsBytes, baseUrl, headers, executeTimeoutMs, defaultPolicy } = options;
  if (defaultPolicy !== undefined && defaultPolicy !== "preserve" && defaultPolicy !== "apply") {
    throw new TypeError("MultiSpecParser: options.defaultPolicy must be preserve or apply.");
  }
  if (
    maxDefsBytes !== undefined &&
    (typeof maxDefsBytes !== "number" || !Number.isFinite(maxDefsBytes) || maxDefsBytes <= 0)
  ) {
    throw new TypeError("MultiSpecParser: options.maxDefsBytes must be a positive number.");
  }
  if (baseUrl !== undefined && typeof baseUrl !== "string") {
    throw new TypeError("MultiSpecParser: options.baseUrl must be a string.");
  }
  if (
    headers !== undefined &&
    (typeof headers !== "object" || headers === null || Array.isArray(headers))
  ) {
    throw new TypeError("MultiSpecParser: options.headers must be an object.");
  }
  if (
    executeTimeoutMs !== undefined &&
    (typeof executeTimeoutMs !== "number" ||
      !Number.isFinite(executeTimeoutMs) ||
      executeTimeoutMs <= 0)
  ) {
    throw new TypeError(
      "MultiSpecParser: options.executeTimeoutMs must be a positive number.",
    );
  }

  const positiveNumber = (value: unknown, label: string): void => {
    if (
      value !== undefined &&
      (typeof value !== "number" || !Number.isFinite(value) || value <= 0)
    ) {
      throw new TypeError(
        `MultiSpecParser: options.${label} must be a positive number.`,
      );
    }
  };
  if (options.filterOps !== undefined && typeof options.filterOps !== "function") {
    throw new TypeError("MultiSpecParser: options.filterOps must be a function.");
  }
  if (options.processors !== undefined) {
    if (!Array.isArray(options.processors)) {
      throw new TypeError("MultiSpecParser: options.processors must be an array of rules.");
    }
    for (const [index, rule] of options.processors.entries()) {
      if (
        rule === null ||
        typeof rule !== "object" ||
        typeof rule.matches !== "function" ||
        typeof rule.process !== "function"
      ) {
        throw new TypeError(
          `MultiSpecParser: options.processors[${index}] must contain matches and process functions.`,
        );
      }
    }
  }
  if (options.extraParameterRules !== undefined) {
    if (!Array.isArray(options.extraParameterRules)) {
      throw new TypeError(
        "MultiSpecParser: options.extraParameterRules must be an array of rules.",
      );
    }
    for (const [index, rule] of options.extraParameterRules.entries()) {
      if (
        rule === null ||
        typeof rule !== "object" ||
        typeof rule.matches !== "function" ||
        !Array.isArray(rule.parameters)
      ) {
        throw new TypeError(
          `MultiSpecParser: options.extraParameterRules[${index}] must contain matches and parameters[].`,
        );
      }
    }
  }
  if (options.transport !== undefined && typeof options.transport !== "function") {
    throw new TypeError("MultiSpecParser: options.transport must be a function.");
  }
  if (options.onUnauthorized !== undefined && typeof options.onUnauthorized !== "function") {
    throw new TypeError("MultiSpecParser: options.onUnauthorized must be a function.");
  }
  if (
    options.maxAuthRetries !== undefined &&
    (!Number.isInteger(options.maxAuthRetries) || options.maxAuthRetries < 0)
  ) {
    throw new TypeError(
      "MultiSpecParser: options.maxAuthRetries must be a non-negative integer.",
    );
  }
  positiveNumber(options.maxResponseBytes, "maxResponseBytes");
  positiveNumber(options.maxResponseBodyBytes, "maxResponseBodyBytes");
  positiveNumber(options.describeMaxBytes, "describeMaxBytes");
  validateCacheOptions(options.cache);
  if (options.onTruncate !== undefined && typeof options.onTruncate !== "function") {
    throw new TypeError("MultiSpecParser: options.onTruncate must be a function.");
  }
  if (options.transforms !== undefined && typeof options.transforms !== "object") {
    throw new TypeError("MultiSpecParser: options.transforms must be an object.");
  }
}

function validateCacheOptions(cache: CacheOptions | undefined): void {
  if (cache === undefined) return;
  if (typeof cache !== "object" || cache === null || Array.isArray(cache)) {
    throw new TypeError("MultiSpecParser: options.cache must be an object.");
  }
  if (cache.maxEntries !== undefined && (!Number.isInteger(cache.maxEntries) || cache.maxEntries <= 0)) {
    throw new TypeError("MultiSpecParser: options.cache.maxEntries must be a positive integer.");
  }
  if (cache.ttlMs !== undefined && (!Number.isFinite(cache.ttlMs) || cache.ttlMs <= 0)) {
    throw new TypeError("MultiSpecParser: options.cache.ttlMs must be a positive number.");
  }
}

/** Shape guard for processor results — a wrong-shaped return degrades to the
 *  original result rather than corrupting the ExecuteResult contract. */
function isUrlSource<T>(source: SpecSource<T>): source is { url: string } {
  return Object.prototype.hasOwnProperty.call(source, "url");
}

function isTextSource<T>(source: SpecSource<T>): source is { text: string } {
  return Object.prototype.hasOwnProperty.call(source, "text");
}

function hasOwnKey<T extends object, K extends PropertyKey>(
  value: T,
  key: K,
): value is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isExecuteResult(value: unknown): value is ExecuteResult {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === "success" || status === "error" || status === "truncated";
}

function isBuiltRequest(value: unknown): value is BuiltRequest {
  if (typeof value !== "object" || value === null) return false;
  const request = value as { url?: unknown; method?: unknown; headers?: unknown };
  return typeof request.url === "string" && typeof request.method === "string" &&
    typeof request.headers === "object" && request.headers !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestFailure(tool: CompiledTool, error: unknown): ExecuteResult {
  const message = errorMessage(error);
  return {
    status: "error",
    data: null,
    httpStatus: 0,
    error: message,
    errorDetails: {
      code: "INVALID_REQUEST",
      message,
      url: "",
      method: tool.method,
      retryCount: 0,
      causeMessage: message,
    },
  };
}

function processorFailure(result: ExecuteResult, message: string): ExecuteResult {
  return {
    status: "error",
    data: null,
    httpStatus: result.httpStatus,
    error: message,
    ...(result.response ? { response: result.response } : {}),
  };
}

/** Item 8: $defs-stripped projection when the full schema exceeds the budget. */
function boundedSchema(
  schema: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  if (JSON.stringify(schema).length <= maxBytes) return schema;
  const defs = schema.$defs as Record<string, unknown> | undefined;
  const refNames = defs ? Object.keys(defs).sort() : [];
  const { $defs: _dropped, ...rest } = schema;
  return { ...rest, $refs: refNames };
}
