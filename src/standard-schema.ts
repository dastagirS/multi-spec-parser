/**
 * Standard Schema + Standard JSON Schema adapter for compiled operation inputs.
 *
 * The adapter keeps the operation's plain JSON Schema as the canonical source. It
 * adds an in-process validator and dialect-aware schema projections without
 * changing the canonical operation inputSchema object.
 */
import assert from "node:assert/strict";
import addFormatsModule from "ajv-formats";
import { Ajv } from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import type { CompiledOperation } from "./operation-compiler.js";
import {
  cloneForDefaultApplication,
  createStandardSchemaAdapter,
  type DefaultPolicy,
  type StandardSchemaAdapterOptions,
  type StandardSchema,
  type StandardSchemaIssue,
} from "./standard-schema-adapter.js";
import { registerOpenApiFormats, resolveAjvFormatsPlugin } from "./openapi-formats.js";

export type {
  DefaultPolicy,
  StandardJSONSchemaV1,
  StandardJsonSchemaOptions,
  StandardJsonSchemaTarget,
  StandardSchemaAdapterOptions,
  StandardSchema,
  StandardSchemaIssue,
  StandardSchemaLike,
  StandardSchemaOptions,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./standard-schema-adapter.js";

const MAX_AJV_ERRORS = 1_000_000;
const MAX_INSTANCE_PATH_LENGTH = 16 * 1024;
const ajv = createAjv(false);
const defaultingAjv = createAjv(true);
const wrappers = new WeakMap<CompiledOperation, Map<DefaultPolicy, StandardSchema>>();
const validators = new WeakMap<CompiledOperation, Map<DefaultPolicy, ValidateFunction>>();

/** Wrap a compiled operation's input schema with synchronous validation and JSON
 *  Schema projections. Memoization avoids recompiling Ajv for the same operation. */
export function toStandardSchema(
  operation: CompiledOperation,
  options: StandardSchemaAdapterOptions = {},
): StandardSchema {
  assert(operation !== null && typeof operation === "object", "compiled operation must be an object");
  assert(typeof operation.name === "string" && operation.name.length > 0, "compiled operation name must be non-empty");
  assert(options !== null && typeof options === "object" && !Array.isArray(options), "standard schema options must be an object");
  const defaultPolicy = options.defaultPolicy ?? "preserve";
  assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
  let cachedWrappers = wrappers.get(operation);
  if (!cachedWrappers) {
    cachedWrappers = new Map();
    wrappers.set(operation, cachedWrappers);
  }
  const cached = cachedWrappers.get(defaultPolicy);
  if (cached) return cached;
  const validate = getValidator(operation, defaultPolicy);
  const wrapper = createStandardSchemaAdapter(operation, (value) => {
    try {
      const candidate = defaultPolicy === "apply" ? cloneForDefaultApplication(value) : value;
      if (validate(candidate)) return { value: candidate };
      return { issues: toIssues(validate.errors) };
    } catch (error: unknown) {
      return { issues: [{ message: error instanceof Error ? error.message : String(error) }] };
    }
  }, { defaultPolicy });
  cachedWrappers.set(defaultPolicy, wrapper);
  return wrapper;
}

function createAjv(useDefaults: boolean): Ajv {
  assert(typeof useDefaults === "boolean", "useDefaults must be a boolean");
  const instance = new Ajv({ strict: false, allErrors: true, ...(useDefaults ? { useDefaults: true } : {}) });
  resolveAjvFormatsPlugin(addFormatsModule)(instance);
  registerOpenApiFormats(instance);
  assert(instance !== null && typeof instance.addFormat === "function", "configured Ajv must support formats");
  return instance;
}

function getValidator(operation: CompiledOperation, defaultPolicy: DefaultPolicy): ValidateFunction {
  assert(operation !== null && typeof operation === "object", "compiled operation must be an object");
  assert(defaultPolicy === "preserve" || defaultPolicy === "apply", "defaultPolicy must be preserve or apply");
  let cachedValidators = validators.get(operation);
  if (!cachedValidators) {
    cachedValidators = new Map();
    validators.set(operation, cachedValidators);
  }
  const cached = cachedValidators.get(defaultPolicy);
  if (cached) return cached;
  const compiled = (defaultPolicy === "apply" ? defaultingAjv : ajv).compile(operation.inputSchema as object);
  cachedValidators.set(defaultPolicy, compiled);
  return compiled;
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
