import assert from "node:assert/strict";

import type { ExtractedOperation, NormalizedParameter, ParsedSpec } from "./types.js";

const MAX_FINDINGS = 1_000;
const VALID_FORMATS = new Set(["openapi3", "swagger2", "google-discovery"]);
const VALID_METHODS = new Set(["GET", "PUT", "POST", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);
const VALID_PARAMETER_LOCATIONS = new Set(["query", "path", "header", "cookie"]);

export interface ModelValidationFinding {
  code: string;
  location: string;
  message: string;
}

export function assertValidParsedSpecModel(parsed: ParsedSpec): void {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(Array.isArray(parsed.operations), "parsed spec operations must be an array");
  const findings = validateParsedSpecModel(parsed);
  if (findings.length === 0) return;
  const details = findings.map((finding) => `${finding.code} at ${finding.location}: ${finding.message}`).join("; ");
  throw new TypeError(`Normalized spec model validation failed: ${details}`);
}

/** Validate the normalized model before compilation consumes it. */
export function validateParsedSpecModel(parsed: ParsedSpec): ModelValidationFinding[] {
  assert(parsed !== null && typeof parsed === "object", "parsed spec must be an object");
  assert(Array.isArray(parsed.operations), "parsed spec operations must be an array");
  const findings: ModelValidationFinding[] = [];
  let findingsTruncated = false;
  const add = (code: string, location: string, message: string): void => {
    if (findings.length < MAX_FINDINGS - 1) findings.push({ code, location, message });
    else findingsTruncated = true;
  };
  if (!VALID_FORMATS.has(parsed.specFormat)) add("invalidFormat", "specFormat", "unsupported normalized format");
  if (!Array.isArray(parsed.servers)) add("invalidServers", "servers", "servers must be an array");
  if (!isRecord(parsed.schemas)) add("invalidSchemas", "schemas", "schemas must be an object");
  for (let index = 0; index < parsed.operations.length && !findingsTruncated; index += 1) {
    const operation = parsed.operations[index];
    if (!isRecord(operation)) {
      add("invalidOperation", `operations[${index}]`, "operation must be an object");
      continue;
    }
    validateOperation(operation as ExtractedOperation, `operations[${index}]`, add);
  }
  if (findingsTruncated) {
    findings.push({ code: "findingLimit", location: "model", message: `validation stopped after ${MAX_FINDINGS - 1} findings` });
  }
  return findings;
}

function validateOperation(
  operation: ExtractedOperation,
  location: string,
  add: (code: string, location: string, message: string) => void,
): void {
  assert(operation !== null && typeof operation === "object", "operation must be an object");
  assert(typeof location === "string" && location.length > 0, "operation location must be non-empty");
  if (typeof operation.operationKey !== "string" || operation.operationKey.length === 0) add("missingOperationKey", location, "operationKey must be non-empty");
  if (typeof operation.toolName !== "string" || operation.toolName.length === 0) add("missingToolName", location, "toolName must be non-empty");
  if (!VALID_METHODS.has(operation.method)) add("invalidMethod", location, `unsupported method ${String(operation.method)}`);
  if (typeof operation.path !== "string" || !operation.path.startsWith("/")) add("invalidPath", location, "path must start with /");
  if (VALID_METHODS.has(operation.method) && typeof operation.path === "string" && operation.path.startsWith("/") && operation.operationKey !== `${operation.method} ${operation.path}`) {
    add("inconsistentOperationKey", location, "operationKey must equal METHOD + space + path");
  }
  if (!Array.isArray(operation.parameters)) add("invalidParameters", location, "parameters must be an array");
  else {
    for (let index = 0; index < operation.parameters.length; index += 1) {
      const parameter = operation.parameters[index];
      if (!parameter) {
        add("invalidParameter", `${location}.parameters[${index}]`, "parameter must be an object");
        continue;
      }
      validateParameter(parameter, `${location}.parameters[${index}]`, add);
    }
  }
  if (!Array.isArray(operation.tags)) add("invalidTags", location, "tags must be an array");
  if (typeof operation.deprecated !== "boolean") add("invalidDeprecated", location, "deprecated must be boolean");
}

function validateParameter(
  parameter: NormalizedParameter,
  location: string,
  add: (code: string, location: string, message: string) => void,
): void {
  assert(parameter !== null && typeof parameter === "object", "parameter must be an object");
  assert(typeof location === "string" && location.length > 0, "parameter location must be non-empty");
  if (typeof parameter.name !== "string" || parameter.name.length === 0) add("invalidParameterName", location, "parameter name must be non-empty");
  if (!VALID_PARAMETER_LOCATIONS.has(parameter.in)) add("invalidParameterLocation", location, `unsupported parameter location ${String(parameter.in)}`);
  if (typeof parameter.required !== "boolean") add("invalidParameterRequired", location, "parameter required must be boolean");
  if (!isRecord(parameter.schema)) add("invalidParameterSchema", location, "parameter schema must be an object");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  assert(typeof value !== "function", "value must not be a function");
  assert(typeof value !== "symbol", "value must not be a symbol");
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
