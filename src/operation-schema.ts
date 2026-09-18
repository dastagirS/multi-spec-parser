import assert from "node:assert/strict";

import { renderSchemaType } from "./schema-type-renderer.js";
import {
  compileValidator,
  type ValidationError,
  type ValidationFailed,
  type ValidationIssue,
  type ValidationLimitExceeded,
  type ValidationResult,
  type UnsupportedValidationKeyword,
} from "./schema-validator.js";

export type {
  ValidationError,
  ValidationFailed,
  ValidationIssue,
  ValidationLimitExceeded,
  ValidationResult,
  UnsupportedValidationKeyword,
};

export interface OperationSchema {
  readonly type: string;
  readonly definitions: Readonly<Record<string, string>>;
  validate(value: unknown): Promise<ValidationResult>;
}

export interface CanonicalOperationSchema {
  readonly root: Record<string, unknown>;
  readonly definitions: Readonly<Record<string, Record<string, unknown>>>;
}

const canonicalSchemas = new WeakMap<OperationSchema, CanonicalOperationSchema>();

export function createOperationSchema(
  source: Record<string, unknown>,
  definitions: Readonly<Record<string, Record<string, unknown>>>,
): OperationSchema {
  assert(isRecord(source), "operation schema source must be an object");
  assert(isRecord(definitions), "operation schema definitions must be an object");
  const root = { ...source };
  delete root.$defs;
  const rendered = renderSchemaType(root, definitions);
  const getValidator = compileValidator(root, definitions);
  const schema: OperationSchema = {
    type: rendered.type,
    definitions: Object.freeze({ ...rendered.definitions }),
    async validate(value: unknown): Promise<ValidationResult> {
      assert(arguments.length === 1, "validate requires exactly one value");
      assert(typeof getValidator === "function", "validator factory must be a function");
      return getValidator()(value);
    },
  };
  canonicalSchemas.set(schema, { root, definitions });
  assert(canonicalSchemas.has(schema), "canonical operation schema must be registered");
  return Object.freeze(schema);
}

export function getCanonicalOperationSchema(schema: OperationSchema): CanonicalOperationSchema {
  assert(schema !== null && typeof schema === "object", "operation schema handle must be an object");
  assert(typeof schema.validate === "function", "operation schema handle must validate");
  const canonical = canonicalSchemas.get(schema);
  if (!canonical) throw new TypeError("Operation schema handle was not created by multi-spec-parser.");
  return canonical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
