/** Standard Schema interoperability for parser-produced operations. */
import assert from "node:assert/strict";

import type { CompiledOperation } from "./operation-compiler.js";
import {
  createStandardSchemaAdapter,
  type StandardSchema,
} from "./standard-schema-adapter.js";

export type {
  StandardJSONSchemaV1,
  StandardJsonSchemaOptions,
  StandardJsonSchemaTarget,
  StandardSchema,
  StandardSchemaIssue,
  StandardSchemaLike,
  StandardSchemaOptions,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./standard-schema-adapter.js";

const wrappers = new WeakMap<CompiledOperation, StandardSchema>();

/** Adapt a parser-produced operation to Standard Schema interoperability. */
export function toStandardSchema(operation: CompiledOperation): StandardSchema {
  assert(operation !== null && typeof operation === "object", "compiled operation must be an object");
  assert(typeof operation.name === "string" && operation.name.length > 0, "compiled operation name must be non-empty");
  const cached = wrappers.get(operation);
  if (cached) return cached;
  const wrapper = createStandardSchemaAdapter(operation);
  wrappers.set(operation, wrapper);
  assert(wrappers.get(operation) === wrapper, "standard schema adapter must be cached");
  return wrapper;
}
