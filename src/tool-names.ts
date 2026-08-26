import assert from "node:assert/strict";

export const TOOL_NAME_LOOKUP_LENGTH_MAX = 1_024;
const RAW_TOOL_NAME_LENGTH_MAX = 200 * 1024 * 1024;
const DUPLICATE_SUFFIX_MAX = 1_000_000;

export interface UniqueToolNameState {
  readonly counts: Map<string, number>;
  readonly names: Set<string>;
}

export function createUniqueToolNameState(): UniqueToolNameState {
  const state = { counts: new Map<string, number>(), names: new Set<string>() };
  assert(state.counts.size === 0, "tool-name counts must start empty");
  assert(state.names.size === 0, "tool-name set must start empty");
  return state;
}

export function deriveToolName(
  operationId: string | undefined,
  method: string,
  path: string,
): string {
  assert(operationId === undefined || typeof operationId === "string", "operationId must be a string or undefined");
  assert(typeof method === "string" && method.length > 0, "operation method must be non-empty");
  assert(typeof path === "string" && path.startsWith("/"), "operation path must start with /");
  if (operationId) return sanitizeToolName(operationId);
  return sanitizeToolName(`${method}_${path.replace(/[{}]/g, "").split("/").filter(Boolean).join("_")}`);
}

export function deriveOperationKey(method: string, path: string): string {
  assert(typeof method === "string" && method.length > 0, "operation method must be non-empty");
  assert(typeof path === "string" && path.startsWith("/"), "operation path must start with /");
  const operationKey = `${method.toUpperCase()} ${path}`;
  assert(operationKey.length > path.length, "operation key must include a method");
  return operationKey;
}

export function sanitizeToolName(name: string): string {
  assert(typeof name === "string", "tool name must be a string");
  assert(name.length <= RAW_TOOL_NAME_LENGTH_MAX, "raw tool name exceeds the safety limit");
  const sanitized = name
    .replace(/[^a-zA-Z0-9_]/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_") || "unnamed";
  assert(sanitized.length > 0, "sanitized tool name must be non-empty");
  return sanitized;
}

export function assignUniqueToolName(
  candidate: string,
  state: UniqueToolNameState,
): string {
  assert(typeof candidate === "string" && candidate.length > 0, "candidate tool name must be non-empty");
  assert(state.counts instanceof Map && state.names instanceof Set, "tool-name state must contain collections");
  const priorCount = state.counts.get(candidate) ?? 0;
  let suffix = priorCount;
  let name = suffix === 0 ? candidate : `${candidate}_${suffix}`;
  while (state.names.has(name)) {
    suffix += 1;
    if (suffix > DUPLICATE_SUFFIX_MAX) {
      throw new Error("Tool-name duplicate limit exceeded.");
    }
    name = `${candidate}_${suffix}`;
  }
  state.counts.set(candidate, suffix + 1);
  state.names.add(name);
  assert(state.names.has(name), "assigned tool name must be reserved");
  return name;
}
