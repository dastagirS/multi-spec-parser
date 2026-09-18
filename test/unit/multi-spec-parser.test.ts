import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";
import type { CompiledOperation } from "../../src/operation-compiler.js";
import { getCanonicalOperationSchema } from "../../src/operation-schema.js";

function canonicalOperation(operation: CompiledOperation | undefined): unknown {
  assert(operation !== undefined, "compiled operation must exist");
  assert(operation.input !== null && typeof operation.input === "object", "compiled operation input must exist");
  const { input, output, ...metadata } = operation;
  return {
    ...metadata,
    input: getCanonicalOperationSchema(input),
    output: output ? getCanonicalOperationSchema(output) : undefined,
  };
}

const LAZY_SPEC_TEXT = `openapi: 3.0.3
info:
  title: Lazy test
  version: "1"
servers:
  - url: https://api.example.com/v2
paths:
  /pets/{petId}:
    parameters:
      - name: petId
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getPet
      responses:
        "200":
          description: ok
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/Pet"
  /owners/{ownerId}:
    get:
      operationId: getPet
      parameters:
        - name: ownerId
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: ok
components:
  schemas:
    Pet:
      allOf:
        - $ref: "#/components/schemas/Named"
        - type: object
          required: [id]
          properties:
            id:
              type: integer
    Named:
      type: object
      required: [name]
      properties:
        name:
          type: string
`;

const SWAGGER_SPEC = {
  swagger: "2.0",
  info: { title: "Swagger lazy test", version: "1" },
  host: "api.example.com",
  basePath: "/v1",
  schemes: ["https"],
  parameters: {
    PetId: { name: "petId", in: "path", required: true, type: "string" },
  },
  responses: {
    PetResponse: { description: "ok", schema: { $ref: "#/definitions/Pet" } },
  },
  paths: {
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [{ $ref: "#/parameters/PetId" }],
        responses: { "200": { $ref: "#/responses/PetResponse" } },
      },
    },
  },
  definitions: {
    Pet: {
      type: "object",
      properties: { owner: { $ref: "#/definitions/Owner" } },
    },
    Owner: { type: "object", properties: { name: { type: "string" } } },
  },
};

const GOOGLE_SPEC = {
  kind: "discovery#restDescription",
  name: "pets",
  version: "v1",
  title: "Google lazy test",
  rootUrl: "https://pets.googleapis.com/",
  servicePath: "v1/",
  parameters: {
    prettyPrint: { type: "boolean", location: "query", default: "true" },
  },
  resources: {
    owners: {
      resources: {
        pets: {
          methods: {
            get: {
              id: "pets.owners.pets.get",
              path: "owners/{ownerId}/pets/{petId}",
              httpMethod: "GET",
              parameters: {
                ownerId: { type: "string", location: "path", required: true },
                petId: { type: "string", location: "path", required: true },
              },
              response: { $ref: "Pet" },
            },
          },
        },
      },
    },
  },
  schemas: {
    Pet: { type: "object", properties: { owner: { $ref: "Owner" } } },
    Owner: { type: "object", properties: { name: { type: "string" } } },
  },
};

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

describe("MultiSpecParser", () => {
  it("accepts exactly one URL, object, or text source", async () => {
    assert.throws(
      () => new MultiSpecParser({ spec: {} as never }),
      /exactly one of \{ url \}, \{ text \}, or \{ spec \}/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { text: "x", spec: SPEC } as never }),
      /exactly one/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { url: "" } }),
      /non-empty/,
    );
    assert.throws(
      () => new MultiSpecParser({ spec: { text: "" } }),
      /non-empty/,
    );
  });

  it("rejects removed and unknown policy options", async () => {
    for (const options of [
      { transport: () => undefined },
      { processors: [] },
      { extraParameterRules: [] },
      { transforms: {} },
      { cache: {} },
    ] as never[]) {
      assert.throws(
        () => new MultiSpecParser({ spec: { spec: SPEC }, options }),
        /unknown option/,
      );
    }
    assert.throws(
      () => new MultiSpecParser({ spec: { spec: SPEC }, options: { lazy: true } }),
      /lazy supports only \{ url \} sources/,
    );
  });

  it("parses an object source without mutating the caller-owned document", async () => {
    const before = structuredClone(SPEC);
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const operations = await parser.parse();
    assert.equal(operations.length, 3);
    assert.deepEqual(SPEC, before);
    assert.equal(parser.format, "openapi3");
    assert.equal(parser.baseUrl, "https://api.example.com/v1");
  });

  it("loads a URL once per parser instance", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(SPEC));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const parser = new MultiSpecParser({
        spec: { url: `http://127.0.0.1:${port}/openapi.json` },
      });
      const first = await parser.parse();
      const second = await parser.parse();
      assert.equal(first.length, 3);
      assert.equal(second.length, 3);
      assert.equal(requestCount, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects non-HTTP source URLs", async () => {
    const parser = new MultiSpecParser({ spec: { url: "file:///tmp/openapi.json" } });
    await assert.rejects(parser.parse(), /must use http or https/);
  });

  it("indexes a YAML URL on disk and materializes operations on demand", async () => {
    let requestCount = 0;
    const server = createServer((_request, response) => {
      requestCount += 1;
      response.setHeader("content-type", "application/yaml");
      response.end(LAZY_SPEC_TEXT);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const parser = new MultiSpecParser({
      spec: { url: `http://127.0.0.1:${port}/openapi.yaml` },
      options: { lazy: true },
    });
    try {
      assert.throws(() => parser.operationNames(), /call parser\.load/);
      await Promise.all([parser.load(), parser.load()]);
      assert.equal(requestCount, 1);
      assert.equal(parser.format, "openapi3");
      assert.equal(parser.baseUrl, "https://api.example.com/v2");
      assert.deepEqual(parser.operationNames(), ["getPet", "getPet_1"]);

      const operation = await parser.getOperation("getPet");
      assert.ok(operation);
      assert.equal(operation.path, "/pets/{petId}");
      assert.ok(operation.output?.definitions.Pet);
      assert.ok(operation.output?.definitions.Named);
      assert.strictEqual(operation, await parser.getOperation("getPet"));
      assert.equal(await parser.getOperation("missing"), undefined);

      const eager = new MultiSpecParser({ spec: { text: LAZY_SPEC_TEXT } });
      await eager.parse();
      assert.deepEqual(canonicalOperation(operation), canonicalOperation(await eager.getOperation("getPet")));
      assert.deepEqual(
        canonicalOperation(await parser.getOperation("getPet_1")),
        canonicalOperation(await eager.getOperation("getPet_1")),
      );
      await assert.rejects(parser.parse(), /unavailable in lazy mode/);
    } finally {
      await parser.close();
      await parser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    await assert.rejects(parser.getOperation("getPet"), /parser is closed/);
    assert.throws(() => parser.operationNames(), /parser is closed/);
  });

  it("indexes JSON URLs for every canonical format with eager parity", async () => {
    const documents = new Map<string, Record<string, unknown>>([
      ["/openapi.json", SPEC],
      ["/openapi-bom.json", SPEC],
      ["/swagger.json", SWAGGER_SPEC],
      ["/discovery.json", GOOGLE_SPEC],
    ]);
    const server = createServer((request, response) => {
      const document = documents.get(request.url ?? "");
      if (!document) {
        response.statusCode = 404;
        response.end();
        return;
      }
      response.setHeader("content-type", "application/json");
      response.end(`${request.url === "/openapi-bom.json" ? "\uFEFF" : ""}${JSON.stringify(document)}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const [path, document] of documents) {
        const lazy = new MultiSpecParser({
          spec: { url: `http://127.0.0.1:${port}${path}` },
          options: { lazy: true },
        });
        const eager = new MultiSpecParser({ spec: { spec: document } });
        try {
          await lazy.load();
          await eager.parse();
          assert.deepEqual(lazy.operationNames(), eager.operationNames());
          assert.equal(lazy.format, eager.format);
          assert.equal(lazy.baseUrl, eager.baseUrl);
          for (const name of lazy.operationNames()) {
            assert.deepEqual(
              canonicalOperation(await lazy.getOperation(name)),
              canonicalOperation(await eager.getOperation(name)),
            );
          }
        } finally {
          await lazy.close();
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("rejects malformed and unsupported JSON without eager fallback", async () => {
    const sources = new Map([
      ["/malformed.json", '{"openapi":"3.0.3","paths":'],
      ["/unsupported.json", '{"name":"not-an-api"}'],
    ]);
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(sources.get(request.url ?? "") ?? "{}");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      for (const [path] of sources) {
        const parser = new MultiSpecParser({
          spec: { url: `http://127.0.0.1:${port}${path}` },
          options: { lazy: true },
        });
        try {
          await assert.rejects(parser.load(), /invalid JSON lazy source|supports only OpenAPI/);
        } finally {
          await parser.close();
        }
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("parses YAML text by content", async () => {
    const parser = new MultiSpecParser({
      spec: {
        text: `
openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: ok }
`,
      },
    });
    await parser.parse();
    assert.equal(parser.format, "openapi3");
    assert.equal((await parser.getOperation("listPets"))?.path, "/pets");
  });

  it("projects normalized operations with explicit schema handles", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const operations = await parser.parse();
    assert.equal(operations.length, 3);
    const getPet = await parser.getOperation("getPet");
    assert.ok(getPet);
    assert.equal(getPet.method, "GET");
    assert.equal(getPet.output?.type, "Pet");
    assert.ok(getPet.output?.definitions.Pet);
    assert.equal("inputSchema" in getPet, false);
    assert.equal("outputSchema" in getPet, false);
    assert.equal("operation" in parser, false);
  });

  it("rejects removed compact projection options", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await assert.rejects(
      parser.parse({ compact: true } as never),
      /unknown key/,
    );
  });

  it("returns a copy of the operation collection", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const operations = await parser.parse();
    operations.length = 0;
    assert.equal((await parser.parse()).length, 3);
  });

  it("exposes bounded TypeScript schema handles", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const operation = (await parser.parse()).find((candidate) => candidate.name === "getPet")!;
    assert.match(operation.input.type, /^\{/);
    assert.equal(operation.output?.type, "Pet");
    assert.ok(operation.output?.definitions.Pet);
  });

  it("memoizes canonical operations while returning collection copies", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    const [first, second] = await Promise.all([parser.parse(), parser.parse()]);
    assert.notStrictEqual(first, second);
    assert.strictEqual(first[0], second[0]);
    assert.strictEqual(await parser.getOperation("getPet"), await parser.getOperation("getPet"));
  });

  it("adapts operation schemas to Standard Schema", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const adapter = parser.toStandardSchema("createPet");
    assert.strictEqual(adapter, parser.toStandardSchema("createPet"));
    assert.deepEqual(
      await adapter.validate({ body: { name: "Rex" } }),
      { value: { body: { name: "Rex" } } },
    );
    const input = adapter.input("draft-07");
    assert.equal(input.$schema, "http://json-schema.org/draft-07/schema#");
    assert.ok(input.definitions);
    const output = parser.toStandardSchema("getPet").output();
    assert.equal(output.$schema, "https://json-schema.org/draft/2020-12/schema");
  });

  it("fails clearly before parse and for unknown operations", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    assert.throws(() => parser.format, /call parser\.parse/);
    await parser.parse();
    assert.equal(await parser.getOperation("missing"), undefined);
    assert.throws(() => parser.toStandardSchema("missing"), /unknown operation/);
  });
});
