import assert from "node:assert/strict";
import { isIP } from "node:net";
import { isDeepStrictEqual } from "node:util";

const VALIDATION_WORK_MAX = 1_000_000;
const VALIDATION_DEPTH_MAX = 512;
const VALIDATION_BRANCH_MAX = 10_000;
const VALIDATION_ISSUE_MAX = 1_000;
const VALIDATION_COLLECTION_MAX = 100_000;
const VALIDATION_PATTERN_LENGTH_MAX = 64 * 1024;
const VALIDATION_REFERENCE_LENGTH_MAX = 16 * 1024 * 1024;
const VALIDATION_UNIQUE_COMPARISON_MAX = 1_000_000;

export interface ValidationIssue {
  readonly message: string;
  readonly path: ReadonlyArray<string | number>;
  readonly keyword: string;
}

export interface ValidationFailed {
  readonly _tag: "ValidationFailed";
  readonly issues: ReadonlyArray<ValidationIssue>;
}

export interface UnsupportedValidationKeyword {
  readonly _tag: "UnsupportedValidationKeyword";
  readonly keyword: string;
  readonly schemaPath: ReadonlyArray<string | number>;
  readonly message: string;
}

export interface ValidationLimitExceeded {
  readonly _tag: "ValidationLimitExceeded";
  readonly limit: string;
  readonly maximum: number;
  readonly message: string;
}

export type ValidationError =
  | ValidationFailed
  | UnsupportedValidationKeyword
  | ValidationLimitExceeded;

export type ValidationResult =
  | { readonly status: "ok"; readonly value: unknown }
  | { readonly status: "error"; readonly error: ValidationError };

interface ValidationPlan {
  readonly root: Record<string, unknown>;
  readonly definitions: Readonly<Record<string, Record<string, unknown>>>;
  readonly patterns: WeakMap<Record<string, unknown>, RegExp>;
  readonly propertyPatterns: WeakMap<Record<string, unknown>, ReadonlyArray<[RegExp, Record<string, unknown>]>>;
}

interface EvaluationTask {
  readonly kind: "evaluate";
  readonly schema: Record<string, unknown>;
  readonly value: unknown;
  readonly path: ReadonlyArray<string | number>;
  readonly depth: number;
  readonly issues: ValidationIssue[];
  readonly lineage: ReadonlyArray<{ schema: Record<string, unknown>; value: unknown }>;
}

interface BranchFinishTask {
  readonly kind: "finish-branch";
  readonly keyword: "anyOf" | "oneOf" | "not" | "if" | "contains";
  readonly path: ReadonlyArray<string | number>;
  readonly issues: ValidationIssue[];
  readonly branches: ReadonlyArray<ValidationIssue[]>;
  readonly thenSchema?: Record<string, unknown>;
  readonly elseSchema?: Record<string, unknown>;
  readonly value?: unknown;
  readonly depth: number;
  readonly lineage: EvaluationTask["lineage"];
  readonly matchCountMin?: number;
  readonly matchCountMax?: number;
}

type ValidationTask = EvaluationTask | BranchFinishTask;

const ALLOWED_KEYWORDS = new Set([
  "$ref", "$defs", "$schema", "$id", "$anchor", "$comment",
  "type", "enum", "const", "multipleOf", "maximum", "exclusiveMaximum",
  "minimum", "exclusiveMinimum", "maxLength", "minLength", "pattern", "format",
  "maxItems", "minItems", "uniqueItems", "maxContains", "minContains", "contains",
  "maxProperties", "minProperties", "required", "properties", "patternProperties",
  "additionalProperties", "propertyNames", "allOf", "anyOf", "oneOf", "not",
  "if", "then", "else", "items", "prefixItems", "additionalItems", "nullable",
  "title", "description", "default", "deprecated", "readOnly", "writeOnly",
  "examples", "example", "externalDocs", "xml", "discriminator",
  "contentEncoding", "contentMediaType",
]);

const SUPPORTED_FORMATS = new Set([
  "date", "time", "date-time", "duration", "email", "hostname", "ipv4", "ipv6",
  "uri", "uri-reference", "uuid", "byte", "binary", "int32", "int64", "uint32",
  "uint64", "float", "double", "password", "google-datetime", "google-fieldmask",
  "YYYY-MM", "unix-time", "currency", "decimal", "repo.nwo", "url", "uri-template",
]);

export function compileValidator(
  root: Record<string, unknown>,
  definitions: Readonly<Record<string, Record<string, unknown>>>,
): () => (value: unknown) => ValidationResult {
  assert(isRecord(root), "validation root must be an object");
  assert(isRecord(definitions), "validation definitions must be an object");
  let validator: ((value: unknown) => ValidationResult) | undefined;
  return () => {
    assert(validator === undefined || typeof validator === "function", "validator cache must contain a function");
    assert(isRecord(root), "validation root must remain an object");
    if (validator) return validator;
    const compiled = compilePlan(root, definitions);
    if ("_tag" in compiled) {
      validator = () => ({ status: "error", error: compiled });
    } else {
      validator = (value) => evaluate(compiled, value);
    }
    return validator;
  };
}

function compilePlan(
  root: Record<string, unknown>,
  definitions: Readonly<Record<string, Record<string, unknown>>>,
): ValidationPlan | UnsupportedValidationKeyword | ValidationLimitExceeded {
  assert(isRecord(root), "validation root must be an object");
  assert(isRecord(definitions), "validation definitions must be an object");
  const patterns = new WeakMap<Record<string, unknown>, RegExp>();
  const propertyPatterns = new WeakMap<Record<string, unknown>, ReadonlyArray<[RegExp, Record<string, unknown>]>>();
  const pending: Array<{ schema: Record<string, unknown>; path: ReadonlyArray<string | number>; depth: number }> = [
    { schema: root, path: [], depth: 0 },
  ];
  for (const [name, schema] of Object.entries(definitions)) {
    if (!isRecord(schema)) return unsupported("$defs", ["$defs", name], "Definition must be an object schema.");
    pending.push({ schema, path: ["$defs", name], depth: 0 });
  }
  const visited = new WeakSet<object>();
  let workCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current.schema)) continue;
    visited.add(current.schema);
    workCount += 1;
    if (workCount > VALIDATION_WORK_MAX) return limitExceeded("schemaNodes", VALIDATION_WORK_MAX);
    if (current.depth > VALIDATION_DEPTH_MAX) return limitExceeded("schemaDepth", VALIDATION_DEPTH_MAX);
    for (const key of Object.keys(current.schema)) {
      if (!ALLOWED_KEYWORDS.has(key) && !key.startsWith("x-")) {
        return unsupported(key, [...current.path, key], `Unsupported validation keyword: ${key}`);
      }
    }
    const shapeError = validateKeywordShapes(current.schema, current.path);
    if (shapeError) return shapeError;
    if (typeof current.schema.format === "string" && !SUPPORTED_FORMATS.has(current.schema.format)) {
      return unsupported("format", [...current.path, "format"], `Unsupported string format: ${current.schema.format}`);
    }
    if (typeof current.schema.pattern === "string") {
      if (current.schema.pattern.length > VALIDATION_PATTERN_LENGTH_MAX) return limitExceeded("patternLength", VALIDATION_PATTERN_LENGTH_MAX);
      try {
        patterns.set(current.schema, new RegExp(current.schema.pattern, "u"));
      } catch {
        return unsupported("pattern", [...current.path, "pattern"], "Schema pattern is not a valid regular expression.");
      }
    }
    if (isRecord(current.schema.patternProperties)) {
      const compiled: Array<[RegExp, Record<string, unknown>]> = [];
      for (const [source, child] of Object.entries(current.schema.patternProperties)) {
        if (source.length > VALIDATION_PATTERN_LENGTH_MAX) return limitExceeded("patternLength", VALIDATION_PATTERN_LENGTH_MAX);
        try {
          compiled.push([new RegExp(source, "u"), child as Record<string, unknown>]);
        } catch {
          return unsupported("patternProperties", [...current.path, "patternProperties", source], "Property pattern is not a valid regular expression.");
        }
      }
      propertyPatterns.set(current.schema, compiled);
    }
    const childError = enqueueChildSchemas(current, pending);
    if (childError) return childError;
  }
  return { root, definitions, patterns, propertyPatterns };
}

function validateKeywordShapes(
  schema: Record<string, unknown>,
  path: ReadonlyArray<string | number>,
): UnsupportedValidationKeyword | undefined {
  assert(isRecord(schema), "keyword schema must be an object");
  assert(Array.isArray(path), "keyword schema path must be an array");
  const stringKeywords = ["$ref", "$schema", "$id", "$anchor", "type", "pattern", "format", "contentEncoding", "contentMediaType"];
  for (const keyword of stringKeywords) {
    const value = schema[keyword];
    if (value !== undefined && typeof value !== "string" && !(keyword === "type" && Array.isArray(value))) {
      return unsupported(keyword, [...path, keyword], `${keyword} must be a string.`);
    }
  }
  if (Array.isArray(schema.type) && (!schema.type.every((value) => typeof value === "string") || schema.type.length === 0)) {
    return unsupported("type", [...path, "type"], "type must be a non-empty string array.");
  }
  const declaredTypes = Array.isArray(schema.type) ? schema.type : schema.type === undefined ? [] : [schema.type];
  if (declaredTypes.some((value) => !["null", "boolean", "object", "array", "number", "integer", "string"].includes(value as string))) {
    return unsupported("type", [...path, "type"], "type contains an unsupported JSON Schema type.");
  }
  for (const keyword of ["multipleOf", "maximum", "minimum"]) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      return unsupported(keyword, [...path, keyword], `${keyword} must be a finite number.`);
    }
  }
  for (const keyword of ["maxLength", "minLength", "maxItems", "minItems", "maxContains", "minContains", "maxProperties", "minProperties"]) {
    const value = schema[keyword];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
      return unsupported(keyword, [...path, keyword], `${keyword} must be a non-negative finite number.`);
    }
  }
  if (typeof schema.multipleOf === "number" && schema.multipleOf <= 0) {
    return unsupported("multipleOf", [...path, "multipleOf"], "multipleOf must be greater than zero.");
  }
  for (const keyword of ["exclusiveMinimum", "exclusiveMaximum"]) {
    const value = schema[keyword];
    if (value !== undefined && typeof value !== "number" && typeof value !== "boolean") {
      return unsupported(keyword, [...path, keyword], `${keyword} must be a number or boolean.`);
    }
  }
  for (const keyword of ["maxLength", "minLength", "maxItems", "minItems", "maxContains", "minContains", "maxProperties", "minProperties"]) {
    const value = schema[keyword];
    if (typeof value === "number" && !Number.isInteger(value)) return unsupported(keyword, [...path, keyword], `${keyword} must be an integer.`);
  }
  if (schema.enum !== undefined && (!Array.isArray(schema.enum) || schema.enum.length === 0)) {
    return unsupported("enum", [...path, "enum"], "enum must be a non-empty array.");
  }
  if (schema.required !== undefined && (!Array.isArray(schema.required) || !schema.required.every((value) => typeof value === "string"))) {
    return unsupported("required", [...path, "required"], "required must be a string array.");
  }
  for (const keyword of ["uniqueItems", "nullable", "readOnly", "writeOnly", "deprecated"]) {
    if (schema[keyword] !== undefined && typeof schema[keyword] !== "boolean") {
      return unsupported(keyword, [...path, keyword], `${keyword} must be a boolean.`);
    }
  }
  return undefined;
}

function enqueueChildSchemas(
  current: { schema: Record<string, unknown>; path: ReadonlyArray<string | number>; depth: number },
  pending: Array<{ schema: Record<string, unknown>; path: ReadonlyArray<string | number>; depth: number }>,
): UnsupportedValidationKeyword | undefined {
  assert(isRecord(current.schema), "schema traversal node must be an object");
  assert(Array.isArray(pending), "schema traversal queue must be an array");
  const singular = ["additionalProperties", "propertyNames", "contains", "not", "if", "then", "else", "additionalItems"];
  for (const key of singular) {
    const child = current.schema[key];
    if (child === undefined || typeof child === "boolean") continue;
    if (!isRecord(child)) return unsupported(key, [...current.path, key], `${key} must be a schema.`);
    pending.push({ schema: child, path: [...current.path, key], depth: current.depth + 1 });
  }
  if (current.schema.items !== undefined && typeof current.schema.items !== "boolean") {
    const items = Array.isArray(current.schema.items) ? current.schema.items : [current.schema.items];
    for (let index = 0; index < items.length; index += 1) {
      if (!isRecord(items[index])) return unsupported("items", [...current.path, "items", index], "items entries must be object schemas.");
      pending.push({ schema: items[index], path: [...current.path, "items", index], depth: current.depth + 1 });
    }
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
    const children = current.schema[key];
    if (children === undefined) continue;
    if (!Array.isArray(children)) return unsupported(key, [...current.path, key], `${key} must be an array of schemas.`);
    for (let index = 0; index < children.length; index += 1) {
      if (!isRecord(children[index])) return unsupported(key, [...current.path, key, index], `${key} entries must be object schemas.`);
      pending.push({ schema: children[index], path: [...current.path, key, index], depth: current.depth + 1 });
    }
  }
  for (const key of ["properties", "patternProperties", "$defs"]) {
    const children = current.schema[key];
    if (children === undefined) continue;
    if (!isRecord(children)) return unsupported(key, [...current.path, key], `${key} must be an object of schemas.`);
    for (const [name, child] of Object.entries(children)) {
      if (!isRecord(child)) return unsupported(key, [...current.path, key, name], `${key} entries must be object schemas.`);
      pending.push({ schema: child, path: [...current.path, key, name], depth: current.depth + 1 });
    }
  }
  return undefined;
}

function evaluate(plan: ValidationPlan, value: unknown): ValidationResult {
  assert(isRecord(plan.root), "validation plan root must be an object");
  assert(isRecord(plan.definitions), "validation plan definitions must be an object");
  const issues: ValidationIssue[] = [];
  const tasks: ValidationTask[] = [{
    kind: "evaluate",
    schema: plan.root,
    value,
    path: [],
    depth: 0,
    issues,
    lineage: [],
  }];
  let workCount = 0;
  let branchCount = 0;
  while (tasks.length > 0) {
    workCount += 1;
    if (workCount > VALIDATION_WORK_MAX) return { status: "error", error: limitExceeded("validationWork", VALIDATION_WORK_MAX) };
    const task = tasks.pop()!;
    if (task.kind === "finish-branch") {
      const branchError = finishBranch(task, tasks);
      if (branchError) return { status: "error", error: branchError };
      continue;
    }
    if (task.depth > VALIDATION_DEPTH_MAX) return { status: "error", error: limitExceeded("validationDepth", VALIDATION_DEPTH_MAX) };
    if (task.lineage.some((entry) => entry.schema === task.schema && entry.value === task.value)) continue;
    const lineage = [...task.lineage, { schema: task.schema, value: task.value }];
    const directError = evaluateDirect(plan, task, tasks, lineage);
    if (directError) return { status: "error", error: directError };
    branchCount += countBranches(task.schema);
    if (branchCount > VALIDATION_BRANCH_MAX) return { status: "error", error: limitExceeded("validationBranches", VALIDATION_BRANCH_MAX) };
    if (issues.length > VALIDATION_ISSUE_MAX) return { status: "error", error: limitExceeded("validationIssues", VALIDATION_ISSUE_MAX) };
    if (tasks.length > VALIDATION_WORK_MAX) return { status: "error", error: limitExceeded("validationQueue", VALIDATION_WORK_MAX) };
  }
  return issues.length === 0
    ? { status: "ok", value }
    : { status: "error", error: { _tag: "ValidationFailed", issues } };
}

function evaluateDirect(
  plan: ValidationPlan,
  task: EvaluationTask,
  tasks: ValidationTask[],
  lineage: EvaluationTask["lineage"],
): ValidationLimitExceeded | UnsupportedValidationKeyword | undefined {
  assert(isRecord(task.schema), "evaluated schema must be an object");
  assert(Array.isArray(tasks), "validation task queue must be an array");
  const { schema, value, path, issues } = task;
  if (typeof schema.$ref === "string") {
    const reference = parseDefinitionReference(schema.$ref);
    if (reference === undefined) return unsupported("$ref", ["$ref"], `Unsupported reference: ${schema.$ref}`);
    const target = resolveDefinitionReference(plan.definitions, reference);
    if (!isRecord(target)) {
      addIssue(issues, path, "$ref", `Definition reference not found: ${schema.$ref}`);
    } else {
      tasks.push({ ...task, schema: target, depth: task.depth + 1, lineage });
    }
  }
  evaluateType(schema, value, path, issues);
  evaluateEquality(schema, value, path, issues);
  if (typeof value === "number") evaluateNumber(schema, value, path, issues);
  if (typeof value === "string") evaluateString(plan, schema, value, path, issues);
  if (Array.isArray(value)) {
    const arrayError = evaluateArray(schema, value, task, tasks, lineage);
    if (arrayError) return arrayError;
  } else if (isRecord(value)) {
    const objectError = evaluateObject(plan, schema, value, task, tasks, lineage);
    if (objectError) return objectError;
  }
  scheduleCombinators(schema, value, task, tasks, lineage);
  return undefined;
}

function evaluateType(schema: Record<string, unknown>, value: unknown, path: ReadonlyArray<string | number>, issues: ValidationIssue[]): void {
  assert(isRecord(schema), "type schema must be an object");
  assert(Array.isArray(path) && Array.isArray(issues), "type validation collections must be arrays");
  const declared = schema.type;
  if (declared === undefined || (schema.nullable === true && value === null)) return;
  const types = Array.isArray(declared) ? declared : [declared];
  if (!types.every((type) => typeof type === "string")) {
    addIssue(issues, path, "type", "Schema type must be a string or string array.");
    return;
  }
  if (!types.some((type) => matchesType(type, value))) addIssue(issues, path, "type", `Expected ${types.join(" or ")}.`);
}

function evaluateEquality(schema: Record<string, unknown>, value: unknown, path: ReadonlyArray<string | number>, issues: ValidationIssue[]): void {
  assert(isRecord(schema), "equality schema must be an object");
  assert(Array.isArray(path) && Array.isArray(issues), "equality validation collections must be arrays");
  if (Object.prototype.hasOwnProperty.call(schema, "const") && !isDeepStrictEqual(value, schema.const)) {
    addIssue(issues, path, "const", "Value must equal the schema constant.");
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => isDeepStrictEqual(candidate, value))) {
    addIssue(issues, path, "enum", "Value is not in the allowed enumeration.");
  }
}

function evaluateNumber(schema: Record<string, unknown>, value: number, path: ReadonlyArray<string | number>, issues: ValidationIssue[]): void {
  assert(isRecord(schema), "numeric schema must be an object");
  assert(Number.isFinite(value) || Number.isNaN(value) || !Number.isFinite(value), "numeric value must be a number");
  if (!Number.isFinite(value)) addIssue(issues, path, "type", "Number must be finite.");
  if (typeof schema.minimum === "number" && value < schema.minimum) addIssue(issues, path, "minimum", `Number must be at least ${schema.minimum}.`);
  if (typeof schema.maximum === "number" && value > schema.maximum) addIssue(issues, path, "maximum", `Number must be at most ${schema.maximum}.`);
  if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) addIssue(issues, path, "exclusiveMinimum", `Number must be greater than ${schema.exclusiveMinimum}.`);
  if (schema.exclusiveMinimum === true && typeof schema.minimum === "number" && value <= schema.minimum) addIssue(issues, path, "exclusiveMinimum", `Number must be greater than ${schema.minimum}.`);
  if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) addIssue(issues, path, "exclusiveMaximum", `Number must be less than ${schema.exclusiveMaximum}.`);
  if (schema.exclusiveMaximum === true && typeof schema.maximum === "number" && value >= schema.maximum) addIssue(issues, path, "exclusiveMaximum", `Number must be less than ${schema.maximum}.`);
  if (schema.format === "int32" && (!Number.isInteger(value) || value < -2_147_483_648 || value > 2_147_483_647)) addIssue(issues, path, "format", "Number does not match format int32.");
  if (schema.format === "int64" && !Number.isSafeInteger(value)) addIssue(issues, path, "format", "Number does not match format int64.");
  if (schema.format === "uint32" && (!Number.isInteger(value) || value < 0 || value > 4_294_967_295)) addIssue(issues, path, "format", "Number does not match format uint32.");
  if (schema.format === "unix-time" && !Number.isInteger(value)) addIssue(issues, path, "format", "Number does not match format unix-time.");
  if (typeof schema.multipleOf === "number" && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > Number.EPSILON * Math.max(1, Math.abs(quotient))) {
      addIssue(issues, path, "multipleOf", `Number must be a multiple of ${schema.multipleOf}.`);
    }
  }
}

function evaluateString(plan: ValidationPlan, schema: Record<string, unknown>, value: string, path: ReadonlyArray<string | number>, issues: ValidationIssue[]): void {
  assert(isRecord(schema), "string schema must be an object");
  assert(typeof value === "string", "string value must be text");
  const length = [...value].length;
  if (typeof schema.minLength === "number" && length < schema.minLength) addIssue(issues, path, "minLength", `String must contain at least ${schema.minLength} characters.`);
  if (typeof schema.maxLength === "number" && length > schema.maxLength) addIssue(issues, path, "maxLength", `String must contain at most ${schema.maxLength} characters.`);
  const pattern = plan.patterns.get(schema);
  if (pattern && !pattern.test(value)) addIssue(issues, path, "pattern", "String does not match the required pattern.");
  if (typeof schema.format === "string" && !matchesFormat(schema.format, value)) addIssue(issues, path, "format", `String does not match format ${schema.format}.`);
}

function evaluateArray(
  schema: Record<string, unknown>,
  value: unknown[],
  task: EvaluationTask,
  tasks: ValidationTask[],
  lineage: EvaluationTask["lineage"],
): ValidationLimitExceeded | undefined {
  assert(isRecord(schema), "array schema must be an object");
  assert(Array.isArray(value), "array value must be an array");
  if (value.length > VALIDATION_COLLECTION_MAX) return limitExceeded("arrayItems", VALIDATION_COLLECTION_MAX);
  if (typeof schema.minItems === "number" && value.length < schema.minItems) addIssue(task.issues, task.path, "minItems", `Array must contain at least ${schema.minItems} items.`);
  if (typeof schema.maxItems === "number" && value.length > schema.maxItems) addIssue(task.issues, task.path, "maxItems", `Array must contain at most ${schema.maxItems} items.`);
  if (schema.uniqueItems === true) {
    const comparisonCount = (value.length * (value.length - 1)) / 2;
    if (comparisonCount > VALIDATION_UNIQUE_COMPARISON_MAX) return limitExceeded("uniqueItemComparisons", VALIDATION_UNIQUE_COMPARISON_MAX);
    for (let left = 0; left < value.length; left += 1) {
      for (let right = left + 1; right < value.length; right += 1) {
        if (isDeepStrictEqual(value[left], value[right])) {
          addIssue(task.issues, task.path, "uniqueItems", "Array items must be unique.");
          left = value.length;
          break;
        }
      }
    }
  }
  const tupleItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items) ? schema.items : [];
  for (let index = 0; index < tupleItems.length && index < value.length; index += 1) {
    if (isRecord(tupleItems[index])) tasks.push(makeEvaluation(tupleItems[index], value[index], [...task.path, index], task.depth + 1, task.issues, lineage));
  }
  if (isRecord(schema.items)) {
    for (let index = tupleItems.length; index < value.length; index += 1) {
      tasks.push(makeEvaluation(schema.items, value[index], [...task.path, index], task.depth + 1, task.issues, lineage));
    }
  } else if (Array.isArray(schema.items) && isRecord(schema.additionalItems)) {
    for (let index = tupleItems.length; index < value.length; index += 1) {
      tasks.push(makeEvaluation(schema.additionalItems, value[index], [...task.path, index], task.depth + 1, task.issues, lineage));
    }
  } else if (
    (schema.items === false || (Array.isArray(schema.items) && schema.additionalItems === false)) &&
    value.length > tupleItems.length
  ) {
    addIssue(task.issues, task.path, "items", "Array contains additional items.");
  }
  if (isRecord(schema.contains)) scheduleContains(schema, value, task, tasks, lineage);
  return undefined;
}

function evaluateObject(
  plan: ValidationPlan,
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  task: EvaluationTask,
  tasks: ValidationTask[],
  lineage: EvaluationTask["lineage"],
): ValidationLimitExceeded | undefined {
  assert(isRecord(schema), "object schema must be an object");
  assert(isRecord(value), "object value must be an object");
  const entries = Object.entries(value);
  if (entries.length > VALIDATION_COLLECTION_MAX) return limitExceeded("objectProperties", VALIDATION_COLLECTION_MAX);
  if (typeof schema.minProperties === "number" && entries.length < schema.minProperties) addIssue(task.issues, task.path, "minProperties", `Object must contain at least ${schema.minProperties} properties.`);
  if (typeof schema.maxProperties === "number" && entries.length > schema.maxProperties) addIssue(task.issues, task.path, "maxProperties", `Object must contain at most ${schema.maxProperties} properties.`);
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === "string" && !Object.prototype.hasOwnProperty.call(value, name)) addIssue(task.issues, [...task.path, name], "required", `Required property is missing: ${name}.`);
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const compiledPatterns = plan.propertyPatterns.get(schema) ?? [];
  for (const [name, childValue] of entries) {
    let matched = false;
    const property = Object.prototype.hasOwnProperty.call(properties, name)
      ? properties[name]
      : undefined;
    if (isRecord(property)) {
      matched = true;
      tasks.push(makeEvaluation(property, childValue, [...task.path, name], task.depth + 1, task.issues, lineage));
    }
    for (const [pattern, child] of compiledPatterns) {
      if (pattern.test(name)) {
        matched = true;
        tasks.push(makeEvaluation(child, childValue, [...task.path, name], task.depth + 1, task.issues, lineage));
      }
    }
    if (!matched) {
      if (schema.additionalProperties === false) addIssue(task.issues, [...task.path, name], "additionalProperties", `Additional property is not allowed: ${name}.`);
      else if (isRecord(schema.additionalProperties)) tasks.push(makeEvaluation(schema.additionalProperties, childValue, [...task.path, name], task.depth + 1, task.issues, lineage));
    }
  }
  if (isRecord(schema.propertyNames)) {
    for (const name of Object.keys(value)) tasks.push(makeEvaluation(schema.propertyNames, name, [...task.path, name], task.depth + 1, task.issues, lineage));
  }
  assert(isRecord(plan.root), "validation plan must remain valid");
  return undefined;
}

function scheduleCombinators(
  schema: Record<string, unknown>,
  value: unknown,
  task: EvaluationTask,
  tasks: ValidationTask[],
  lineage: EvaluationTask["lineage"],
): void {
  assert(isRecord(schema), "combinator schema must be an object");
  assert(Array.isArray(tasks), "combinator task queue must be an array");
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf) if (isRecord(child)) tasks.push(makeEvaluation(child, value, task.path, task.depth + 1, task.issues, lineage));
  }
  for (const keyword of ["anyOf", "oneOf"] as const) {
    const children = schema[keyword];
    if (!Array.isArray(children)) continue;
    const branches = children.map(() => [] as ValidationIssue[]);
    tasks.push({ kind: "finish-branch", keyword, path: task.path, issues: task.issues, branches, depth: task.depth, lineage });
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (isRecord(child)) tasks.push(makeEvaluation(child, value, task.path, task.depth + 1, branches[index]!, lineage));
    }
  }
  if (isRecord(schema.not)) {
    const branches = [[] as ValidationIssue[]];
    tasks.push({ kind: "finish-branch", keyword: "not", path: task.path, issues: task.issues, branches, depth: task.depth, lineage });
    tasks.push(makeEvaluation(schema.not, value, task.path, task.depth + 1, branches[0]!, lineage));
  }
  if (isRecord(schema.if)) {
    const branches = [[] as ValidationIssue[]];
    tasks.push({
      kind: "finish-branch", keyword: "if", path: task.path, issues: task.issues, branches,
      thenSchema: isRecord(schema.then) ? schema.then : undefined,
      elseSchema: isRecord(schema.else) ? schema.else : undefined,
      value, depth: task.depth, lineage,
    });
    tasks.push(makeEvaluation(schema.if, value, task.path, task.depth + 1, branches[0]!, lineage));
  }
}

function scheduleContains(schema: Record<string, unknown>, value: unknown[], task: EvaluationTask, tasks: ValidationTask[], lineage: EvaluationTask["lineage"]): void {
  assert(isRecord(schema.contains), "contains schema must be an object");
  assert(Array.isArray(value), "contains value must be an array");
  const branches = value.map(() => [] as ValidationIssue[]);
  tasks.push({
    kind: "finish-branch",
    keyword: "contains",
    path: task.path,
    issues: task.issues,
    branches,
    depth: task.depth,
    lineage,
    matchCountMin: typeof schema.minContains === "number" ? schema.minContains : 1,
    matchCountMax: typeof schema.maxContains === "number" ? schema.maxContains : Number.POSITIVE_INFINITY,
  });
  for (let index = value.length - 1; index >= 0; index -= 1) {
    tasks.push(makeEvaluation(schema.contains, value[index], [...task.path, index], task.depth + 1, branches[index]!, lineage));
  }
}

function finishBranch(task: BranchFinishTask, tasks: ValidationTask[]): ValidationLimitExceeded | undefined {
  assert(Array.isArray(task.branches) && task.branches.length <= VALIDATION_BRANCH_MAX, "branch results must be bounded");
  assert(Array.isArray(tasks), "validation task queue must be an array");
  const validCount = task.branches.filter((branch) => branch.length === 0).length;
  if (task.keyword === "anyOf" && validCount === 0) addIssue(task.issues, task.path, "anyOf", "Value must match at least one branch.");
  else if (task.keyword === "oneOf" && validCount !== 1) addIssue(task.issues, task.path, "oneOf", "Value must match exactly one branch.");
  else if (task.keyword === "not" && validCount === 1) addIssue(task.issues, task.path, "not", "Value must not match the excluded schema.");
  else if (task.keyword === "contains" && (validCount < task.matchCountMin! || validCount > task.matchCountMax!)) {
    addIssue(task.issues, task.path, "contains", `Array contains ${validCount} matching items.`);
  } else if (task.keyword === "if") {
    const selected = validCount === 1 ? task.thenSchema : task.elseSchema;
    if (selected) tasks.push(makeEvaluation(selected, task.value, task.path, task.depth + 1, task.issues, task.lineage));
  }
  if (task.issues.length > VALIDATION_ISSUE_MAX) return limitExceeded("validationIssues", VALIDATION_ISSUE_MAX);
  return undefined;
}

function makeEvaluation(schema: Record<string, unknown>, value: unknown, path: ReadonlyArray<string | number>, depth: number, issues: ValidationIssue[], lineage: EvaluationTask["lineage"]): EvaluationTask {
  assert(isRecord(schema), "evaluation schema must be an object");
  assert(Array.isArray(path) && Array.isArray(issues), "evaluation collections must be arrays");
  return { kind: "evaluate", schema, value, path, depth, issues, lineage };
}

function countBranches(schema: Record<string, unknown>): number {
  assert(isRecord(schema), "branch schema must be an object");
  assert(VALIDATION_BRANCH_MAX > 0, "branch limit must be positive");
  return [schema.anyOf, schema.oneOf, schema.allOf, schema.prefixItems]
    .reduce<number>((count, value) => count + (Array.isArray(value) ? value.length : 0), 0) +
    (isRecord(schema.not) ? 1 : 0) + (isRecord(schema.if) ? 1 : 0);
}

function matchesType(type: string, value: unknown): boolean {
  assert(typeof type === "string", "schema type must be a string");
  assert(type.length > 0, "schema type must be non-empty");
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function matchesFormat(format: string, value: string): boolean {
  assert(typeof format === "string" && format.length > 0, "format must be non-empty");
  assert(typeof value === "string", "formatted value must be a string");
  switch (format) {
    case "date": return isRfc3339Date(value);
    case "time": return /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value);
    case "date-time": return isRfc3339DateTime(value);
    case "duration": return /^P(?=\d|T\d)(?:\d+Y)?(?:\d+M)?(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/.test(value);
    case "email": return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "hostname": return value.length <= 253 && /^(?=.{1,253}\.?$)(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)*[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.?$/.test(value);
    case "ipv4": return isIP(value) === 4;
    case "ipv6": return isIP(value) === 6;
    case "uri":
    case "url": try { new URL(value); return true; } catch { return false; }
    case "uri-reference": try { new URL(value, "https://example.invalid"); return true; } catch { return false; }
    case "uri-template": return isUriTemplate(value);
    case "uuid": return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
    case "byte": return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
    case "uint64": return /^(?:0|[1-9][0-9]{0,19})$/.test(value) && (value.length < 20 || value <= "18446744073709551615");
    case "google-datetime": return isRfc3339DateTime(value);
    case "google-fieldmask": return true;
    case "YYYY-MM": return /^\d{4}-(?:0[1-9]|1[0-2])$/.test(value);
    case "unix-time": return /^-?\d+$/.test(value);
    case "currency": return /^[A-Za-z]{3}$/.test(value);
    case "decimal": return /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value);
    case "repo.nwo": return /^[^/\s]+\/[^/\s]+$/.test(value);
    case "int32": return /^-?\d+$/.test(value);
    case "int64": return /^-?\d+$/.test(value);
    case "float":
    case "double": return !Number.isNaN(Number(value));
    case "binary":
    case "password": return true;
    default: return false;
  }
}

function isUriTemplate(value: string): boolean {
  assert(typeof value === "string", "URI template must be a string");
  assert(value.length <= VALIDATION_PATTERN_LENGTH_MAX, "URI template must be bounded");
  if (/\s|[\u0000-\u001f\u007f]/u.test(value)) return false;
  let index = 0;
  let rendered = "";
  while (index < value.length) {
    if (value[index] !== "{") {
      if (value[index] === "}") return false;
      rendered += value[index];
      index += 1;
      continue;
    }
    const end = value.indexOf("}", index + 1);
    if (end === -1) return false;
    const expression = value.slice(index + 1, end);
    if (!/^[+#./;?&]?[A-Za-z0-9_%.-]+(?:(?::\d+|\*)?)(?:,[A-Za-z0-9_%.-]+(?:(?::\d+|\*)?))*$/.test(expression)) return false;
    rendered += "template";
    index = end + 1;
  }
  try {
    new URL(rendered, "https://example.invalid");
    return true;
  } catch {
    return false;
  }
}

function isRfc3339Date(value: string): boolean {
  assert(typeof value === "string", "date value must be a string");
  assert(value.length <= VALIDATION_PATTERN_LENGTH_MAX, "date value must be bounded");
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

function isRfc3339DateTime(value: string): boolean {
  assert(typeof value === "string", "date-time value must be a string");
  assert(value.length <= VALIDATION_PATTERN_LENGTH_MAX, "date-time value must be bounded");
  const separator = value.search(/[Tt]/);
  if (separator === -1 || !isRfc3339Date(value.slice(0, separator))) return false;
  return /^(?:[01]\d|2[0-3]):[0-5]\d:(?:[0-5]\d|60)(?:\.\d+)?(?:[Zz]|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(value.slice(separator + 1));
}

interface DefinitionReference {
  readonly name: string;
  readonly path: readonly string[];
}

function parseDefinitionReference(reference: string): DefinitionReference | undefined {
  assert(typeof reference === "string", "schema reference must be a string");
  assert(reference.length <= VALIDATION_REFERENCE_LENGTH_MAX, "schema reference must be bounded");
  if (!reference.startsWith("#/$defs/")) return undefined;
  const segments = reference.slice("#/$defs/".length).split("/").map(decodePointerSegment);
  if (segments.length === 0 || segments[0]!.length === 0) return undefined;
  return { name: segments[0]!, path: segments.slice(1) };
}

function resolveDefinitionReference(
  definitions: Readonly<Record<string, Record<string, unknown>>>,
  reference: DefinitionReference,
): unknown {
  assert(isRecord(definitions), "reference definitions must be an object");
  assert(reference.name.length > 0 && Array.isArray(reference.path), "definition reference must be valid");
  let current: unknown = Object.prototype.hasOwnProperty.call(definitions, reference.name)
    ? definitions[reference.name]
    : undefined;
  for (const segment of reference.path) {
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isRecord(current) && Object.prototype.hasOwnProperty.call(current, segment)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function decodePointerSegment(segment: string): string {
  assert(typeof segment === "string", "JSON Pointer segment must be a string");
  assert(segment.length <= VALIDATION_REFERENCE_LENGTH_MAX, "JSON Pointer segment must be bounded");
  return segment.replaceAll("~1", "/").replaceAll("~0", "~");
}

function addIssue(issues: ValidationIssue[], path: ReadonlyArray<string | number>, keyword: string, message: string): void {
  assert(Array.isArray(issues) && Array.isArray(path), "validation issue collections must be arrays");
  assert(typeof keyword === "string" && typeof message === "string", "validation issue text must be strings");
  if (issues.length <= VALIDATION_ISSUE_MAX) issues.push({ message, path: [...path], keyword });
}

function unsupported(keyword: string, schemaPath: ReadonlyArray<string | number>, message: string): UnsupportedValidationKeyword {
  assert(typeof keyword === "string" && keyword.length > 0, "unsupported keyword must be non-empty");
  assert(Array.isArray(schemaPath) && typeof message === "string", "unsupported keyword details must be valid");
  return { _tag: "UnsupportedValidationKeyword", keyword, schemaPath, message };
}

function limitExceeded(limit: string, maximum: number): ValidationLimitExceeded {
  assert(typeof limit === "string" && limit.length > 0, "limit name must be non-empty");
  assert(Number.isInteger(maximum) && maximum > 0, "limit maximum must be positive");
  return { _tag: "ValidationLimitExceeded", limit, maximum, message: `${limit} exceeds ${maximum}.` };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
