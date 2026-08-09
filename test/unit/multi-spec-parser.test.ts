import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";

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
    assert.throws(() => new MultiSpecParser({ spec: { url: 42 } as never }), /spec\.url must be a string/);
    assert.throws(() => new MultiSpecParser({ spec: { spec: "nope" } as never }), /spec\.spec must be a plain object/);
    assert.throws(() => new MultiSpecParser(undefined as never), /config object required/);
  });

  it("parses from a pre-parsed spec object", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const parsed = await parser.parse();
    assert.equal(parsed.operations.length, 3);
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
    const parsed = await parser.parse();
    assert.equal(parsed.specFormat, "openapi3");
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
