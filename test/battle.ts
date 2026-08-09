/**
 * Battle suite: run the 5 real-world specs through parse → compile → Ajv in
 * heap-capped child processes. Guards the machine: each spec runs under
 * --max-old-space-size (a regression like the old 1220×969 clone OOM dies in
 * the child, not on the host), with per-spec timeouts and a fail-fast
 * watchdog.
 *
 * Usage: node dist/test/battle.js   (npm run battle)
 * Exit code 0 = all gates passed.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface SpecCase {
  name: string;
  file: string;
  expectedOps: number;
  heapCapMB: number;
  timeoutMs: number;
  /** Bounds asserted on the probe's stats. defsBytesTotal is the JSON-sum of
   *  per-tool $defs (NOT memory — defs are shared by reference); the memory
   *  gate is the child heap cap. Optional: undefined skips the check. */
  defsBytesMaxBound: number;
  defsBytesTotalBound: number | undefined;
  ajvFailuresBound: number;
  refFailuresBound: number;
}

const SPECS: SpecCase[] = [
  {
    name: "petstore3 (OAS 3.0.4)",
    file: "petstore3.json",
    expectedOps: 19,
    heapCapMB: 512,
    timeoutMs: 60_000,
    defsBytesMaxBound: 200_000,
    defsBytesTotalBound: 2_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "booking (OAS 3.1.0, 0 schemas)",
    file: "booking.json",
    expectedOps: 39,
    heapCapMB: 512,
    timeoutMs: 60_000,
    defsBytesMaxBound: 100_000,
    defsBytesTotalBound: 1_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "booking.yaml (the documented download — YAML path)",
    file: "booking.yaml",
    expectedOps: 39,
    heapCapMB: 512,
    timeoutMs: 60_000,
    defsBytesMaxBound: 100_000,
    defsBytesTotalBound: 1_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "stripe (OAS 3.0.0, 1440 schemas)",
    file: "stripe.json",
    expectedOps: 589,
    heapCapMB: 1024,
    timeoutMs: 240_000,
    // ~1MB closure is Stripe's natural anyOf-graph size; over-cap tools fall
    // back to the shared defs map (~1.8MB). Sum is serialization, not memory.
    defsBytesMaxBound: 2_500_000,
    defsBytesTotalBound: undefined,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "github (OAS 3.0.3, 13MB — the OOM case)",
    file: "github.json",
    expectedOps: 1220,
    heapCapMB: 1024,
    timeoutMs: 300_000,
    defsBytesMaxBound: 200_000,
    defsBytesTotalBound: undefined,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "slack (Swagger 2.0, 174 ops — official Web API spec)",
    file: "slack.json",
    expectedOps: 174,
    heapCapMB: 512,
    timeoutMs: 60_000,
    defsBytesMaxBound: 100_000,
    defsBytesTotalBound: 1_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "swagger2 petstore (2.0 conversion)",
    file: "swagger2.json",
    expectedOps: 20,
    heapCapMB: 512,
    timeoutMs: 60_000,
    defsBytesMaxBound: 200_000,
    defsBytesTotalBound: 2_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
];

interface ProbeStats {
  parseMs?: number;
  compileMs?: number;
  totalMs?: number;
  tools?: number;
  heapUsedMB?: number;
  heapTotalMB?: number;
  defsBytesMax?: number;
  defsBytesTotal?: number;
  defsCountTotal?: number;
  outputSchemaCount?: number;
  ajvCompileFailures?: number;
  refResolutionFailures?: number;
  refRewriteFailures?: number;
  unresolvedRefsTotal?: number;
  failures?: string[];
  fatal?: string;
  error?: string;
  expected?: number;
  actual?: number;
}

const fmtBytes = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}MB` : `${Math.round(n / 1000)}KB`;

const fmtMs = (n: number): string => `${n}ms`;

function runProbe(spec: SpecCase): Promise<ProbeStats> {
  return new Promise((resolve, reject) => {
    const script = fileURLToPath(new URL("./scripts/run-spec.js", import.meta.url));
    const child = execFile(
      process.execPath,
      [
        `--max-old-space-size=${spec.heapCapMB}`,
        "--expose-gc",
        script,
        spec.file,
        String(spec.expectedOps),
      ],
      { timeout: spec.timeoutMs, maxBuffer: 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          if ((err as { killed?: boolean }).killed) {
            reject(new Error(`timed out after ${spec.timeoutMs}ms`));
            return;
          }
          const oom = /heap out of memory|heap limit/i.test(String(err) + stderr);
          reject(new Error(oom ? "OOM (heap limit exceeded)" : `exit ${err.code ?? err.message}`));
          return;
        }
        const line = stdout
          .split("\n")
          .find((l) => l.startsWith("RESULT_JSON:"));
        if (!line) {
          reject(new Error(`no RESULT_JSON in child output: ${stderr.slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(line.slice("RESULT_JSON: ".length)) as ProbeStats);
        } catch (e) {
          reject(new Error(`bad RESULT_JSON: ${String(e)}`));
        }
      },
    );
  });
}

async function main(): Promise<void> {
  // Fixtures are git-ignored (re-fetchable upstream data); fail fast with an
  // actionable message instead of a confusing ENOENT from a child probe.
  const missing = SPECS.filter(
    (spec) =>
      !existsSync(fileURLToPath(new URL(`../../test/fixtures/${spec.file}`, import.meta.url))),
  );
  if (missing.length > 0) {
    console.error(
      `Missing battle fixtures: ${missing.map((s) => s.file).join(", ")}\n` +
        "Run `npm run fixtures` to download them (they are git-ignored).",
    );
    process.exit(1);
  }

  console.log("=".repeat(88));
  console.log("BATTLE SUITE — 7 real specs (JSON + YAML), parse → compile → Ajv, heap-capped children");
  console.log("=".repeat(88));

  let failures = 0;
  for (const spec of SPECS) {
    const t0 = performance.now();
    try {
      const stats = await runProbe(spec);
      const dt = Math.round(performance.now() - t0);
      const phaseErrors: string[] = [];

      if (stats.fatal) {
        phaseErrors.push(`child failed during ${stats.fatal}: ${stats.error}`);
      }
      if (stats.tools !== spec.expectedOps) {
        phaseErrors.push(`tool count ${stats.tools} !== ${spec.expectedOps}`);
      }
      if ((stats.defsBytesMax ?? 0) > spec.defsBytesMaxBound) {
        phaseErrors.push(
          `max per-tool $defs ${fmtBytes(stats.defsBytesMax!)} > bound ${fmtBytes(spec.defsBytesMaxBound)}`,
        );
      }
      if ((stats.defsBytesTotal ?? 0) > (spec.defsBytesTotalBound ?? Infinity)) {
        phaseErrors.push(
          `sum per-tool $defs ${fmtBytes(stats.defsBytesTotal!)} > bound ${
            spec.defsBytesTotalBound !== undefined
              ? fmtBytes(spec.defsBytesTotalBound)
              : "unbounded"
          }`,
        );
      }
      if ((stats.ajvCompileFailures ?? 0) > spec.ajvFailuresBound) {
        phaseErrors.push(`ajv compile failures: ${stats.ajvCompileFailures}`);
      }
      if ((stats.refResolutionFailures ?? 0) > spec.refFailuresBound) {
        phaseErrors.push(`dangling $refs: ${stats.refResolutionFailures}`);
      }
      if ((stats.refRewriteFailures ?? 0) > 0) {
        phaseErrors.push(`unrewritten native refs: ${stats.refRewriteFailures}`);
      }
      if (stats.failures && stats.failures.length > 0) {
        phaseErrors.push(`probe failures: ${stats.failures.join("; ")}`);
      }
      if ((stats.heapUsedMB ?? 0) > spec.heapCapMB - 64) {
        phaseErrors.push(`child heap ${stats.heapUsedMB}MB too close to cap ${spec.heapCapMB}MB`);
      }

      const ok = phaseErrors.length === 0;
      if (!ok) failures += 1;
      const outputSchemaPct =
        stats.tools && stats.outputSchemaCount !== undefined
          ? Math.round((stats.outputSchemaCount / stats.tools) * 100)
          : 0;

      console.log(`\n[${ok ? "PASS" : "FAIL"}] ${spec.name} (${dt}ms)`);
      console.log(
        `  ops=${stats.tools}  parse=${fmtMs(stats.parseMs ?? 0)}  compile=${fmtMs(stats.compileMs ?? 0)}` +
          `  heap=${stats.heapUsedMB ?? "?"}MB/${spec.heapCapMB}MB  outputSchemas=${outputSchemaPct}%`,
      );
      console.log(
        `  defs: max=${fmtBytes(stats.defsBytesMax ?? 0)}  total=${fmtBytes(stats.defsBytesTotal ?? 0)}` +
          `  count=${stats.defsCountTotal ?? 0}  unresolvedRefs=${stats.unresolvedRefsTotal ?? 0}`,
      );
      console.log(
        `  ajvCompileFailures=${stats.ajvCompileFailures ?? 0}  danglingRefs=${stats.refResolutionFailures ?? 0}`,
      );
      if (phaseErrors.length > 0) {
        for (const e of phaseErrors) console.log(`  ✗ ${e}`);
      }
    } catch (err) {
      failures += 1;
      console.log(`\n[FAIL] ${spec.name}: ${(err as Error).message}`);
    }
  }

  // Watchdog: the parent must stay light — children own the heavy allocations.
  const parentHeapMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
  console.log(`\n${"=".repeat(88)}`);
  console.log(
    `RESULT: ${failures === 0 ? "ALL PASSED ✓" : `${failures} SPEC(S) FAILED ✗`}` +
      `  (parent heap ${parentHeapMB}MB)`,
  );
  console.log("=".repeat(88));
  process.exit(failures === 0 ? 0 : 1);
}

await main();
