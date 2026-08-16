/**
 * Standard Schema + Standard JSON Schema adapter for compiled tool inputs.
 *
 * The adapter keeps the tool's plain JSON Schema as the canonical source. It
 * adds an in-process validator and dialect-aware schema projections without
 * changing the MCP/Executor-facing inputSchema object.
 */
import assert from "node:assert/strict";
import { Ajv } from "ajv";
import type { ErrorObject } from "ajv";
import type { CompiledTool } from "./factory.js";
import {
  createStandardSchemaAdapter,
  type StandardSchemaIssue,
  type StandardSchemaLike,
} from "./standard-schema-adapter.js";

export type {
  StandardJSONSchemaV1,
  StandardJsonSchemaOptions,
  StandardJsonSchemaTarget,
  StandardSchemaIssue,
  StandardSchemaLike,
  StandardSchemaOptions,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./standard-schema-adapter.js";

const MAX_AJV_ERRORS = 1_000_000;
const MAX_INSTANCE_PATH_LENGTH = 16 * 1024;
const ajv = new Ajv({ strict: false, allErrors: true });
const wrappers = new WeakMap<CompiledTool, StandardSchemaLike>();

/** Wrap a compiled tool's input schema with synchronous validation and JSON
 *  Schema projections. Memoization avoids recompiling Ajv for the same tool. */
export function toStandardSchema(tool: CompiledTool): StandardSchemaLike {
  assert(tool !== null && typeof tool === "object", "compiled tool must be an object");
  assert(typeof tool.name === "string" && tool.name.length > 0, "compiled tool name must be non-empty");
  const cached = wrappers.get(tool);
  if (cached) return cached;
  const validate = ajv.compile(tool.inputSchema as object);
  const wrapper = createStandardSchemaAdapter(tool, (value) => {
    if (validate(value)) return { value };
    return { issues: toIssues(validate.errors) };
  });
  wrappers.set(tool, wrapper);
  return wrapper;
}

function toIssues(errors: ErrorObject[] | null | undefined): ReadonlyArray<StandardSchemaIssue> {
  assert(errors === null || errors === undefined || Array.isArray(errors), "Ajv errors must be an array or null");
  assert(errors === null || errors === undefined || errors.length <= MAX_AJV_ERRORS, `Ajv returned more than ${MAX_AJV_ERRORS} errors`);
  return (errors ?? [{ keyword: "validation", instancePath: "", schemaPath: "", params: {}, message: "invalid" }]).map((error) => ({
    message: error.message ?? "invalid",
    ...(error.instancePath ? { path: parseInstancePath(error.instancePath) } : {}),
  }));
}

function parseInstancePath(instancePath: string): ReadonlyArray<PropertyKey> {
  assert(typeof instancePath === "string", "Ajv instance path must be a string");
  assert(instancePath.length <= MAX_INSTANCE_PATH_LENGTH, `Ajv instance path exceeds ${MAX_INSTANCE_PATH_LENGTH} characters`);
  if (instancePath === "") return [];
  return instancePath
    .split("/")
    .slice(1)
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}
