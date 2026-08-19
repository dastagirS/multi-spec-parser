import assert from "node:assert/strict";

import type { CompiledTool } from "./factory.js";

const DRAFT_07 = "draft-07" as const;
const DRAFT_2020_12 = "draft-2020-12" as const;
const MAX_SCHEMA_NODES = 1_000_000;
const DEFINITIONS_KEY = "definitions";
const DEFS_KEY = "$defs";
const DRAFT_07_SCHEMA_URI = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";

export type DefaultPolicy = "preserve" | "apply";

export type StandardJsonSchemaTarget =
  | typeof DRAFT_07
  | typeof DRAFT_2020_12
  | ({} & string);

export interface StandardJsonSchemaOptions {
  readonly target: StandardJsonSchemaTarget;
  readonly libraryOptions?: Record<string, unknown>;
}

export interface StandardSchemaIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey>;
}

export type StandardSchemaResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardSchemaIssue> };

export interface StandardSchemaOptions {
  readonly libraryOptions?: Record<string, unknown>;
}

export interface StandardSchemaAdapterOptions {
  readonly defaultPolicy?: DefaultPolicy;
}

export function cloneForDefaultApplication<T>(value: T): T {
  assert(typeof value !== "function", "default input must not be a function");
  assert(typeof value !== "symbol", "default input must not be a symbol");
  return structuredClone(value);
}

export interface StandardSchemaV1<T = unknown> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "multi-spec-parser";
    readonly validate: (
      value: unknown,
      options?: StandardSchemaOptions,
    ) => StandardSchemaResult<T> | Promise<StandardSchemaResult<T>>;
  };
}

export interface StandardJSONSchemaV1<Input = unknown, Output = Input> {
  readonly "~standard": {
    readonly version: 1;
    readonly vendor: "multi-spec-parser";
    readonly jsonSchema: {
      readonly input: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
      readonly output: (options: StandardJsonSchemaOptions) => Record<string, unknown>;
    };
  };
}

export type StandardSchemaLike<T = unknown> =
  StandardSchemaV1<T> & StandardJSONSchemaV1<T, T>;

type StandardSchemaValidator = (
  value: unknown,
  options?: StandardSchemaOptions,
) => StandardSchemaResult<unknown> | Promise<StandardSchemaResult<unknown>>;

export function createStandardSchemaAdapter(
  tool: CompiledTool,
  validate: StandardSchemaValidator,
  options: StandardSchemaAdapterOptions = {},
): StandardSchemaLike {
  assert(tool !== null && typeof tool === "object", "compiled tool must be an object");
  assert(typeof validate === "function", "standard schema validator must be a function");
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "standard schema options must be an object");
  const defaultPolicy = options.defaultPolicy ?? "preserve";
  assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
  return {
    "~standard": {
      version: 1,
      vendor: "multi-spec-parser",
      validate,
      jsonSchema: {
        input: (options) => projectSchema(tool.inputSchema, options.target, defaultPolicy),
        output: (options) => projectSchema(tool.outputSchema ?? {}, options.target, "preserve"),
      },
    },
  };
}

function projectSchema(
  source: Record<string, unknown>,
  target: StandardJsonSchemaTarget,
  defaultPolicy: DefaultPolicy,
): Record<string, unknown> {
  assert(source !== null && typeof source === "object" && !Array.isArray(source), "schema must be an object");
  assert(typeof target === "string", "JSON Schema target must be a string");
  assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
  assertSupportedTarget(target);
  if (defaultPolicy === "apply") {
    const projected = optionalizeDefaultedRequired(source);
    projected.$schema = target === DRAFT_07 ? DRAFT_07_SCHEMA_URI : DRAFT_2020_12_SCHEMA_URI;
    if (target === DRAFT_2020_12) return projected;
    return rewriteProjectedSchema(projected, target);
  }
  // The internal schema already uses 2020-12-compatible $defs; a shallow
  // copy avoids duplicating large shared closures just to add the dialect URI.
  if (target === DRAFT_2020_12) return { ...source, $schema: DRAFT_2020_12_SCHEMA_URI };
  assertSchemaWithinLimit(source);
  const projected = structuredClone(source) as Record<string, unknown>;
  projected.$schema = target === DRAFT_07 ? DRAFT_07_SCHEMA_URI : DRAFT_2020_12_SCHEMA_URI;
  return rewriteProjectedSchema(projected, target);
}

function optionalizeDefaultedRequired(source: Record<string, unknown>): Record<string, unknown> {
  assert(source !== null && typeof source === "object" && !Array.isArray(source), "schema must be an object");
  assertSchemaWithinLimit(source);
  const projected = structuredClone(source) as Record<string, unknown>;
  walkSchema(projected, (current) => {
    const required = current.required;
    const properties = current.properties;
    if (!Array.isArray(required) || !isRecord(properties)) return;
    const remaining = required.filter((name): boolean => {
      const property =
        typeof name === "string" && Object.prototype.hasOwnProperty.call(properties, name)
          ? properties[name]
          : undefined;
      return !(isRecord(property) && Object.prototype.hasOwnProperty.call(property, "default"));
    });
    if (remaining.length === 0) delete current.required;
    else if (remaining.length !== required.length) current.required = remaining;
  });
  return projected;
}

function rewriteProjectedSchema(
  projected: Record<string, unknown>,
  target: StandardJsonSchemaTarget,
): Record<string, unknown> {
  assert(projected !== null && typeof projected === "object" && !Array.isArray(projected), "projected schema must be an object");
  assert(target === DRAFT_07, "only draft-07 projections require rewriting");
  walkSchema(projected, (current) => {
    rewriteDefinitions(current, target);
    rewriteReference(current, target);
  });
  return projected;
}

function assertSchemaWithinLimit(source: Record<string, unknown>): void {
  assert(source !== null && typeof source === "object" && !Array.isArray(source), "schema must be an object");
  assert(MAX_SCHEMA_NODES > 0, "schema node limit must be positive");
  walkSchema(source, () => undefined);
}

function walkSchema(
  source: Record<string, unknown>,
  visit: (current: Record<string, unknown>) => void,
): void {
  assert(source !== null && typeof source === "object" && !Array.isArray(source), "schema must be an object");
  assert(typeof visit === "function", "schema visitor must be a function");
  const pending: unknown[] = [source];
  let processed = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    assert(current !== undefined, "schema traversal entry must exist");
    assert(processed < MAX_SCHEMA_NODES, `schema exceeds ${MAX_SCHEMA_NODES} nodes`);
    processed += 1;
    if (isRecord(current)) visit(current);
    if (isRecord(current) || Array.isArray(current)) {
      for (const value of Object.values(current)) {
        assert(pending.length < MAX_SCHEMA_NODES, `schema exceeds ${MAX_SCHEMA_NODES} pending nodes`);
        pending.push(value);
      }
    }
  }
}

function assertSupportedTarget(target: string): asserts target is StandardJsonSchemaTarget {
  assert(target === DRAFT_07 || target === DRAFT_2020_12, `unsupported JSON Schema target: ${target}`);
  assert(target.length > 0, "JSON Schema target must be non-empty");
}

function rewriteDefinitions(schema: Record<string, unknown>, target: StandardJsonSchemaTarget): void {
  assert(schema !== null && typeof schema === "object", "schema node must be an object");
  assert(typeof target === "string", "JSON Schema target must be a string");
  if (target !== DRAFT_07 || !Object.prototype.hasOwnProperty.call(schema, DEFS_KEY)) return;
  assert(!Object.prototype.hasOwnProperty.call(schema, DEFINITIONS_KEY), "schema cannot contain both $defs and definitions");
  schema[DEFINITIONS_KEY] = schema[DEFS_KEY];
  delete schema[DEFS_KEY];
}

function rewriteReference(schema: Record<string, unknown>, target: StandardJsonSchemaTarget): void {
  assert(schema !== null && typeof schema === "object", "schema node must be an object");
  assert(typeof target === "string", "JSON Schema target must be a string");
  if (target !== DRAFT_07 || typeof schema.$ref !== "string") return;
  if (schema.$ref.startsWith("#/$defs/")) schema.$ref = `#/definitions/${schema.$ref.slice("#/$defs/".length)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  assert(typeof value !== "function", "schema value must not be a function");
  assert(typeof value !== "symbol", "schema value must not be a symbol");
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
