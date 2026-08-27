/**
 * Battle suite: parse → compile → Ajv over real-world specs AND a synthetic
 * adversarial ladder (best case → worst case), each in a heap-capped child
 * process. Guards the machine: every spec runs under --max-old-space-size (a
 * regression like the old 1220×969 clone OOM dies in the child, not on the
 * host), with per-spec timeouts and a fail-fast watchdog.
 *
 * Ladder tiers, best → worst:
 *   minimal   — 1 op, no schemas (memory/time floor)
 *   typical   — small/mid specs, moderate schema sharing
 *   format    — urlencoded/multipart/octet-stream/multi-content/server-vars
 *   dangling  — refs to missing schemas (pruning + tracking must hold)
 *   cyclic    — schema ref cycles (closure must terminate)
 *   fanout    — every op refs 60 schemas under a tight maxDefsBytes cap
 *               (forces the whole-defs fallback deterministically)
 *   deep      — 200-level nested schema (recursion depth)
 *   massive   — 2500 ops × 1500 schemas (scale)
 *
 * Usage: node dist/test/battle.js   (npm run battle)
 * Exit code 0 = all gates passed.
 */

import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

interface SpecCase {
  name: string;
  file: string;
  expectedOps: number;
  heapCapMB: number;
  timeoutMs: number;
  /** Ladder tier for the report (best → worst ordering). */
  tier: string;
  /** Override the per-tool $defs cap inside the probe (fanout case). */
  maxDefsBytes?: number;
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
    tier: "typical (small)",
    defsBytesMaxBound: 200_000,
    defsBytesTotalBound: 2_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "swagger2 petstore (2.0 conversion)",
    file: "swagger2.json",
    expectedOps: 20,
    heapCapMB: 512,
    timeoutMs: 60_000,
    tier: "typical (2.0)",
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
    tier: "typical (ref-less)",
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
    tier: "typical (YAML path)",
    defsBytesMaxBound: 100_000,
    defsBytesTotalBound: 1_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "slack (Swagger 2.0, 174 ops — official Web API spec)",
    file: "slack.json",
    expectedOps: 174,
    heapCapMB: 512,
    timeoutMs: 60_000,
    tier: "heavy (2.0 formData)",
    defsBytesMaxBound: 100_000,
    defsBytesTotalBound: 1_000_000,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
  {
    name: "stripe (OAS 3.0.0, 1440 schemas)",
    file: "stripe.json",
    expectedOps: 594,
    heapCapMB: 1024,
    timeoutMs: 240_000,
    tier: "worst-case (schema graph)",
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
    expectedOps: 1221,
    heapCapMB: 1024,
    timeoutMs: 300_000,
    tier: "worst-case (scale)",
    defsBytesMaxBound: 200_000,
    defsBytesTotalBound: undefined,
    ajvFailuresBound: 0,
    refFailuresBound: 0,
  },
];

// ---------------------------------------------------------------------------
// Synthetic adversarial ladder (deterministic; generated in-process, written
// to the git-ignored fixtures dir so the existing child probe can read them).
// ---------------------------------------------------------------------------

function baseSpec(title: string): Record<string, unknown> {
  return { openapi: "3.0.3", info: { title, version: "1" } };
}

/** 1 op, no schemas, no refs — the memory/time floor. */
function syntheticMinimal(): Record<string, unknown> {
  return {
    ...baseSpec("Minimal"),
    servers: [{ url: "https://min.example.com" }],
    paths: {
      "/ping": {
        get: {
          operationId: "ping",
          responses: { "200": { description: "pong" } },
        },
      },
    },
  };
}

/** 40 ops across 8 resources, 25 schemas with a moderate chain. */
function syntheticTypical(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {};
  for (let i = 0; i < 25; i += 1) {
    schemas[`Model${i}`] = {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        ...(i > 0 ? { prev: { $ref: `#/components/schemas/Model${i - 1}` } } : {}),
      },
    };
  }
  const paths: Record<string, unknown> = {};
  for (let r = 0; r < 8; r += 1) {
    for (let m = 0; m < 5; m += 1) {
      paths[`/res${r}/items${m}/{id}`] = {
        get: {
          operationId: `res${r}_getItem${m}`,
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
            { name: "limit", in: "query", schema: { type: "integer" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: { $ref: `#/components/schemas/Model${(r * 3 + m) % 25}` },
                },
              },
            },
          },
        },
      };
    }
  }
  return { ...baseSpec("Typical"), components: { schemas }, paths };
}

/** Body-shape torture: urlencoded, multipart, octet-stream, multi-content,
 *  server variables, cookies. */
function syntheticFormat(): Record<string, unknown> {
  return {
    ...baseSpec("Format Torture"),
    servers: [{ url: "https://fmt.example.com/v1" }],
    paths: {
      "/upload": {
        post: {
          operationId: "uploadFile",
          parameters: [
            { name: "X-Token", in: "header", required: true, schema: { type: "string" } },
          ],
          requestBody: {
            required: true,
            content: {
              "multipart/form-data": {
                schema: {
                  type: "object",
                  required: ["file", "note"],
                  properties: {
                    file: { type: "string", format: "binary" },
                    note: { type: "string" },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/form": {
        post: {
          operationId: "submitForm",
          requestBody: {
            content: {
              "application/x-www-form-urlencoded": {
                schema: {
                  type: "object",
                  properties: {
                    a: { type: "string" },
                    b: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/raw": {
        post: {
          operationId: "uploadRaw",
          requestBody: {
            content: {
              "application/octet-stream": { schema: { type: "string", format: "binary" } },
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/multi": {
        post: {
          operationId: "multiContent",
          requestBody: {
            content: {
              "application/json": { schema: { type: "object" } },
              "application/xml": {},
            },
          },
          responses: { "200": { description: "ok" } },
        },
      },
      "/var/{id}": {
        get: {
          operationId: "withServerVars",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } },
          ],
          servers: [
            {
              url: "https://{region}.example.com/{version}",
              variables: { region: { default: "us" }, version: { default: "v1" } },
            },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/cookie": {
        get: {
          operationId: "withCookie",
          parameters: [
            { name: "session", in: "cookie", schema: { type: "string" } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  };
}

/** Dangling refs (nested + top-level + output) — pruning + tracking must hold. */
function syntheticDangling(): Record<string, unknown> {
  return {
    ...baseSpec("Dangling Refs"),
    components: {
      schemas: {
        Real: { type: "object", properties: { ok: { type: "boolean" } } },
      },
    },
    paths: {
      "/nested": {
        get: {
          operationId: "nestedDangling",
          parameters: [
            { name: "x", in: "query", schema: { $ref: "#/components/schemas/MissingNested" } },
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/MissingOutput" } },
              },
            },
          },
        },
      },
      "/top": {
        get: {
          operationId: "topDangling",
          parameters: [{ $ref: "#/components/parameters/MissingTop" }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/good": {
        get: {
          operationId: "goodRef",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Real" } },
              },
            },
          },
        },
      },
    },
  };
}

/** Schema ref cycles (A→B→A, self-ref, 10-cycle) — closure must terminate. */
function syntheticCyclic(): Record<string, unknown> {
  const schemas: Record<string, unknown> = {
    A: { type: "object", properties: { b: { $ref: "#/components/schemas/B" } } },
    B: {
      type: "object",
      properties: {
        a: { $ref: "#/components/schemas/A" },
        self: { $ref: "#/components/schemas/B" },
      },
    },
    Self: { type: "object", properties: { again: { $ref: "#/components/schemas/Self" } } },
  };
  for (let i = 0; i < 10; i += 1) {
    schemas[`Chain${i}`] = {
      type: "object",
      properties: { next: { $ref: `#/components/schemas/Chain${(i + 1) % 10}` } },
    };
  }
  const paths: Record<string, unknown> = {};
  for (let i = 0; i < 20; i += 1) {
    paths[`/cyc${i}`] = {
      get: {
        operationId: `cyc${i}`,
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": {
                schema: {
                  $ref: `#/components/schemas/${i % 2 === 0 ? "A" : `Chain${i % 10}`}`,
                },
              },
            },
          },
        },
      },
    };
  }
  return { ...baseSpec("Cyclic Refs"), components: { schemas }, paths };
}

/** 200 ops × 60 sizeable schemas each under a tight maxDefsBytes cap — forces
 *  the whole-defs fallback deterministically (Stripe does it organically). */
function syntheticFanout(): Record<string, unknown> {
  const SCHEMAS_PER_OP = 60;
  const OPS = 200;
  const schemas: Record<string, unknown> = {};
  for (let i = 0; i < 400; i += 1) {
    const properties: Record<string, unknown> = {};
    for (let p = 0; p < 25; p += 1) {
      properties[`p${p}`] = { type: "string", description: `property ${p} of schema ${i}` };
    }
    schemas[`S${i}`] = { type: "object", properties };
  }
  const paths: Record<string, unknown> = {};
  for (let o = 0; o < OPS; o += 1) {
    const refs: unknown[] = [];
    for (let k = 0; k < SCHEMAS_PER_OP; k += 1) {
      refs.push({ $ref: `#/components/schemas/S${(o * 13 + k * 7) % 400}` });
    }
    paths[`/fan${o}`] = {
      post: {
        operationId: `fan${o}`,
        requestBody: {
          content: {
            "application/json": {
              schema: { type: "object", properties: { item: { anyOf: refs } } },
            },
          },
        },
        responses: { "200": { description: "ok" } },
      },
    };
  }
  return { ...baseSpec("Fanout"), components: { schemas }, paths };
}

/** 200-level nested schema — recursion depth stays inside the child's stack. */
function syntheticDeep(): Record<string, unknown> {
  const DEPTH = 200;
  let schema: Record<string, unknown> = { type: "string" };
  for (let d = 0; d < DEPTH; d += 1) {
    schema = { type: "object", properties: { next: schema }, additionalProperties: false };
  }
  return {
    ...baseSpec("Deep Nesting"),
    components: { schemas: { Deep: schema } },
    paths: {
      "/deep": {
        get: {
          operationId: "deepGet",
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/Deep" } },
              },
            },
          },
        },
      },
    },
  };
}

/** 2500 ops × 1500 schemas — scale without pathological sharing. */
function syntheticMassive(): Record<string, unknown> {
  const OP_COUNT = 2500;
  const SCHEMA_COUNT = 1500;
  const schemas: Record<string, unknown> = {};
  for (let i = 0; i < SCHEMA_COUNT; i += 1) {
    schemas[`M${i}`] = {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "integer" },
        name: { type: "string" },
        ...(i > 0 ? { prev: { $ref: `#/components/schemas/M${i - 1}` } } : {}),
      },
    };
  }
  const paths: Record<string, unknown> = {};
  for (let o = 0; o < OP_COUNT; o += 1) {
    paths[`/mass${o}`] = {
      get: {
        operationId: `massOp${o}`,
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: `#/components/schemas/M${o % SCHEMA_COUNT}` } },
            },
          },
        },
      },
    };
  }
  return { ...baseSpec("Massive"), components: { schemas }, paths };
}

/** Google Discovery with media uploads — item 9 surface + Ajv gate (4 of 12
 *  ops are media-capable POSTs with simplePath, accept types, schema refs). */
function syntheticGoogleMedia(): Record<string, unknown> {
  const METHOD_COUNT = 12;
  const methods: Record<string, unknown> = {};
  for (let i = 0; i < METHOD_COUNT; i += 1) {
    const isMedia = i % 3 === 0;
    methods[`op${i}`] = {
      id: `media.items.op${i}`,
      path: `items/${i}`,
      httpMethod: isMedia ? "POST" : "GET",
      description: `op ${i}`,
      ...(isMedia
        ? {
            request: { $ref: `Item${i}` },
            supportsMediaUpload: true,
            mediaUpload: {
              accept: ["application/octet-stream"],
              protocols: { simple: { multipart: true, path: `/upload/items/${i}` } },
            },
          }
        : {}),
      response: { $ref: `Item${i}` },
    };
  }
  const schemas: Record<string, unknown> = {};
  for (let i = 0; i < METHOD_COUNT; i += 1) {
    schemas[`Item${i}`] = {
      type: "object",
      properties: { id: { type: "string" }, n: { type: "integer" } },
    };
  }
  return {
    kind: "discovery#restDescription",
    name: "media",
    version: "v1",
    title: "Media",
    rootUrl: "https://media.example.com/",
    servicePath: "v1/",
    resources: { items: { methods } },
    schemas,
  };
}

/** Build the synthetic ladder (best → worst) and write the spec files so the
 *  existing child probe can read them from the fixtures dir. */
function buildSyntheticSpecs(): SpecCase[] {
  const fixturesDir = fileURLToPath(new URL("../../test/fixtures", import.meta.url));
  mkdirSync(fixturesDir, { recursive: true });
  const entries: Array<{ file: string; build: () => Record<string, unknown>; spec: Omit<SpecCase, "file"> }> = [
    {
      file: "synthetic-minimal.json",
      build: syntheticMinimal,
      spec: {
        name: "synthetic minimal (1 op, 0 schemas)",
        expectedOps: 1,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "best-case (floor)",
        defsBytesMaxBound: 1_000,
        defsBytesTotalBound: 1_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-typical.json",
      build: syntheticTypical,
      spec: {
        name: "synthetic typical (40 ops, 25 schemas)",
        expectedOps: 40,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "typical",
        defsBytesMaxBound: 100_000,
        defsBytesTotalBound: 1_000_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-format.json",
      build: syntheticFormat,
      spec: {
        name: "synthetic format torture (6 ops, bodies+vars+cookies)",
        expectedOps: 6,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "format torture",
        defsBytesMaxBound: 10_000,
        defsBytesTotalBound: 50_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-dangling.json",
      build: syntheticDangling,
      spec: {
        name: "synthetic dangling refs (3 ops, must prune + track)",
        expectedOps: 3,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "dangling refs",
        defsBytesMaxBound: 10_000,
        defsBytesTotalBound: 30_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-cyclic.json",
      build: syntheticCyclic,
      spec: {
        name: "synthetic cyclic refs (20 ops, A→B→A / self / 10-cycle)",
        expectedOps: 20,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "cyclic refs",
        defsBytesMaxBound: 100_000,
        defsBytesTotalBound: 500_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-google-media.json",
      build: syntheticGoogleMedia,
      spec: {
        name: "synthetic google media (Discovery, 12 ops — 4 media uploads)",
        expectedOps: 12,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "google media (Discovery)",
        defsBytesMaxBound: 50_000,
        defsBytesTotalBound: 150_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-fanout.json",
      build: syntheticFanout,
      spec: {
        name: "synthetic fanout (200 ops × 60 schemas, 50KB defs cap → fallback)",
        expectedOps: 200,
        heapCapMB: 512,
        timeoutMs: 60_000,
        tier: "worst-case (closure fan-out)",
        maxDefsBytes: 50_000,
        // Whole-defs fallback is ~400KB of shared schemas.
        defsBytesMaxBound: 1_000_000,
        defsBytesTotalBound: undefined,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-deep.json",
      build: syntheticDeep,
      spec: {
        name: "synthetic deep nesting (1 op, 200 levels)",
        expectedOps: 1,
        heapCapMB: 256,
        timeoutMs: 30_000,
        tier: "deep nesting",
        defsBytesMaxBound: 100_000,
        defsBytesTotalBound: 100_000,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
    {
      file: "synthetic-massive.json",
      build: syntheticMassive,
      spec: {
        name: "synthetic massive (2500 ops, 1500 schemas, chain closures)",
        expectedOps: 2500,
        heapCapMB: 1024,
        timeoutMs: 240_000,
        tier: "worst-case (scale)",
        // Each M(i) refs M(i-1), so a tool referencing M(1499) legitimately
        // closes over the whole 1500-schema chain (~208KB) — same profile as
        // Stripe's graph; the 1MB cap keeps it from falling back.
        defsBytesMaxBound: 300_000,
        defsBytesTotalBound: undefined,
        ajvFailuresBound: 0,
        refFailuresBound: 0,
      },
    },
  ];
  for (const entry of entries) {
    writeFileSync(
      fileURLToPath(new URL(`../../test/fixtures/${entry.file}`, import.meta.url)),
      JSON.stringify(entry.build()),
    );
  }
  return entries.map((e) => ({ file: e.file, ...e.spec }));
}

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
    const argv = [
      `--max-old-space-size=${spec.heapCapMB}`,
      "--expose-gc",
      script,
      spec.file,
      String(spec.expectedOps),
    ];
    if (spec.maxDefsBytes !== undefined) argv.push(String(spec.maxDefsBytes));
    const child = execFile(process.execPath, argv, {
      timeout: spec.timeoutMs,
      maxBuffer: 1024 * 1024,
    }, (err, stdout, stderr) => {
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
    });
  });
}

async function main(): Promise<void> {
  const synthetic = buildSyntheticSpecs();
  const all = [...SPECS, ...synthetic];

  // Fixtures are git-ignored (re-fetchable upstream data); fail fast with an
  // actionable message instead of a confusing ENOENT from a child probe.
  // Synthetic specs were just written above, so only real ones are checked.
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
  console.log(
    `BATTLE SUITE — ${SPECS.length} real specs + ${synthetic.length} synthetic, best → worst, heap-capped children`,
  );
  console.log("=".repeat(88));

  let failures = 0;
  for (const spec of all) {
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

      console.log(`\n[${ok ? "PASS" : "FAIL"}] ${spec.name} (${dt}ms)  [${spec.tier}]`);
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
