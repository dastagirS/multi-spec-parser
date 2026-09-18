/**
 * Per-spec battle probe. Runs INSIDE a child process with a bounded heap
 * (--max-old-space-size), so a pathological spec can OOM the child without
 * taking down the machine or the test runner. Prints one JSON line:
 *
 *   RESULT_JSON: {...}
 *
 * Exit code 0 = probe completed (assertions live in the parent).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { compileSpecToOperations } from "../../src/operation-compiler.js";
import { getCanonicalOperationSchema } from "../../src/operation-schema.js";
import { parseSpec, parseSpecText } from "../../src/parse-spec.js";

const fixturePath = (name: string): string =>
  fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url));

const args = process.argv.slice(2);
if (args.length < 1) {
  console.error("usage: run-spec.js <fixture.json> [expectedOps] [maxDefsBytes]");
  process.exit(2);
}
const fixtureName = args[0]!;
const expectedOpsRaw = args[1];
const expectedOps = expectedOpsRaw !== undefined ? Number(expectedOpsRaw) : undefined;
const maxDefsBytesRaw = args[2];
const maxDefsBytes = maxDefsBytesRaw !== undefined ? Number(maxDefsBytesRaw) : undefined;

const text = readFileSync(fixturePath(fixtureName), "utf8");
// Sniff content, never extension: booking.yaml is YAML, others are JSON —
// parseSpecText tries JSON first, falls back to YAML (the P3 fix).
const specObj = parseSpecText(text);

const stats: Record<string, number> = {};

// Phase 1: parse
const t0 = performance.now();
let parsed;
try {
  parsed = parseSpec(specObj);
} catch (err) {
  console.log(`RESULT_JSON: ${JSON.stringify({ fatal: "parse", error: String(err) })}`);
  process.exit(1);
}
stats.parseMs = Math.round(performance.now() - t0);

if (expectedOps !== undefined && parsed.operations.length !== expectedOps) {
  console.log(
    `RESULT_JSON: ${JSON.stringify({
      fatal: "op-count",
      expected: expectedOps,
      actual: parsed.operations.length,
    })}`,
  );
  process.exit(1);
}

// Phase 2: compile (the OOM surface — hoisted defs + per-op closure)
const t1 = performance.now();
let compiled;
try {
  compiled = compileSpecToOperations(parsed, maxDefsBytes !== undefined ? { maxDefsBytes } : {});
} catch (err) {
  console.log(`RESULT_JSON: ${JSON.stringify({ fatal: "compile", error: String(err) })}`);
  process.exit(1);
}
stats.compileMs = Math.round(performance.now() - t1);

// Phase 3: per-operation schema stats + ref integrity
let validatorPlanFailures = 0;
let refResolutionFailures = 0;
let refRewriteFailures = 0;
let outputSchemaCount = 0;
let inputSchemaBytesTotal = 0;
let inputSchemaBytesMax = 0;
let defsBytesTotal = 0;
let defsBytesMax = 0;
let defsCountTotal = 0;
let unresolvedRefsTotal = 0;
const failures: string[] = [];
const validatorFailureDetails: string[] = [];

for (const operation of compiled.operations) {
  const inputCanonical = getCanonicalOperationSchema(operation.input);
  const outputCanonical = operation.output
    ? getCanonicalOperationSchema(operation.output)
    : undefined;
  const defs = { ...inputCanonical.definitions, ...outputCanonical?.definitions };
  const inputSchema = { ...inputCanonical.root, $defs: defs };
  const outputSchema = outputCanonical?.root;
  const inputBytes = JSON.stringify(inputSchema).length;
  inputSchemaBytesTotal += inputBytes;
  inputSchemaBytesMax = Math.max(inputSchemaBytesMax, inputBytes);

  const defsBytes = JSON.stringify(defs).length;
  defsBytesTotal += defsBytes;
  defsBytesMax = Math.max(defsBytesMax, defsBytes);
  defsCountTotal += Object.keys(defs).length;

  if (outputSchema) outputSchemaCount += 1;
  unresolvedRefsTotal += operation.unresolvedRefs?.length ?? 0;

  // Every #/ ref in input + output + defs must be a #/$defs/X that exists locally.
  const schema = { ...inputSchema, ...(outputSchema ? { out: outputSchema } : {}) };
  refResolutionFailures += checkRefs(schema, defs, operation.name, failures, "resolution");
  refRewriteFailures += checkRefRewrite(inputSchema, operation.name, failures);

  const validationHandles = [
    ["input", operation.input],
    ...(operation.output ? [["output", operation.output] as const] : []),
  ] as const;
  for (const [kind, handle] of validationHandles) {
    const validation = await handle.validate(undefined);
    if (
      validation.status === "error" &&
      validation.error._tag !== "ValidationFailed"
    ) {
      validatorPlanFailures += 1;
      if (validatorFailureDetails.length < 10) {
        validatorFailureDetails.push(`${operation.name} ${kind}: ${validation.error.message}`);
      }
    }
  }
}

stats.operations = compiled.operations.length;
stats.inputSchemaBytesTotal = inputSchemaBytesTotal;
stats.inputSchemaBytesMax = inputSchemaBytesMax;
stats.defsBytesTotal = defsBytesTotal;
stats.defsBytesMax = defsBytesMax;
stats.defsCountTotal = defsCountTotal;
stats.outputSchemaCount = outputSchemaCount;
stats.validatorPlanFailures = validatorPlanFailures;
stats.refResolutionFailures = refResolutionFailures;
stats.refRewriteFailures = refRewriteFailures;
stats.unresolvedRefsTotal = unresolvedRefsTotal;
stats.heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
stats.heapTotalMB = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);
stats.totalMs = Math.round(performance.now() - t0);

console.log(`RESULT_JSON: ${JSON.stringify({ ...stats, failures, validatorFailureDetails })}`);
process.exit(0);

/** Verify every $ref resolves within the operation's own $defs (transitively). */
function checkRefs(
  node: unknown,
  defs: Record<string, unknown>,
  operationName: string,
  failures: string[],
  phase: string,
): number {
  let count = 0;
  const walk = (value: unknown, seen: Set<string>): void => {
    if (typeof value === "string") {
      if (value.startsWith("#/$defs/")) {
        const name = value.slice("#/$defs/".length);
        if (!(name in defs)) {
          count += 1;
          if (failures.length < 10) failures.push(`${operationName}: dangling ${phase} $ref ${value}`);
        }
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, seen);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v, seen);
    }
  };
  walk(node, new Set());
  return count;
}

/** No leftover native refs (#/components/schemas, #/definitions) in operation schemas. */
function checkRefRewrite(node: unknown, operationName: string, failures: string[]): number {
  let count = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (
        value.startsWith("#/components/schemas/") ||
        value.startsWith("#/definitions/")
      ) {
        count += 1;
        if (failures.length < 10) failures.push(`${operationName}: unrewritten ref ${value}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const v of Object.values(value as Record<string, unknown>)) walk(v);
    }
  };
  walk(node);
  return count;
}
