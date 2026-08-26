import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";
import type { TransportRequest } from "../../src/request-builder.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          { name: "petId", in: "path", required: true, schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "ok",
            content: {
              "application/json": { schema: { $ref: "#/components/schemas/Pet" } },
            },
          },
        },
      },
    },
    "/pets": {
      get: {
        operationId: "listPets",
        responses: { "200": { description: "ok" } },
      },
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
      NewPet: {
        type: "object",
        required: ["name"],
        properties: { name: { type: "string" } },
      },
    },
  },
};

interface TestServer {
  url: string;
  hits: () => number;
  close: () => Promise<void>;
}

function startServer(): Promise<TestServer> {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (req.url === "/spec.json") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(SPEC));
    } else if (req.url === "/spec.yaml") {
      res.setHeader("content-type", "application/yaml");
      res.end("openapi: 3.0.3\ninfo: { title: T, version: '1' }\npaths:\n  /pets:\n    get:\n      operationId: listPets\n      responses:\n        '200': { description: ok }\n");
    } else if (req.url === "/v1/pets") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify([{ id: 1, name: "Rex" }]));
    } else if (req.url === "/v1/pets/missing") {
      res.statusCode = 404;
      res.end("nope");
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        hits: () => hits,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("MultiSpecParser", () => {
  let server: TestServer | undefined;
  after(async () => {
    await server?.close();
  });

  it("validates config: exactly one of url/text/spec", () => {
    assert.throws(() => new MultiSpecParser({ spec: {} as never }), /exactly one of \{url\}, \{text\}, \{spec\}/);
    assert.throws(
      () => new MultiSpecParser({ spec: { url: "x", text: "y" } as never }),
      /exactly one/,
    );
    assert.throws(() => new MultiSpecParser({ spec: { url: 42 } as never }), /spec\.url must be a non-empty string/);
    assert.throws(() => new MultiSpecParser({ spec: { spec: "nope" } as never }), /spec\.spec must be a plain object/);
    assert.throws(() => new MultiSpecParser(undefined as never), /config object required/);
  });

  it("validates empty source strings and options (JS consumers)", () => {
    assert.throws(() => new MultiSpecParser({ spec: { url: "" } }), /non-empty/);
    assert.throws(() => new MultiSpecParser({ spec: { text: "" } }), /non-empty/);
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { maxDefsBytes: -1 } }),
      /maxDefsBytes/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { baseUrl: 42 } as never }),
      /baseUrl/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { headers: "x" } as never }),
      /headers/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { executeTimeoutMs: 0 } }),
      /executeTimeoutMs/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { cache: { maxEntries: 0 } } }),
      /cache\.maxEntries/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { lazy: "yes" } as never }),
      /options\.lazy/,
    );
    // Valid options pass.
    new MultiSpecParser({
      spec: { spec: SPEC },
      options: { maxDefsBytes: 1000, baseUrl: "https://x", headers: { a: "b" }, executeTimeoutMs: 1000 },
    });
  });

  it("parses from a pre-parsed spec object", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const document = await parser.parse();
    // parse() returns the RAW document (typed to the input spec) — not the
    // normalized model. For object sources it is the same object passed in.
    assert.equal(document, SPEC);
    assert.equal(document.openapi, "3.0.3");
    assert.equal(parser.format, "openapi3");
    assert.equal(parser.baseUrl, "https://api.example.com/v1");
  });

  it("parses YAML text (content-sniffed, not extension-guessed)", async () => {
    const yaml = `
openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: ok }
`;
    const parser = new MultiSpecParser({ spec: { text: yaml } });
    const document = await parser.parse();
    assert.equal(document.openapi, "3.0.3");
    assert.equal(parser.tool("listPets")?.name, "listPets");
  });

  it("fetches a URL once and shares the content cache across instances", async () => {
    server = await startServer();
    const specUrl = `${server.url}/spec.json`;
    const first = new MultiSpecParser({ spec: { url: specUrl } });
    const second = new MultiSpecParser({ spec: { url: specUrl } });
    await first.parse();
    assert.equal(first.tools().length, 3);
    await second.parse(); // global content-addressed cache → no second fetch
    assert.equal(server.hits(), 1);
    await server.close();
    server = undefined;
  });

  it("deduplicates concurrent lazy URL loads without retaining a global source cache", async () => {
    server = await startServer();
    const specUrl = `${server.url}/spec.yaml`;
    const first = new MultiSpecParser({ spec: { url: specUrl }, options: { lazy: true } });
    const second = new MultiSpecParser({ spec: { url: specUrl }, options: { lazy: true } });
    await Promise.all([first.load(), second.load()]);
    assert.equal(server.hits(), 1);
    assert.equal(first.tool("listPets")?.name, second.tool("listPets")?.name);
    await server.close();
    server = undefined;
  });

  it("defers compilation with lazy mode while preserving eager tool results", async () => {
    let operationTransforms = 0;
    let requestBodyTransforms = 0;
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        lazy: true,
        transforms: {
          operation: (operation) => {
            operationTransforms += 1;
            return operation;
          },
          schema: (schema, context) => {
            if (context.kind === "request-body") requestBodyTransforms += 1;
            return schema;
          },
        },
      },
    });
    await parser.parse();
    assert.equal(operationTransforms, 3);
    assert.equal(requestBodyTransforms, 0);
    const firstTool = parser.tool("getPet");
    assert.ok(firstTool);
    assert.equal(operationTransforms, 6);
    assert.equal(requestBodyTransforms, 0);
    assert.strictEqual(parser.tool("getPet"), firstTool);
    assert.equal(parser.tool("does-not-exist"), undefined);
    assert.equal(requestBodyTransforms, 0);
    assert.ok(parser.tool("createPet"));
    assert.equal(requestBodyTransforms, 1);

    const eager = new MultiSpecParser({ spec: { spec: SPEC } });
    await eager.parse();
    assert.deepEqual(parser.tools(), eager.tools());
  });

  it("loads lazy YAML indexes without materializing the raw document", async () => {
    const yaml = `
openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: ok }
`;
    const parser = new MultiSpecParser({ spec: { text: yaml }, options: { lazy: true } });
    await parser.load();
    assert.equal(parser.format, "openapi3");
    assert.equal(parser.tool("listPets")?.path, "/pets");
  });

  it("loads lazy YAML tools from operation and reference fragments", async () => {
    const yaml = `
openapi: 3.0.3
info:
  title: T
  version: "1"
servers:
  - url: https://api.example.com
paths:
  /pets/{petId}:
    get:
      operationId: getPet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
components:
  schemas:
    Pet:
      type: object
      properties:
        name:
          type: string
`;
    const parser = new MultiSpecParser({ spec: { text: yaml }, options: { lazy: true } });
    await parser.parse();
    const tool = parser.tool("getPet");
    assert.ok(tool);
    assert.equal(tool.path, "/pets/{petId}");
    assert.equal((tool.inputSchema.$defs as Record<string, unknown>).Pet !== undefined, true);
  });

  it("supports compile, request, and response transforms", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        transforms: {
          operation: (operation) => ({ ...operation, description: "transformed" }),
          schema: (schema, context) => context.kind === "parameter"
            ? { ...schema, description: "parameter transformed" }
            : schema,
          request: (request, context) => ({
            ...request,
            headers: {
              ...request.headers,
              "X-Transform": context.runtimeContext === undefined ? "yes" : "wrong",
            },
          }),
          response: (result) => ({ ...result, data: { transformed: result.data } }),
        },
      },
    });
    await parser.parse();
    const request = parser.buildRequest("getPet", { petId: "one" });
    assert.equal(request.headers["X-Transform"], "yes");
    assert.equal(parser.tool("getPet")?.description, "transformed");
  });

  it("passes execution context through runtime hooks without cross-execution leakage", async () => {
    const requestContexts: unknown[] = [];
    const responseContexts: unknown[] = [];
    const matchContexts: unknown[] = [];
    const processContexts: unknown[] = [];
    const attempts: Record<"A" | "B", number> = { A: 0, B: 0 };
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        transforms: {
          request: (request, context) => {
            requestContexts.push(context.runtimeContext);
            return request;
          },
          response: (result, context) => {
            responseContexts.push(context.runtimeContext);
            return result;
          },
        },
        processors: [
          {
            matches: (_tool, context) => {
              matchContexts.push(context.runtimeContext);
              return true;
            },
            process: (result, context) => {
              processContexts.push(context.runtimeContext);
              assert.deepEqual(context.args, {});
              return result;
            },
          },
        ],
      },
    });
    await parser.parse();
    const contexts = {
      A: { userId: "user-a", dependency: "a" },
      B: { userId: "user-b", dependency: "b" },
    } as const;
    const executeForUser = async (user: "A" | "B") =>
      parser.execute("listPets", {}, {
        runtimeContext: contexts[user],
        transport: async (_request: TransportRequest) => {
          attempts[user] += 1;
          if (attempts[user] === 1) return new Response("expired", { status: 401 });
          return new Response(JSON.stringify({ user }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
        onUnauthorized: () => `Bearer ${user}-fresh`,
      });
    const [resultA, resultB] = await Promise.all([executeForUser("A"), executeForUser("B")]);
    assert.equal(resultA.status, "success");
    assert.equal(resultB.status, "success");
    assert.equal(requestContexts.filter((context) => context === contexts.A).length, 2);
    assert.equal(requestContexts.filter((context) => context === contexts.B).length, 2);
    for (const observed of [responseContexts, matchContexts, processContexts]) {
      assert.equal(observed.filter((context) => context === contexts.A).length, 1);
      assert.equal(observed.filter((context) => context === contexts.B).length, 1);
    }
  });

  it("uses the optional custom transport and keeps the default when omitted", async () => {
    const calls: string[] = [];
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        transport: async (request) => {
          calls.push(request.url);
          return new Response(JSON.stringify({ custom: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        },
      },
    });
    await parser.parse();
    const result = await parser.execute("listPets", {});
    assert.equal(result.status, "success");
    assert.deepEqual(result.data, { custom: true });
    assert.deepEqual(calls, ["https://api.example.com/v1/pets"]);
  });

  it("supports parser cancellation and cache controls", async () => {
    const controller = new AbortController();
    controller.abort();
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await assert.rejects(parser.parse({ signal: controller.signal }), /parse aborted/);
    server = await startServer();
    const specUrl = `${server.url}/spec.json`;
    const first = new MultiSpecParser({ spec: { url: specUrl }, options: { cache: { enabled: false } } });
    const second = new MultiSpecParser({ spec: { url: specUrl }, options: { cache: { enabled: false } } });
    first.clearCache();
    await first.parse();
    await second.parse();
    assert.equal(server.hits(), 2);
    assert.equal(first.cacheStats().textEntries, 0);
    first.clearCache();
    await server.close();
    server = undefined;
  });

  it("throws a helpful error when used before parse()", () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    assert.throws(() => parser.tools(), /call await parser\.parse\(\)/);
    assert.throws(() => parser.format, /call await parser\.parse\(\)/);
    assert.throws(() => parser.buildRequest("getPet", {}), /call await parser\.parse\(\)/);
  });

  it("exposes tools, tool lookup, defs, and output schemas", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    assert.deepEqual(Object.keys(parser.defs).sort(), ["NewPet", "Pet"]);
    assert.equal(parser.tools().length, 3);
    assert.equal(parser.tool("getPet")?.method, "GET");
    assert.equal(parser.tool("nope"), undefined);
    assert.throws(() => parser.buildRequest("nope", {}), /unknown tool "nope"/);
    assert.deepEqual(parser.outputSchema("getPet"), { $ref: "#/$defs/Pet" });
    assert.equal(parser.operation("getPet").path, "/pets/{petId}");
  });

  it("exposes a combined Standard Schema adapter through the parser", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const tool = parser.tool("createPet")!;
    const schema = parser.toStandardSchema(tool);
    assert.equal(schema, parser.toStandardSchema("createPet"));
    const valid = await schema["~standard"].validate({ body: { name: "Rex" } });
    assert.deepEqual(valid, { value: { body: { name: "Rex" } } });
    const inputSchema = schema["~standard"].jsonSchema.input({ target: "draft-07" });
    assert.equal(inputSchema.$schema, "http://json-schema.org/draft-07/schema#");
    assert.ok(inputSchema.definitions);
  });

  it("applies configured defaults to validation and execution without mutating args", async () => {
    const spec = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      servers: [{ url: "https://api.example.com" }],
      paths: {
        "/users": {
          get: {
            operationId: "getUserWithDefault",
            parameters: [{ name: "userId", in: "query", required: true, schema: { type: "string", default: "me" } }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    let requestUrl = "";
    const parser = new MultiSpecParser({
      spec: { spec },
      options: {
        defaultPolicy: "apply",
        transport: async (request) => {
          requestUrl = request.url;
          return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
        },
      },
    });
    await parser.parse();
    const input: Record<string, unknown> = {};
    const validation = await parser.validate("getUserWithDefault", input);
    assert.deepEqual(validation, { valid: true, value: { userId: "me" } });
    assert.deepEqual(input, {});
    const standard = parser.toStandardSchema("getUserWithDefault");
    const standardValidation = await standard["~standard"].validate(input);
    assert.deepEqual(standardValidation, { value: { userId: "me" } });
    assert.equal(standard["~standard"].jsonSchema.input({ target: "draft-2020-12" }).required, undefined);
    const result = await parser.execute("getUserWithDefault", input);
    assert.equal(result.status, "success");
    assert.equal(requestUrl, "https://api.example.com/users?userId=me");
  });

  it("applies config baseUrl/headers as buildRequest defaults, per-call wins", async () => {
    const parser = new MultiSpecParser({
      spec: { spec: SPEC },
      options: {
        baseUrl: "https://override.example.com",
        headers: { Authorization: "Bearer abc" },
      },
    });
    await parser.parse();
    const req = parser.buildRequest("listPets", {});
    assert.equal(req.url, "https://override.example.com/pets");
    assert.equal(req.headers.Authorization, "Bearer abc");
    const overridden = parser.buildRequest("listPets", {}, { baseUrl: "https://other.example.com", headers: { "X-Extra": "1" } });
    assert.equal(overridden.url, "https://other.example.com/pets");
    assert.equal(overridden.headers.Authorization, "Bearer abc"); // merged, not replaced
    assert.equal(overridden.headers["X-Extra"], "1");
  });

  it("tools() returns a copy — mutating it can't corrupt the parser", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const first = parser.tools();
    first.length = 0;
    assert.equal(parser.tools().length, 3);
  });

  it("executes against a live local server: success and error shapes", async () => {
    server = await startServer();
    const parser = new MultiSpecParser({
      spec: { url: `${server.url}/spec.json` },
      options: { baseUrl: `${server.url}/v1` }, // matches the spec's /v1 prefix
    });
    await parser.parse();
    const ok = await parser.execute("listPets", {});
    assert.equal(ok.status, "success");
    assert.equal(ok.httpStatus, 200);
    assert.deepEqual(ok.data, [{ id: 1, name: "Rex" }]);
    const err = await parser.execute("getPet", { petId: "missing" });
    assert.equal(err.status, "error");
    assert.equal(err.httpStatus, 404);
    assert.equal(err.error, "nope"); // server's message is surfaced
    await server.close();
    server = undefined;
  });
});
