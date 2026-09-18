import assert from "node:assert/strict";

import type { CompiledOperation } from "./operation-compiler.js";
import { getCanonicalOperationSchema } from "./operation-schema.js";
import { collectReachableDefs } from "./schema-closure.js";
import type { SchemaObject } from "./types.js";

const DRAFT_07 = "draft-07" as const;
const DRAFT_2020_12 = "draft-2020-12" as const;
const MAX_SCHEMA_NODES = 1_000_000;
const DEFINITIONS_KEY = "definitions";
const DEFS_KEY = "$defs";
const DRAFT_07_SCHEMA_URI = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12_SCHEMA_URI = "https://json-schema.org/draft/2020-12/schema";

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

export type StandardSchema<T = unknown> = StandardSchemaLike<T> & {
  readonly validate: StandardSchemaV1<T>["~standard"]["validate"];
  readonly input: (target?: StandardJsonSchemaTarget) => Record<string, unknown>;
  readonly output: (target?: StandardJsonSchemaTarget) => Record<string, unknown>;
};

export function createStandardSchemaAdapter(operation: CompiledOperation): StandardSchema {
  assert(operation !== null && typeof operation === "object", "compiled operation must be an object");
  assert(operation.input !== null && typeof operation.input === "object", "compiled operation must contain input");
  let inputProjection: Record<string, unknown> | undefined;
  let outputProjection: Record<string, unknown> | undefined;
  const inputCanonical = getCanonicalOperationSchema(operation.input);
  const outputCanonical = operation.output ? getCanonicalOperationSchema(operation.output) : undefined;
  const validate: StandardSchemaV1["~standard"]["validate"] = async (value) => {
    const result = await operation.input.validate(value);
    if (result.status === "ok") return { value: result.value };
    if (result.error._tag === "ValidationFailed") {
      return { issues: result.error.issues.map((issue) => ({ message: issue.message, path: issue.path })) };
    }
    return { issues: [{ message: result.error.message }] };
  };
  const input = (target: StandardJsonSchemaTarget = DRAFT_2020_12) => {
    assert(typeof target === "string", "input schema target must be a string");
    assert(target.length > 0, "input schema target must be non-empty");
    return projectSchema(
      inputProjection ??= withReachableDefinitions(inputCanonical.root, inputCanonical.definitions),
      target,
    );
  };
  const output = (target: StandardJsonSchemaTarget = DRAFT_2020_12) => {
    assert(typeof target === "string", "output schema target must be a string");
    assert(target.length > 0, "output schema target must be non-empty");
    return projectSchema(
      outputProjection ??= outputCanonical
        ? withReachableDefinitions(outputCanonical.root, outputCanonical.definitions)
        : {},
      target,
    );
  };
  return {
    validate,
    input,
    output,
    "~standard": {
      version: 1,
      vendor: "multi-spec-parser",
      validate,
      jsonSchema: {
        input: (options) => input(options.target),
        output: (options) => output(options.target),
      },
    },
  };
}

function withReachableDefinitions(
  source: Record<string, unknown>,
  definitionsValue: unknown,
): Record<string, unknown> {
  assert(source !== null && typeof source === "object" && !Array.isArray(source), "schema must be an object");
  assert(definitionsValue === undefined || isRecord(definitionsValue), "schema $defs must be an object or undefined");
  const root = { ...source };
  delete root.$defs;
  if (isRecord(definitionsValue)) {
    const reachableDefinitions = collectReachableDefs(
      [root],
      definitionsValue as Record<string, SchemaObject>,
    );
    if (Object.keys(reachableDefinitions).length > 0) root.$defs = reachableDefinitions;
  }
  assert(!Object.prototype.hasOwnProperty.call(root, "$defs") || isRecord(root.$defs), "projected $defs must be an object");
  return root;
}

function projectSchema(
  source: Record<string, unknown>,
  target: StandardJsonSchemaTarget,
): Record<string, unknown> {
  assert(source !== null && typeof source === "object" && !Array.isArray(source), "schema must be an object");
  assert(typeof target === "string", "JSON Schema target must be a string");
  assertSupportedTarget(target);
  if (target === DRAFT_2020_12) return { ...source, $schema: DRAFT_2020_12_SCHEMA_URI };
  assertSchemaWithinLimit(source);
  const projected = structuredClone(source) as Record<string, unknown>;
  projected.$schema = DRAFT_07_SCHEMA_URI;
  return rewriteProjectedSchema(projected, target);
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
