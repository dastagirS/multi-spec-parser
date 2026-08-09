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
import { buildRequest as buildRequestFor, executeRequest } from "./request-builder.js";
import type { CompileResult, CompiledTool } from "./factory.js";
import type {
  BuiltRequest,
  ExecuteResult,
  RequestBuildOptions,
} from "./request-builder.js";
import type { ParsedSpec, SchemaObject, SpecFormat } from "./types.js";

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
}

export interface MultiSpecParserConfig {
  spec: SpecSource;
  options?: MultiSpecParserOptions;
}

const NOT_PARSED =
  "MultiSpecParser: call await parser.parse() before using tools/requests.";

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
   *  same way. */
  async execute(
    tool: string | CompiledTool,
    args: Record<string, unknown>,
    options: RequestBuildOptions = {},
  ): Promise<ExecuteResult> {
    const request = this.buildRequest(tool, args, options);
    return executeRequest(request, {
      ...(this.options.executeTimeoutMs !== undefined
        ? { timeoutMs: this.options.executeTimeoutMs }
        : {}),
    });
  }

  /** The normalized operation behind a tool (params, requestBody, servers…). */
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
}
