import assert from "node:assert/strict";

import type { ValidateFunction } from "ajv";
import {
  compileSpecToOperations,
  type CompiledOperation,
  type OperationCompileResult,
} from "./operation-compiler.js";
import { registerOpenApiFormats, resolveAjvFormatsPlugin } from "./openapi-formats.js";
import {
  createLazySourceIndex,
  type LazyOperationIndex,
  type LazySourceIndex,
} from "./lazy-source-index.js";
import { parseSpec, parseSpecText } from "./parse-spec.js";
import {
  loadSpecUrl,
  loadSpecUrlToTemporaryFile,
  type TemporarySpecFile,
} from "./source-loader.js";
import {
  cloneForDefaultApplication,
  createStandardSchemaAdapter,
  type DefaultPolicy,
  type StandardSchema,
  type StandardSchemaAdapterOptions,
} from "./standard-schema-adapter.js";
import type { SpecFormat } from "./types.js";

const DEFAULT_COMPACT_MAX_BYTES = 64 * 1024;
const NOT_PARSED = "MultiSpecParser: call parser.parse() first.";
const UTF8_ENCODER = new TextEncoder();
const validators = new WeakMap<CompiledOperation, Map<DefaultPolicy, ValidateFunction>>();

export type SpecSource =
  | { url: string }
  | { text: string }
  | { spec: Record<string, unknown> };

export interface MultiSpecParserOptions {
  /** Use the shared definition map when one operation closure exceeds this budget. */
  maxDefsBytes?: number;
  /** Index a supported JSON or OpenAPI block-YAML URL source and materialize operations on demand. */
  lazy?: boolean;
}

export interface ParseOptions {
  /** Replace over-budget definition closures with their reachable reference names. */
  compact?: boolean;
  /** Serialized UTF-8 budget used when compact is true. */
  maxBytes?: number;
  /** Cancel URL loading. Parsing caller-owned text and objects is synchronous work. */
  signal?: AbortSignal;
}

export interface MultiSpecParserConfig {
  spec: SpecSource;
  options?: MultiSpecParserOptions;
}

export class MultiSpecParser {
  private readonly source: SpecSource;
  private readonly options: MultiSpecParserOptions;
  private compiled: OperationCompileResult | undefined;
  private loading: Promise<OperationCompileResult> | undefined;
  private lazyLoading: Promise<void> | undefined;
  private lazySource: LazySourceIndex | undefined;
  private lazyOperations: LazyOperationIndex | undefined;
  private temporarySource: TemporarySpecFile | undefined;
  private readonly materialized = new Map<string, Promise<CompiledOperation>>();
  private closed = false;
  private readonly standardSchemas = new WeakMap<
    CompiledOperation,
    Map<DefaultPolicy, StandardSchema>
  >();

  constructor(config: MultiSpecParserConfig) {
    validateConfig(config);
    this.source = config.spec;
    this.options = config.options ?? {};
  }

  /** Prepare the configured source. Lazy sources are indexed without parsing the complete document. */
  async load(options: Pick<ParseOptions, "signal"> = {}): Promise<void> {
    assert(options !== null && typeof options === "object" && !Array.isArray(options), "load options must be an object");
    assert(options.signal === undefined || options.signal instanceof AbortSignal, "signal must be an AbortSignal");
    this.requireOpen();
    if (!this.options.lazy) {
      await this.parse({ signal: options.signal });
      return;
    }
    if (this.lazySource) return;
    const pending = this.lazyLoading ??= this.loadLazy(options.signal);
    try {
      await pending;
    } finally {
      if (this.lazyLoading === pending) this.lazyLoading = undefined;
    }
  }

  /** Parse an eager source into operation-level JSON Schema projections. */
  async parse(options: ParseOptions = {}): Promise<CompiledOperation[]> {
    assert(options !== null && typeof options === "object" && !Array.isArray(options), "parse options must be an object");
    assert(options.compact === undefined || typeof options.compact === "boolean", "compact must be a boolean");
    assert(options.signal === undefined || options.signal instanceof AbortSignal, "signal must be an AbortSignal");
    this.requireOpen();
    if (this.options.lazy) {
      throw new Error("MultiSpecParser: parse() is unavailable in lazy mode; use load(), operationNames(), and operation().");
    }
    if (!this.compiled) {
      this.loading ??= this.compile(options.signal);
      try {
        this.compiled = await this.loading;
      } finally {
        this.loading = undefined;
      }
    }
    if (!options.compact) return [...this.compiled.operations];
    const maxBytes = options.maxBytes ?? DEFAULT_COMPACT_MAX_BYTES;
    assert(Number.isFinite(maxBytes) && maxBytes > 0, "maxBytes must be positive");
    assert(this.compiled.operations.length <= 1_000_000, "operation count exceeds the projection limit");
    return this.compiled.operations.map((operation) => ({
      ...operation,
      inputSchema: boundedSchema(operation.inputSchema, maxBytes),
      ...(operation.outputSchema
        ? { outputSchema: boundedSchema(operation.outputSchema, maxBytes) }
        : {}),
    }));
  }

  private async loadLazy(signal?: AbortSignal): Promise<void> {
    assert(signal === undefined || signal instanceof AbortSignal, "signal must be an AbortSignal");
    assert("url" in this.source, "lazy source must be a URL");
    const temporarySource = await loadSpecUrlToTemporaryFile(this.source.url, signal);
    let lazySource: LazySourceIndex | undefined;
    try {
      lazySource = await createLazySourceIndex(temporarySource.path, temporarySource.size);
      if (this.closed) throw new Error("MultiSpecParser: parser is closed.");
      const lazyOperations = lazySource.createOperationIndex();
      this.temporarySource = temporarySource;
      this.lazySource = lazySource;
      this.lazyOperations = lazyOperations;
      assert(lazyOperations.size > 0, "lazy source must contain operations");
    } catch (error: unknown) {
      await lazySource?.close();
      await temporarySource.cleanup();
      throw error;
    }
  }

  private async compile(signal?: AbortSignal): Promise<OperationCompileResult> {
    assert(signal === undefined || signal instanceof AbortSignal, "signal must be an AbortSignal");
    assert(this.source !== null && typeof this.source === "object", "source must be configured");
    let document: Record<string, unknown>;
    if ("url" in this.source) {
      document = parseSpecText(await loadSpecUrl(this.source.url, signal));
    } else if ("text" in this.source) {
      document = parseSpecText(this.source.text);
    } else {
      document = this.source.spec;
    }
    const parsed = parseSpec(document);
    const compiled = compileSpecToOperations(parsed, {
      maxDefsBytes: this.options.maxDefsBytes,
    });
    assert(compiled.operations.length === parsed.operations.length, "every parsed operation must be projected");
    assert(compiled.specFormat === parsed.specFormat, "compiled format must match parsed format");
    return compiled;
  }

  /** Detected source format. */
  get format(): SpecFormat {
    this.requireOpen();
    return this.options.lazy ? this.requireLazySource().specFormat : this.requireCompiled().specFormat;
  }

  /** First server URL declared by the source, or an empty string. */
  get baseUrl(): string {
    this.requireOpen();
    return this.options.lazy ? this.requireLazySource().baseUrl : this.requireCompiled().baseUrl ?? "";
  }

  /** Return operation names in deterministic source order. */
  operationNames(): string[] {
    this.requireOpen();
    if (this.options.lazy) return this.requireLazyOperations().names();
    return this.requireCompiled().operations.map((operation) => operation.name);
  }

  /** Materialize one operation by its generated unique name. */
  async operation(name: string): Promise<CompiledOperation | undefined> {
    assert(typeof name === "string", "operation name must be a string");
    assert(name.length > 0, "operation name must be non-empty");
    this.requireOpen();
    if (!this.options.lazy) {
      return this.requireCompiled().operations.find((operation) => operation.name === name);
    }
    const locator = this.requireLazyOperations().get(name);
    if (!locator) return undefined;
    let pending = this.materialized.get(name);
    if (!pending) {
      pending = this.materializeOperation(name);
      this.materialized.set(name, pending);
    }
    try {
      return await pending;
    } catch (error: unknown) {
      if (this.materialized.get(name) === pending) this.materialized.delete(name);
      throw error;
    }
  }

  /** Close the parser and remove any temporary lazy source. */
  async close(): Promise<void> {
    assert(typeof this.closed === "boolean", "closed state must be boolean");
    assert(this.materialized instanceof Map, "materialized operation cache must be a map");
    if (this.closed) return;
    this.closed = true;
    if (this.lazyLoading) {
      try {
        await this.lazyLoading;
      } catch {
        return;
      }
    }
    try {
      await this.lazySource?.close();
    } finally {
      await this.temporarySource?.cleanup();
    }
  }

  /** Adapt an operation input/output pair to Standard Schema. */
  toStandardSchema(
    operation: string | CompiledOperation,
    options: StandardSchemaAdapterOptions = {},
  ): StandardSchema {
    assert(options !== null && typeof options === "object" && !Array.isArray(options), "adapter options must be an object");
    const defaultPolicy = options.defaultPolicy ?? "preserve";
    assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
    const resolved = this.resolveOperation(operation);
    let cached = this.standardSchemas.get(resolved);
    if (!cached) {
      cached = new Map();
      this.standardSchemas.set(resolved, cached);
    }
    const existing = cached.get(defaultPolicy);
    if (existing) return existing;
    const adapter = createStandardSchemaAdapter(
      resolved,
      async (value) => {
        const validate = await getValidator(resolved, defaultPolicy);
        const candidate = defaultPolicy === "apply"
          ? cloneForDefaultApplication(value)
          : value;
        if (validate(candidate)) return { value: candidate };
        return {
          issues: validate.errors?.map((error) => ({
            message: error.message ?? "invalid",
          })) ?? [],
        };
      },
      options,
    );
    cached.set(defaultPolicy, adapter);
    return adapter;
  }

  private async materializeOperation(name: string): Promise<CompiledOperation> {
    assert(typeof name === "string" && name.length > 0, "operation name must be non-empty");
    assert(this.options.lazy === true, "operation materialization requires lazy mode");
    const locator = this.requireLazyOperations().get(name);
    if (!locator) throw new Error(`MultiSpecParser: unknown operation "${name}".`);
    const parsed = parseSpec(await this.requireLazySource().materialize(locator));
    const compiled = compileSpecToOperations(parsed, { maxDefsBytes: this.options.maxDefsBytes });
    const operation = compiled.operations.find((candidate) => candidate.operationKey === locator.operationKey);
    if (!operation) throw new Error(`MultiSpecParser: operation "${name}" could not be materialized.`);
    assert(compiled.specFormat === this.requireLazySource().specFormat, "materialized format must match indexed format");
    return operation.name === name ? operation : { ...operation, name };
  }

  private requireOpen(): void {
    assert(typeof this.closed === "boolean", "closed state must be boolean");
    assert(this.source !== null && typeof this.source === "object", "source must be configured");
    if (this.closed) throw new Error("MultiSpecParser: parser is closed.");
  }

  private requireLazySource(): LazySourceIndex {
    assert(this.options.lazy === true, "lazy source requires lazy mode");
    assert(this.compiled === undefined, "lazy mode must not compile the complete source");
    if (!this.lazySource) throw new Error("MultiSpecParser: call parser.load() first.");
    return this.lazySource;
  }

  private requireLazyOperations(): LazyOperationIndex {
    assert(this.options.lazy === true, "lazy operation index requires lazy mode");
    assert(this.compiled === undefined, "lazy mode must not compile the complete source");
    if (!this.lazyOperations) throw new Error("MultiSpecParser: call parser.load() first.");
    return this.lazyOperations;
  }

  private requireCompiled(): OperationCompileResult {
    assert(this.source !== null && typeof this.source === "object", "source must be configured");
    assert(this.options !== null && typeof this.options === "object", "options must be configured");
    if (!this.compiled) throw new Error(NOT_PARSED);
    return this.compiled;
  }

  private resolveOperation(operation: string | CompiledOperation): CompiledOperation {
    assert(typeof operation === "string" || (operation !== null && typeof operation === "object"), "operation must be a name or projection");
    assert(typeof operation !== "string" || operation.length > 0, "operation name must be non-empty");
    if (typeof operation !== "string") return operation;
    if (this.options.lazy) {
      throw new Error("MultiSpecParser: pass a materialized operation to toStandardSchema() in lazy mode.");
    }
    const resolved = this.requireCompiled().operations.find((candidate) => candidate.name === operation);
    if (!resolved) throw new Error(`MultiSpecParser: unknown operation "${operation}".`);
    return resolved;
  }
}

async function getValidator(
  operation: CompiledOperation,
  defaultPolicy: DefaultPolicy,
): Promise<ValidateFunction> {
  assert(operation !== null && typeof operation === "object", "operation must be an object");
  assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
  let cached = validators.get(operation);
  if (!cached) {
    cached = new Map();
    validators.set(operation, cached);
  }
  const existing = cached.get(defaultPolicy);
  if (existing) return existing;
  const [{ Ajv }, formatsModule] = await Promise.all([
    import("ajv"),
    import("ajv-formats"),
  ]);
  const instance = new Ajv({
    strict: false,
    allErrors: true,
    ...(defaultPolicy === "apply" ? { useDefaults: true } : {}),
  });
  resolveAjvFormatsPlugin(formatsModule)(instance);
  registerOpenApiFormats(instance);
  const validate = instance.compile(operation.inputSchema as object);
  cached.set(defaultPolicy, validate);
  assert(typeof validate === "function", "Ajv must return a validator");
  assert(cached.get(defaultPolicy) === validate, "validator must be cached");
  return validate;
}

function boundedSchema(
  schema: Record<string, unknown>,
  maxBytes: number,
): Record<string, unknown> {
  assert(schema !== null && typeof schema === "object" && !Array.isArray(schema), "schema must be an object");
  assert(Number.isFinite(maxBytes) && maxBytes > 0, "maxBytes must be positive");
  if (UTF8_ENCODER.encode(JSON.stringify(schema)).byteLength <= maxBytes) return schema;
  const { $defs, ...rest } = schema;
  return {
    ...rest,
    ...($defs && typeof $defs === "object" ? { $refs: Object.keys($defs) } : {}),
  };
}

function validateConfig(config: MultiSpecParserConfig): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new TypeError("MultiSpecParser: config object required.");
  }
  const configKeys = Object.keys(config);
  if (configKeys.some((key) => key !== "spec" && key !== "options")) {
    throw new TypeError("MultiSpecParser: config takes only { spec, options }.");
  }
  const source = config.spec;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    throw new TypeError("MultiSpecParser: spec source required.");
  }
  const sourceKeys = ["url", "text", "spec"].filter((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (sourceKeys.length !== 1) {
    throw new TypeError("MultiSpecParser: spec must be exactly one of { url }, { text }, or { spec }.");
  }
  if ("url" in source && (typeof source.url !== "string" || source.url.length === 0)) {
    throw new TypeError("MultiSpecParser: spec.url must be a non-empty string.");
  }
  if ("text" in source && (typeof source.text !== "string" || source.text.length === 0)) {
    throw new TypeError("MultiSpecParser: spec.text must be a non-empty string.");
  }
  if ("spec" in source && (typeof source.spec !== "object" || source.spec === null || Array.isArray(source.spec))) {
    throw new TypeError("MultiSpecParser: spec.spec must be a plain object.");
  }
  validateOptions(config.options);
  if (config.options?.lazy === true && !("url" in source)) {
    throw new TypeError("MultiSpecParser: options.lazy supports only { url } sources.");
  }
  assert(sourceKeys.length === 1, "exactly one source key must remain after validation");
  assert(configKeys.length >= 1 && configKeys.length <= 2, "config key count must be bounded");
}

function validateOptions(options: MultiSpecParserOptions | undefined): void {
  assert(options === undefined || options !== null, "options must not be null");
  assert(options === undefined || typeof options !== "function", "options must not be a function");
  if (options === undefined) return;
  if (typeof options !== "object" || Array.isArray(options)) {
    throw new TypeError("MultiSpecParser: options must be an object.");
  }
  for (const key of Object.keys(options)) {
    if (key !== "maxDefsBytes" && key !== "lazy") {
      throw new TypeError(`MultiSpecParser: unknown option "${key}".`);
    }
  }
  if (options.lazy !== undefined && typeof options.lazy !== "boolean") {
    throw new TypeError("MultiSpecParser: options.lazy must be a boolean.");
  }
  if (options.maxDefsBytes !== undefined &&
      (!Number.isFinite(options.maxDefsBytes) || options.maxDefsBytes <= 0)) {
    throw new TypeError("MultiSpecParser: options.maxDefsBytes must be positive.");
  }
}
