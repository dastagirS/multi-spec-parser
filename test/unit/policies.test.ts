/**
 * Unit tests for the 0.2.0 policy surface: compile-time blocking (1), response
 * processors (2), 401 retry (3), response truncation (4), extra parameters (5),
 * describeTools() (8), and option validation guards.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";
import { compileSpecToTools } from "../../src/factory.js";
import { parseSpec } from "../../src/parse-spec.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: {
          "200": {
            description: "ok",
            content: { "application/json": { schema: { $ref: "#/components/schemas/Pet" } } },
          },
        },
      },
      delete: {
        operationId: "deletePet",
        parameters: [{ name: "petId", in: "path", required: true, schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
    "/pets": {
      get: { operationId: "listPets", responses: { "200": { description: "ok" } } },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { $ref: "#/components/schemas/NewPet" } },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
  components: {
    schemas: {
      Pet: {
        type: "object",
        required: ["id", "name"],
        properties: { id: { type: "integer" }, name: { type: "string" } },
      },
      NewPet: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
    },
  },
};

function names(parser: MultiSpecParser): string[] {
  return parser.tools().map((t) => t.name).sort();
}

/** Start a local HTTP server, run fn, close it. */
async function withServer(
  handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void,
  fn: (port: number) => Promise<void>,
): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(port);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("filterOps (item 1 — open compile-time filter)", () => {
  it("excludes ops by exact name", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: { filterOps: (op) => op.toolName !== "deletePet" },
    });
    await parser.parse();
    assert.deepEqual(names(parser), ["createPet", "getPet", "listPets"]);
  });

  it("lets consumers apply their own matchers (regex/suffix)", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: { filterOps: (op) => !op.toolName.endsWith("Pet") },
    });
    await parser.parse();
    assert.deepEqual(names(parser), ["listPets"]);
  });

  it("readOnly is just a predicate on the HTTP method", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: { filterOps: (op) => !["POST", "PUT", "PATCH", "DELETE"].includes(op.method) },
    });
    await parser.parse();
    assert.deepEqual(names(parser), ["getPet", "listPets"]);
  });

  it("predicates compose and see operation metadata", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        filterOps: (op) =>
          !["POST", "PUT", "PATCH", "DELETE"].includes(op.method) &&
          !op.toolName.includes("list"),
      },
    });
    await parser.parse();
    assert.deepEqual(names(parser), ["getPet"]);
  });

  it("filtered ops consume no name slots (suffix stability)", async () => {
    const dup = {
      ...SPEC,
      paths: {
        ...SPEC.paths,
        "/again": {
          get: {
            operationId: "getPet",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parser = new MultiSpecParser({
      spec: { spec: dup },
      options: { filterOps: (op) => op.toolName !== "getPet" },
    });
    await parser.parse();
    // Both getPet ops are filtered; the duplicate never surfaces as getPet_1.
    assert.deepEqual(names(parser), ["createPet", "deletePet", "listPets"]);
  });

  it("a filtered op cannot be executed by name", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: { filterOps: (op) => op.toolName !== "deletePet" },
    });
    await parser.parse();
    assert.equal(parser.tool("deletePet"), undefined, "not listed");
    await assert.rejects(() => parser.execute("deletePet", {}), /unknown tool/);
  });
});

describe("extraParameterRules (item 5)", () => {
  it("matches operations and merges LLM-only fields", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        extraParameterRules: [
          {
            matches: (operation) => operation.method === "GET" && operation.path === "/pets/{petId}",
            parameters: [
              { name: "fileName", schema: { type: "string" }, description: "For storage." },
            ],
          },
        ],
      },
    });
    await parser.parse();
    const tool = parser.tool("getPet")!;
    const props = tool.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(props.fileName, { type: "string", description: "For storage." });
    const req = parser.buildRequest("getPet", { petId: "1", fileName: "a.pdf" });
    assert.ok(!req.url.includes("fileName"), "extra param never serialized");
    assert.equal(req.url, "https://api.example.com/v1/pets/1");
  });

  it("applies every matching rule in declaration order", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        extraParameterRules: [
          {
            matches: (operation) => operation.method === "GET",
            parameters: [{ name: "traceId", schema: { type: "string" } }],
          },
          {
            matches: (operation) => operation.path === "/pets",
            parameters: [{ name: "pageSize", schema: { type: "integer" } }],
          },
        ],
      },
    });
    await parser.parse();
    const listPets = parser.tool("listPets")!;
    const properties = listPets.inputSchema.properties as Record<string, unknown>;
    assert.ok(properties.traceId);
    assert.ok(properties.pageSize);
    const getPetProperties = parser.tool("getPet")!.inputSchema.properties as Record<string, unknown>;
    assert.equal(getPetProperties.pageSize, undefined);
  });

  it("pushes required extras into inputSchema.required", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        extraParameterRules: [
          {
            matches: (operation) => operation.method === "GET" && operation.path === "/pets",
            parameters: [{ name: "traceId", schema: { type: "string" }, required: true }],
          },
        ],
      },
    });
    await parser.parse();
    const tool = parser.tool("listPets")!;
    assert.ok((tool.inputSchema.required as string[]).includes("traceId"));
  });

  it("throws on a collision with a spec-declared input", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        extraParameterRules: [
          {
            matches: (operation) => operation.method === "GET",
            parameters: [{ name: "petId", schema: { type: "string" } }],
          },
        ],
      },
    });
    await assert.rejects(() => parser.parse(), /collides/);
  });

  it("throws on a malformed extraParameter", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        extraParameterRules: [
          { matches: () => true, parameters: [{ name: "" } as never] },
        ],
      },
    });
    await assert.rejects(() => parser.parse(), /extraParameterRules.*must be/);
  });

  it("throws when matching rules define the same extra field", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        extraParameterRules: [
          { matches: () => true, parameters: [{ name: "traceId", schema: { type: "string" } }] },
          { matches: () => true, parameters: [{ name: "traceId", schema: { type: "string" } }] },
        ],
      },
    });
    await assert.rejects(() => parser.parse(), /duplicate extraParameter/);
  });
});

describe("processors (item 2)", () => {
  it("transforms the result and receives ctx args", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ size: 5, data: "TVRJek5EVTJOelE9" }));
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            processors: [
              {
                matches: (tool) => tool.method === "GET" && tool.path === "/pets/{petId}",
                process: async (result, ctx) => {
                  assert.equal(ctx.args.petId, "7");
                  if (result.status !== "success") return result;
                  return { status: "success", data: { stripped: true }, httpStatus: 200 };
                },
              },
            ],
          },
        });
        await parser.parse();
        const res = await parser.execute("getPet", { petId: "7" });
        assert.deepEqual(res.data, { stripped: true });
      },
    );
  });

  it("a throwing processor degrades to an error result (never throws)", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end("{}");
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            processors: [
              {
                matches: (tool) => tool.name === "listPets",
                process: async () => {
                  throw new Error("s3 exploded");
                },
              },
            ],
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "error");
        assert.match(res.error ?? "", /s3 exploded/);
      },
    );
  });

  it("composes all matching processors in declaration order", async () => {
    const order: string[] = [];
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            processors: [
              {
                matches: (tool) => tool.method === "GET",
                process: async (result) => {
                  order.push("first");
                  return result.status === "success"
                    ? { ...result, data: { ...(result.data as object), first: true } }
                    : result;
                },
              },
              {
                matches: (tool) => tool.path.startsWith("/pets"),
                process: async (result) => {
                  order.push("second");
                  return result.status === "success"
                    ? { ...result, data: { ...(result.data as object), second: true } }
                    : result;
                },
              },
            ],
          },
        });
        await parser.parse();
        const result = await parser.execute("listPets", {});
        assert.deepEqual(order, ["first", "second"]);
        assert.deepEqual(result.data, { ok: true, first: true, second: true });
      },
    );
  });

  it("a matcher failure becomes an explicit error and stops the pipeline", async () => {
    let processed = false;
    await withServer(
      (req, res) => res.end("{}"),
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            processors: [
              {
                matches: () => { throw new Error("matcher exploded"); },
                process: async (result) => result,
              },
              {
                matches: () => true,
                process: async (result) => { processed = true; return result; },
              },
            ],
          },
        });
        await parser.parse();
        const result = await parser.execute("listPets", {});
        assert.equal(result.status, "error");
        assert.match(result.error ?? "", /matcher exploded/);
        assert.equal(processed, false);
      },
    );
  });

  it("a wrong-shaped processor return becomes an explicit error", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: 1 }));
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            processors: [
              {
                matches: (tool) => tool.name === "listPets",
                process: async () => "not-a-result" as never,
              },
            ],
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "error");
        assert.match(res.error ?? "", /invalid result/);
      },
    );
  });
});

describe("401 retry (item 3)", () => {
  it("retries once with the refreshed Authorization header", async () => {
    let requests = 0;
    const seenAuth: string[] = [];
    await withServer(
      (req, res) => {
        requests += 1;
        seenAuth.push(req.headers.authorization ?? "(none)");
        if (requests === 1) {
          res.statusCode = 401;
          res.end("expired");
          return;
        }
        res.setHeader("content-type", "application/json");
        res.end("{}");
      },
      async (port) => {
        let refreshes = 0;
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            headers: { Authorization: "Bearer stale" },
            onUnauthorized: async () => {
              refreshes += 1;
              return "Bearer fresh";
            },
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "success");
        assert.equal(refreshes, 1);
        assert.equal(requests, 2);
        assert.deepEqual(seenAuth, ["Bearer stale", "Bearer fresh"]);
      },
    );
  });

  it("maxAuthRetries: 0 disables the retry", async () => {
    let requests = 0;
    await withServer(
      (req, res) => {
        requests += 1;
        res.statusCode = 401;
        res.end("expired");
      },
      async (port) => {
        let refreshes = 0;
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            maxAuthRetries: 0,
            onUnauthorized: async () => {
              refreshes += 1;
              return "Bearer x";
            },
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "error");
        assert.equal(res.httpStatus, 401);
        assert.equal(refreshes, 0);
        assert.equal(requests, 1);
      },
    );
  });

  it("a failing refresher degrades to an error result without looping", async () => {
    let requests = 0;
    await withServer(
      (req, res) => {
        requests += 1;
        res.statusCode = 401;
        res.end("expired");
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            onUnauthorized: async () => {
              throw new Error("refresh failed");
            },
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "error");
        assert.match(res.error ?? "", /refresh failed/);
        assert.equal(requests, 1, "no retry after a failed refresh");
      },
    );
  });
});

describe("response truncation (item 4)", () => {
  it("truncates oversized results with a generic message", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ blob: "x".repeat(10_000) }));
      },
      async (port) => {
        const truncated: Array<[number, string]> = [];
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            maxResponseBytes: 1_000,
            onTruncate: (size, toolName) => truncated.push([size, toolName]),
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "truncated");
        assert.equal(res.toolName, "listPets");
        assert.ok((res.size ?? 0) > 10_000);
        assert.match(res.message ?? "", /exceeds the 1000-byte limit/);
        assert.equal(truncated.length, 1);
        assert.equal(truncated[0]![1], "listPets");
      },
    );
  });

  it("leaves under-budget results untouched", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ small: true }));
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: { baseUrl: `http://127.0.0.1:${port}`, maxResponseBytes: 1_000_000 },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "success");
      },
    );
  });

  it("runs after processors (a shrinking processor avoids truncation)", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ blob: "x".repeat(10_000) }));
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            maxResponseBytes: 1_000,
            processors: [
              {
                matches: (tool) => tool.method === "GET" && tool.path === "/pets",
                process: async (result) =>
                  result.status === "success"
                    ? { status: "success", data: { tiny: true }, httpStatus: 200 }
                    : result,
              },
            ],
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "success", "processor shrank the result below budget");
        assert.deepEqual(res.data, { tiny: true });
      },
    );
  });

  it("a throwing onTruncate hook is swallowed", async () => {
    await withServer(
      (req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ blob: "x".repeat(10_000) }));
      },
      async (port) => {
        const parser = new MultiSpecParser({
          spec: { spec: SPEC },
          options: {
            baseUrl: `http://127.0.0.1:${port}`,
            maxResponseBytes: 1_000,
            onTruncate: () => {
              throw new Error("hook boom");
            },
          },
        });
        await parser.parse();
        const res = await parser.execute("listPets", {});
        assert.equal(res.status, "truncated");
      },
    );
  });
});

describe("describeTools (item 8)", () => {
  it("keeps the full schema under budget; projects $defs to ref names over it", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } }); // 64KB default
    await parser.parse();
    const getPet = parser.describeTools().find((d) => d.name === "getPet")!;
    assert.equal(getPet.inputSchema.$refs, undefined, "under budget → full schema kept");
    assert.ok(getPet.outputSchema, "output contract included in describeTools");

    const tiny = new MultiSpecParser({
      spec: { spec: SPEC },
      options: { describeMaxBytes: 50 },
    });
    await tiny.parse();
    const bounded = tiny.describeTools().find((d) => d.name === "getPet")!;
    assert.ok(Array.isArray(bounded.inputSchema.$refs), "$defs replaced by ref names");
    assert.deepEqual(bounded.inputSchema.$refs, ["Pet"]);
    assert.equal(bounded.inputSchema.$defs, undefined);
  });

  it("defaults to a 64KB budget", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const described = parser.describeTools();
    assert.ok(described.length >= 4);
    for (const d of described) {
      assert.ok(JSON.stringify(d.inputSchema).length <= 64 * 1024);
    }
  });
});

describe("validate (item H1)", () => {
  it("returns { valid: true } for conforming args", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const res = await parser.validate("getPet", { petId: "7" });
    assert.deepEqual(res, { valid: true });
  });

  it("returns issues (never throws) for invalid args", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    // createPet requires body.name; missing it must fail cleanly.
    const res = await parser.validate("createPet", { body: {} });
    assert.equal(res.valid, false);
    if (!res.valid) {
      assert.ok(res.issues.some((i) => /name/i.test(i.message)));
    }
  });

  it("works for unknown tool names via the same resolution as execute", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    await assert.rejects(() => parser.validate("nope", {}), /unknown tool/);
  });
});

describe("option validation guards", () => {
  it("rejects malformed new options at construction", () => {
    for (const options of [
      { filterOps: "not a fn" },
      { processors: { x: "not a fn" } },
      { processors: [{ matches: "not a fn", process: async () => ({ status: "success", data: null, httpStatus: 200 }) }] },
      { extraParameterRules: {} },
      { onUnauthorized: "not a fn" },
      { maxAuthRetries: -1 },
      { maxResponseBytes: 0 },
      { describeMaxBytes: -5 },
      { defaultPolicy: "other" },
      { onTruncate: "not a fn" },
    ] as never[]) {
      assert.throws(
        () => new MultiSpecParser({ spec: { spec: SPEC }, options }),
        TypeError,
        `expected guard for ${JSON.stringify(options)}`,
      );
    }
  });

  it("rejects top-level config keys that belong inside options (fail loud, not silent)", () => {
    // The report.md bug: README once placed processors/extraParameterRules at
    // the top level; they'd be silently dropped. The guard turns that into an
    // immediate TypeError with a hint.
    for (const config of [
      { spec: { spec: SPEC }, processors: { x: async () => ({ status: "success" as const, data: null, httpStatus: 200 }) } },
      { spec: { spec: SPEC }, extraParameterRules: [{ matches: () => true, parameters: [] }] },
    ] as never[]) {
      assert.throws(
        () => new MultiSpecParser(config),
        /unknown config key "(processors|extraParameterRules)".*put it inside options/,
        `expected unknown-key guard for ${JSON.stringify(config)}`,
      );
    }
  });
});

describe("compile-time helpers stay coherent", () => {
  it("compileSpecToTools honors filtering and extras directly", () => {
    const parsed = parseSpec(SPEC);
    const { tools } = compileSpecToTools(parsed, {
      filterOps: (op) => !["POST", "PUT", "PATCH", "DELETE"].includes(op.method),
      extraParameterRules: [
      {
        matches: (operation) => operation.path === "/pets",
        parameters: [{ name: "traceId", schema: { type: "string" } }],
      },
    ],
    });
    assert.deepEqual(tools.map((t) => t.name).sort(), ["getPet", "listPets"]);
    const list = tools.find((t) => t.name === "listPets")!;
    assert.ok((list.inputSchema.properties as Record<string, unknown>).traceId);
  });
});
