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
import { Ajv } from "ajv";

import { compileSpecToTools } from "../../src/factory.js";
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
  compiled = compileSpecToTools(parsed, maxDefsBytes !== undefined ? { maxDefsBytes } : {});
} catch (err) {
  console.log(`RESULT_JSON: ${JSON.stringify({ fatal: "compile", error: String(err) })}`);
  process.exit(1);
}
stats.compileMs = Math.round(performance.now() - t1);

// Phase 3: per-tool schema stats + ref integrity
const ajv = new Ajv({ strict: false, validateFormats: false, validateSchema: false });
let ajvCompileFailures = 0;
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

for (const tool of compiled.tools) {
  const inputBytes = JSON.stringify(tool.inputSchema).length;
  inputSchemaBytesTotal += inputBytes;
  inputSchemaBytesMax = Math.max(inputSchemaBytesMax, inputBytes);

  const defs = (tool.inputSchema.$defs ?? {}) as Record<string, unknown>;
  const defsBytes = JSON.stringify(defs).length;
  defsBytesTotal += defsBytes;
  defsBytesMax = Math.max(defsBytesMax, defsBytes);
  defsCountTotal += Object.keys(defs).length;

  if (tool.outputSchema) outputSchemaCount += 1;
  unresolvedRefsTotal += tool.unresolvedRefs?.length ?? 0;

  // Every #/ ref in input + output + defs must be a #/$defs/X that exists locally.
  const schema = { ...tool.inputSchema, ...(tool.outputSchema ? { out: tool.outputSchema } : {}) };
  refResolutionFailures += checkRefs(schema, defs, tool.name, failures, "resolution");
  refRewriteFailures += checkRefRewrite(tool.inputSchema, tool.name, failures);

  try {
    // nullable is an OAS-3.0-dialect keyword, not JSON Schema: Ajv rejects
    // `nullable: true` on a $ref sibling (GitHub's pattern). Strip it for the
    // compile gate — the LLM-facing schema keeps it for description.
    ajv.compile(stripNullable(tool.inputSchema) as object);
  } catch (err) {
    ajvCompileFailures += 1;
    if (failures.length < 10) failures.push(`${tool.name}: ajv ${String(err)}`);
  }
}

stats.tools = compiled.tools.length;
stats.inputSchemaBytesTotal = inputSchemaBytesTotal;
stats.inputSchemaBytesMax = inputSchemaBytesMax;
stats.defsBytesTotal = defsBytesTotal;
stats.defsBytesMax = defsBytesMax;
stats.defsCountTotal = defsCountTotal;
stats.outputSchemaCount = outputSchemaCount;
stats.ajvCompileFailures = ajvCompileFailures;
stats.refResolutionFailures = refResolutionFailures;
stats.refRewriteFailures = refRewriteFailures;
stats.unresolvedRefsTotal = unresolvedRefsTotal;
stats.heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
stats.heapTotalMB = Math.round(process.memoryUsage().heapTotal / 1024 / 1024);
stats.totalMs = Math.round(performance.now() - t0);

console.log(`RESULT_JSON: ${JSON.stringify({ ...stats, failures })}`);
process.exit(0);

/** Remove OAS-only `nullable` keys (Ajv treats it as a JSON-Schema keyword).
 *  Mutates in place — the probe's schemas are throwaway, and a deep copy per
 *  tool would spike heap (Stripe: 60MB → 520MB on 589 tools). */
function stripNullable(node: unknown): unknown {
  if (Array.isArray(node)) {
    for (const item of node) stripNullable(item);
    return node;
  }
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  for (const [k, v] of Object.entries(obj)) {
    if (k === "nullable") {
      delete obj[k];
      continue;
    }
    stripNullable(v);
  }
  return node;
}

/** Verify every $ref resolves within the tool's own $defs (transitively). */
function checkRefs(
  node: unknown,
  defs: Record<string, unknown>,
  toolName: string,
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
          if (failures.length < 10) failures.push(`${toolName}: dangling ${phase} $ref ${value}`);
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

/** No leftover native refs (#/components/schemas, #/definitions) in tool schemas. */
function checkRefRewrite(node: unknown, toolName: string, failures: string[]): number {
  let count = 0;
  const walk = (value: unknown): void => {
    if (typeof value === "string") {
      if (
        value.startsWith("#/components/schemas/") ||
        value.startsWith("#/definitions/")
      ) {
        count += 1;
        if (failures.length < 10) failures.push(`${toolName}: unrewritten ref ${value}`);
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
