import assert from "node:assert/strict";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";

const ITERATION_COUNT_DEFAULT = 3;
const FETCH_TIMEOUT_MS = 120_000;
const MAX_SPEC_BYTES = 100_000_000;
const RESULT_PREFIX = "BENCHMARK_RESULT: ";

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

interface ParseSample {
  elapsedMs: number;
  format: string;
  tools: number;
  heapUsedMB: number;
}

const [name, url, iterationText] = process.argv.slice(2);

async function fetchSpecText(sourceUrl: string): Promise<{ text: string; elapsedMs: number }> {
  assert.ok(sourceUrl.startsWith("https://"), "benchmark sources must use HTTPS");
  assert.ok(sourceUrl.length <= 512, "benchmark URL is unexpectedly long");

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(sourceUrl, {
      headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
      signal: controller.signal,
    });
    assert.equal(response.ok, true, `fetch failed: HTTP ${response.status}`);
    const text = await response.text();
    assert.ok(text.length > 0, "benchmark source returned an empty document");
    assert.ok(Buffer.byteLength(text) <= MAX_SPEC_BYTES, "benchmark document exceeds 100MB");
    return { text, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timeout);
  }
}

async function measureParse(text: string): Promise<ParseSample> {
  assert.ok(text.length > 0, "cannot benchmark an empty document");
  assert.ok(
    Buffer.byteLength(text) <= MAX_SPEC_BYTES,
    "document exceeds the benchmark size limit",
  );

  if (typeof global.gc === "function") global.gc();
  const started = performance.now();
  const parser = new MultiSpecParser({ spec: { text } });
  await parser.parse();
  const elapsedMs = performance.now() - started;
  const tools = parser.tools().length;
  assert.ok(Number.isFinite(elapsedMs), "parse timing must be finite");
  assert.ok(tools >= 0, "tool count cannot be negative");
  return {
    elapsedMs,
    format: parser.format,
    tools,
    heapUsedMB: process.memoryUsage().heapUsed / 1024 / 1024,
  };
}

function parseIterationCount(value: string | undefined): number {
  const parsed = value === undefined ? ITERATION_COUNT_DEFAULT : Number(value);
  assert.ok(Number.isInteger(parsed), "benchmark iterations must be an integer");
  assert.ok(parsed >= 1 && parsed <= 10, "benchmark iterations must be between 1 and 10");
  return parsed;
}

function percentile(samplesMs: number[], percentileValue: number): number {
  assert.ok(samplesMs.length > 0, "cannot calculate a percentile without samples");
  assert.ok(percentileValue >= 0 && percentileValue <= 100, "percentile must be 0..100");
  const sorted = [...samplesMs].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.ceil((percentileValue / 100) * sorted.length) - 1,
  );
  return sorted[Math.max(0, index)]!;
}

async function main(): Promise<void> {
  assert.ok(name !== undefined && name.length > 0, "benchmark name is required");
  assert.ok(url !== undefined && url.startsWith("https://"), "benchmark URL is required");
  const iterationCount = parseIterationCount(iterationText);

  const fetched = await fetchSpecText(url);
  const samples: ParseSample[] = [];
  for (let index = 0; index < iterationCount; index += 1) {
    samples.push(await measureParse(fetched.text));
  }
  const times = samples.map((sample) => sample.elapsedMs);
  const result: BenchmarkResult = {
    name,
    url,
    bytes: Buffer.byteLength(fetched.text),
    fetchMs: fetched.elapsedMs,
    iterations: iterationCount,
    samplesMs: times.map((value) => Math.round(value)),
    medianMs: Math.round(percentile(times, 50)),
    p95Ms: Math.round(percentile(times, 95)),
    format: samples[samples.length - 1]!.format,
    tools: samples[samples.length - 1]!.tools,
    heapUsedMB: Math.round(samples[samples.length - 1]!.heapUsedMB),
  };
  assert.equal(result.samplesMs.length, iterationCount);
  assert.ok(result.bytes > 0, "benchmark result must report document bytes");
  console.log(`${RESULT_PREFIX}${JSON.stringify(result)}`);
}

main().catch((error: unknown) => {
  console.error(`BENCHMARK_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
