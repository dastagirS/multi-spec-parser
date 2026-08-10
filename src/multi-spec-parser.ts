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

import { loadSpecSource } from "./factory.js";
import type { CompileResult, CompiledTool, ExtraParameter } from "./factory.js";
import { buildRequest as buildRequestFor, executeRequest } from "./request-builder.js";
import type {
  BuiltRequest,
  ExecuteResult,
  RequestBuildOptions,
} from "./request-builder.js";
import type { ExtractedOperation, ParsedSpec, SchemaObject, SpecFormat } from "./types.js";
import type { ValidateFunction } from "ajv";

/** Exactly one spec source. URL fetches (content-addressed cache); text is raw
 *  JSON or YAML (sniffed, never extension-guessed); spec is a pre-parsed object. */
export type SpecSource =
  | { url: string }
  | { text: string }
  | { spec: Record<string, unknown> };

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
  /** Open compile-time filter: return true to keep an op. A filtered op never
   *  becomes a tool — it can't be listed, described, or executed. Runs
   *  pre-dedup. Examples: readOnly → op => !["POST","PUT","PATCH","DELETE"].includes(op.method);
   *  denylist → op => !BLOCKED.has(op.toolName); scope-gate → op =>
   *  op.requiredScopes?.includes(x). */
  filterOps?: (op: ExtractedOperation) => boolean;
  /** Item 5: per-tool extra input-schema properties. */
  extraParameters?: Record<string, ExtraParameter[]>;
  /** Item 2: per-tool response post-processors, run after fetch, before
   *  truncation. The consumer's closure owns all stack-specific state (S3,
   *  PII stripping) — the package only calls the hook. */
  processors?: Record<string, ExecuteProcessor>;
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
  /** Item 8: per-tool inputSchema byte budget for describeTools() (default 64KB). */
  describeMaxBytes?: number;
}

/** Item 2: result transformer; may be async; may not throw (a throw degrades
 *  to an explicit error result, never an unhandled rejection). */
export type ExecuteProcessor = (
  result: ExecuteResult,
  ctx: { tool: CompiledTool; args: Record<string, unknown> },
) => ExecuteResult | Promise<ExecuteResult>;

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
  | { valid: true }
  | { valid: false; issues: Array<{ message: string }> };

export interface MultiSpecParserConfig {
  spec: SpecSource;
  options?: MultiSpecParserOptions;
}

const NOT_PARSED =
  "MultiSpecParser: call await parser.parse() before using tools/requests.";

/** Item 8: default per-tool schema budget for describeTools(). */
const DEFAULT_DESCRIBE_MAX_BYTES = 64 * 1024;

// validate() lazily loads ajv only when first called (dynamic import), so the
// core module never statically imports it — the standard-schema subpath is
// the only place ajv is required at module load.
const validators = new WeakMap<CompiledTool, ValidateFunction>();

export class MultiSpecParser {
  private readonly source: SpecSource;
  private readonly options: MultiSpecParserOptions;
  private parsed: ParsedSpec | undefined;
  private compiled: CompileResult | undefined;

  constructor(config: MultiSpecParserConfig) {
    validateConfig(config);
    this.source = config.spec;
    this.options = config.options ?? {};
  }

  /** Load (fetch if URL) + parse. Memoized: repeated calls return the cached
   *  model. Returns the normalized ParsedSpec. */
  async parse(): Promise<ParsedSpec> {
    if (this.parsed) return this.parsed;
    const source = this.sourceAsInput();
    const { parsed, compiled } = await loadSpecSource(source, {
      maxDefsBytes: this.options.maxDefsBytes,
      filterOps: this.options.filterOps,
      extraParameters: this.options.extraParameters,
    });
    this.parsed = parsed;
    this.compiled = compiled;
    return parsed;
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

  /** Validate args against a tool's input schema. Never throws; ajv is loaded
   *  lazily on first call (the core module has no static ajv import). */
  async validate(
    tool: string | CompiledTool,
    args: Record<string, unknown>,
  ): Promise<ValidationResult> {
    const resolved = this.resolveTool(tool);
    try {
      let validate = validators.get(resolved);
      if (!validate) {
        const { Ajv } = await import("ajv");
        validate = new Ajv({ strict: false, allErrors: true }).compile(
          resolved.inputSchema as object,
        );
        validators.set(resolved, validate);
      }
      if (validate(args)) return { valid: true };
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
    const defaults: RequestBuildOptions = {
      ...(this.options.baseUrl !== undefined ? { baseUrl: this.options.baseUrl } : {}),
      headers: { ...(this.options.headers ?? {}) },
    };
    return buildRequestFor(this.resolveTool(tool).operation, args, {
      ...defaults,
      ...options,
      headers: { ...defaults.headers, ...(options.headers ?? {}) },
    });
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
    options: RequestBuildOptions = {},
  ): Promise<ExecuteResult> {
    const resolved = this.resolveTool(tool);
    const timeoutMs =
      this.options.executeTimeoutMs !== undefined
        ? this.options.executeTimeoutMs
        : undefined;

    // Item 3: 401 → onUnauthorized() → retry (maxAuthRetries times). The
    // retried request rebuilds with the new Authorization header; per-call
    // headers win over config defaults in buildRequest, so this overrides
    // any stale config Authorization. A failing refresher never loops — it
    // degrades to an explicit error result.
    const maxAuthRetries = this.options.maxAuthRetries ?? 1;
    let retries = 0;
    let request = this.buildRequest(resolved, args, options);
    let result = await executeRequest(request, { timeoutMs });
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
        return {
          status: "error",
          data: null,
          httpStatus: 401,
          error: `onUnauthorized failed: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
      request = this.buildRequest(resolved, args, {
        ...options,
        headers: { ...(options.headers ?? {}), Authorization: header },
      });
      result = await executeRequest(request, { timeoutMs });
    }

    // Item 2: post-process (consumer closure owns S3/PII/etc.).
    result = await this.applyProcessor(resolved, args, result);

    // Item 4: uniform size guarantee AFTER processors (a processor can shrink
    // the result — truncating first would destroy its input).
    return this.maybeTruncate(resolved, result);
  }

  private async applyProcessor(
    tool: CompiledTool,
    args: Record<string, unknown>,
    result: ExecuteResult,
  ): Promise<ExecuteResult> {
    const processor = this.options.processors?.[tool.name];
    if (!processor) return result;
    try {
      const out = await processor(result, { tool, args });
      if (!isExecuteResult(out)) {
        // A wrong-shaped return is a bug in the processor — say so explicitly
        // instead of silently passing the original result through.
        return {
          status: "error",
          data: null,
          httpStatus: result.httpStatus,
          error: `Processor "${tool.name}" returned an invalid result (expected an ExecuteResult).`,
        };
      }
      return out;
    } catch (err) {
      // A throwing processor must not escape execute() — degrade explicitly.
      return {
        status: "error",
        data: null,
        httpStatus: result.httpStatus,
        error: `Processor "${tool.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  private maybeTruncate(tool: CompiledTool, result: ExecuteResult): ExecuteResult {
    const maxBytes = this.options.maxResponseBytes;
    if (maxBytes === undefined) return result;
    const size = JSON.stringify(result).length;
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
      message:
        `Response was ${size} bytes — exceeds the ${maxBytes}-byte limit. ` +
        `Request a narrower response (fewer fields / more specific parameters).`,
    };
  }

  /** The normalized operation behind a tool (params, requestBody, servers…).
   *  NOTE: internal model — its shape may change in minor versions. Persist or
   *  key on the stable tool fields (name/method/path/inputSchema/outputSchema/
   *  mediaUpload), not on operation internals. */
  operation(tool: string | CompiledTool): CompiledTool["operation"] {
    return this.resolveTool(tool).operation;
  }

  private sourceAsInput(): string | Record<string, unknown> {
    if ("url" in this.source) return this.source.url;
    if ("text" in this.source) return this.source.text;
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
  // never reads (e.g. processors/extraParameters at the top level instead of
  // inside options) would otherwise no-op forever with zero signal.
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
  const present = (["url", "text", "spec"] as const).filter((k) => k in source);
  if (present.length !== 1) {
    throw new TypeError(
      `MultiSpecParser: spec must be exactly one of {url}, {text}, {spec} — got ${JSON.stringify(source)}.`,
    );
  }
  // Runtime guards for JS consumers (TS already enforces these statically).
  if ("url" in source) {
    if (typeof source.url !== "string" || source.url.length === 0) {
      throw new TypeError("MultiSpecParser: spec.url must be a non-empty string.");
    }
  } else if ("text" in source) {
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
  const { maxDefsBytes, baseUrl, headers, executeTimeoutMs } = options;
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
  if (
    options.processors !== undefined &&
    (typeof options.processors !== "object" ||
      options.processors === null ||
      Array.isArray(options.processors) ||
      Object.values(options.processors).some((p) => typeof p !== "function"))
  ) {
    throw new TypeError(
      "MultiSpecParser: options.processors must be a map of toolName → function.",
    );
  }
  if (
    options.extraParameters !== undefined &&
    (typeof options.extraParameters !== "object" ||
      options.extraParameters === null ||
      Array.isArray(options.extraParameters))
  ) {
    throw new TypeError(
      "MultiSpecParser: options.extraParameters must be a map of toolName → array.",
    );
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
  positiveNumber(options.describeMaxBytes, "describeMaxBytes");
  if (options.onTruncate !== undefined && typeof options.onTruncate !== "function") {
    throw new TypeError("MultiSpecParser: options.onTruncate must be a function.");
  }
}

/** Shape guard for processor results — a wrong-shaped return degrades to the
 *  original result rather than corrupting the ExecuteResult contract. */
function isExecuteResult(value: unknown): value is ExecuteResult {
  if (typeof value !== "object" || value === null) return false;
  const status = (value as { status?: unknown }).status;
  return status === "success" || status === "error" || status === "truncated";
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
