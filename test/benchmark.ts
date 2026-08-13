import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const ITERATION_COUNT_DEFAULT = 3;
const CHILD_OUTPUT_BYTES_MAX = 1_000_000;
const CHILD_SCRIPT = fileURLToPath(new URL("./scripts/run-benchmark-spec.js", import.meta.url));

interface BenchmarkSpec {
  name: string;
  url: string;
  heapCapMB: number;
  timeoutMs: number;
}

interface BenchmarkResult {
  name: string;
  url: string;
  bytes: number;
  fetchMs: number;
  iterations: number;
  samplesMs: number[];
  medianMs: number;
  p95Ms: number;
  format: string;
  tools: number;
  heapUsedMB: number;
}

const BENCHMARK_SPECS: BenchmarkSpec[] = [
  {
    name: "Slack Web API",
    url: "https://raw.githubusercontent.com/slackapi/slack-api-specs/refs/heads/master/web-api/slack_web_openapi_v2_without_examples.json",
    heapCapMB: 1_024,
    timeoutMs: 180_000,
  },
  {
    name: "Microsoft Graph v1.0 (includes Outlook)",
    url: "https://aka.ms/graph/v1.0/openapi.yaml",
    heapCapMB: 4_096,
    timeoutMs: 900_000,
  },
  {
    name: "Google Gmail Discovery",
    url: "https://gmail.googleapis.com/$discovery/rest?version=v1",
    heapCapMB: 1_024,
    timeoutMs: 180_000,
  },
  {
    name: "Google Drive Discovery",
    url: "https://www.googleapis.com/discovery/v1/apis/drive/v3/rest",
    heapCapMB: 1_024,
    timeoutMs: 180_000,
  },
  {
    name: "Stripe OpenAPI",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    heapCapMB: 2_048,
    timeoutMs: 300_000,
  },
  {
    name: "GitHub REST OpenAPI",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    heapCapMB: 2_048,
    timeoutMs: 600_000,
  },
];

function parseIterationCount(value: string | undefined): number {
  const parsed = value === undefined ? ITERATION_COUNT_DEFAULT : Number(value);
  assert.ok(Number.isInteger(parsed), "BENCHMARK_ITERATIONS must be an integer");
  assert.ok(parsed >= 1 && parsed <= 10, "BENCHMARK_ITERATIONS must be between 1 and 10");
  return parsed;
}

function runBenchmarkSpec(spec: BenchmarkSpec, iterationCount: number): Promise<BenchmarkResult> {
  assert.ok(spec.url.startsWith("https://"), `${spec.name} must use HTTPS`);
  assert.ok(spec.timeoutMs > 0 && spec.heapCapMB > 0, `${spec.name} limits must be positive`);

  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [
        "--expose-gc",
        `--max-old-space-size=${spec.heapCapMB}`,
        CHILD_SCRIPT,
        spec.name,
        spec.url,
        String(iterationCount),
      ],
      { timeout: spec.timeoutMs, maxBuffer: CHILD_OUTPUT_BYTES_MAX },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${spec.name}: ${stderr.trim() || error.message}`));
          return;
        }
        try {
          resolve(parseBenchmarkResult(stdout, spec.name));
        } catch (parseError) {
          reject(parseError);
        }
      },
    );
  });
}

function parseBenchmarkResult(output: string, expectedName: string): BenchmarkResult {
  assert.ok(output.length > 0, `${expectedName}: benchmark child returned no output`);
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("BENCHMARK_RESULT: "));
  assert.ok(line !== undefined, `${expectedName}: benchmark result line missing`);
  const result = JSON.parse(line.slice("BENCHMARK_RESULT: ".length)) as BenchmarkResult;
  assert.equal(result.name, expectedName, `${expectedName}: result name mismatch`);
  assert.ok(result.samplesMs.length === result.iterations, `${expectedName}: sample count mismatch`);
  return result;
}

function printBenchmarkResult(result: BenchmarkResult): void {
  assert.ok(result.bytes > 0, `${result.name}: bytes must be positive`);
  assert.ok(result.tools >= 0, `${result.name}: tools cannot be negative`);
  console.log(
    `${result.name}\n` +
      `  source:   ${(result.bytes / 1024 / 1024).toFixed(1)} MB\n` +
      `  format:   ${result.format}\n` +
      `  tools:    ${result.tools}\n` +
      `  fetch:    ${Math.round(result.fetchMs)}ms\n` +
      `  parse():  ${result.samplesMs.join(" / ")}ms ` +
      `(median ${result.medianMs}ms, p95 ${result.p95Ms}ms)\n` +
      `  heap:     ${result.heapUsedMB}MB`,
  );
}

async function main(): Promise<void> {
  const iterationCount = parseIterationCount(process.env.BENCHMARK_ITERATIONS);
  assert.ok(BENCHMARK_SPECS.length > 0, "benchmark suite cannot be empty");
  assert.ok(iterationCount >= 1, "benchmark must run at least once");

  console.log(
    `LIVE PERFORMANCE BENCHMARK — ${BENCHMARK_SPECS.length} latest upstream specs, ` +
      `${iterationCount} parse() iterations each\n`,
  );
  const failures: string[] = [];
  for (const spec of BENCHMARK_SPECS) {
    try {
      printBenchmarkResult(await runBenchmarkSpec(spec, iterationCount));
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(message);
      console.error(`${message}\n`);
    }
  }
  assert.ok(failures.length <= BENCHMARK_SPECS.length, "failure count invariant failed");
  if (failures.length > 0) {
    throw new Error(`${failures.length} benchmark case(s) failed`);
  }
  console.log("\nBENCHMARK COMPLETE");
}

main().catch((error: unknown) => {
  console.error(`BENCHMARK FAILED: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
