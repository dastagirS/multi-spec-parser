import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

import { MultiSpecParser } from "../../src/index.js";

const COMPLEX_YAML = `---
openapi: 3.0.3
info:
    title: Lazy parity
    version: "1"
servers:
    - url: https://api.example.com/v1
security:
    - oauth: [read]
paths:
    x-domain: pets
    "/pets:search/{petId}":
        parameters:
            - $ref: "#/components/parameters/PetId"
        patch:
            operationId: duplicate.name
            description: |-
                This description contains scanner lookalikes:
                /not-a-path:
                    get:
                        operationId: notARealOperation
            requestBody:
                $ref: "#/components/requestBodies/PetUpdate"
            responses:
                "200":
                    $ref: "#/components/responses/PetResponse"
        post:
            operationId: duplicate.name
            responses:
                "200":
                    $ref: "#/components/responses/PetResponse"
components:
    parameters:
        PetId:
            name: petId
            in: path
            required: true
            schema:
                type: string
    requestBodies:
        PetUpdate:
            required: true
            content:
                application/json:
                    schema:
                        $ref: "#/components/schemas/PetUpdate"
    responses:
        PetResponse:
            description: ok
            content:
                application/json:
                    schema:
                        $ref: "#/components/schemas/Pet"
    schemas:
        PetUpdate:
            type: object
            properties:
                friend:
                    $ref: "#/components/schemas/Pet"
        Pet:
            type: object
            properties:
                parent:
                    $ref: "#/components/schemas/Pet"
                name:
                    type: string
`;

const SIMPLE_YAML = `
openapi: 3.0.3
info: { title: T, version: "1" }
paths:
  /pets:
    get:
      operationId: listPets
      responses:
        "200": { description: ok }
`;

describe("lazy source loading", () => {
  it("matches eager compilation with variable indentation, block scalars, and recursive refs", async () => {
    const eager = new MultiSpecParser({ spec: { text: COMPLEX_YAML } });
    const lazy = new MultiSpecParser({ spec: { text: COMPLEX_YAML.replaceAll("\n", "\r\n") }, options: { lazy: true } });
    await eager.parse();
    await lazy.load();

    const eagerTools = eager.tools();
    assert.deepEqual(eagerTools.map((tool) => tool.name), ["duplicate_name", "duplicate_name_1"]);
    for (const eagerTool of eagerTools) {
      assert.deepEqual(lazy.tool(eagerTool.name), eagerTool);
      assert.strictEqual(lazy.tool(eagerTool.name), lazy.tool(eagerTool.name));
    }
    assert.equal(lazy.tool("notARealOperation"), undefined);
    assert.equal(lazy.baseUrl, eager.baseUrl);
    assert.deepEqual(lazy.tools(), eagerTools);
    assert.deepEqual(lazy.defs, eager.defs);
  });

  it("matches every eager tool in the real Booking YAML fixture", async () => {
    const source = await readFile(new URL("../../../test/fixtures/booking.yaml", import.meta.url), "utf8");
    const eager = new MultiSpecParser({ spec: { text: source } });
    const lazy = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    await eager.parse();
    await lazy.load();
    const eagerTools = eager.tools();
    assert.equal(eagerTools.length, 39);
    for (const eagerTool of eagerTools) assert.deepEqual(lazy.tool(eagerTool.name), eagerTool);
    assert.equal(lazy.tool("missing_booking_tool"), undefined);
  });

  it("preserves valid operation IDs longer than 1,024 characters", async () => {
    const operationId = "x".repeat(1_025);
    const source = SIMPLE_YAML.replace("listPets", operationId);
    const eager = new MultiSpecParser({ spec: { text: source } });
    const lazy = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    await eager.parse();
    await lazy.load();
    assert.equal(eager.tool(operationId)?.name, operationId);
    assert.equal(lazy.tool(operationId)?.name, operationId);
  });

  it("rejects YAML document streams consistently in parse() and load()", async () => {
    const source = `${SIMPLE_YAML}---\n${SIMPLE_YAML.replaceAll("listPets", "secondTool")}`;
    const eager = new MultiSpecParser({ spec: { text: source } });
    const lazyLoad = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    const lazyParse = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    await assert.rejects(eager.parse(), /Multiple YAML documents/);
    await assert.rejects(lazyLoad.load(), /requires an indexable OpenAPI YAML source/);
    await assert.rejects(lazyParse.parse(), /Multiple YAML documents/);
  });

  it("falls back safely for block-scalar operation IDs", async () => {
    const source = SIMPLE_YAML.replace("operationId: listPets", "operationId: >-\n        listPets");
    const strict = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    const fallback = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    await assert.rejects(strict.load(), /requires an indexable OpenAPI YAML source/);
    await fallback.parse();
    assert.equal(fallback.tool("listPets")?.name, "listPets");
    assert.equal(fallback.tool("unnamed"), undefined);
  });

  it("preserves tool identity across full lazy materialization", async () => {
    const materializeFirst = new MultiSpecParser({ spec: { text: SIMPLE_YAML }, options: { lazy: true } });
    await materializeFirst.load();
    assert.strictEqual(materializeFirst.tools()[0], materializeFirst.tool("listPets"));

    const toolFirst = new MultiSpecParser({ spec: { text: SIMPLE_YAML }, options: { lazy: true } });
    await toolFirst.load();
    const cached = toolFirst.tool("listPets");
    assert.strictEqual(toolFirst.tools()[0], cached);
    assert.strictEqual(toolFirst.tool("listPets"), cached);
  });

  it("falls back to full materialization for lazy JSON parse()", async () => {
    const source = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "JSON", version: "1" },
      paths: {
        "/items": {
          get: { operationId: "listItems", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const parser = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    const document = await parser.parse();
    assert.equal(document.openapi, "3.0.3");
    assert.equal(parser.tool("listItems")?.operationKey, "GET /items");
  });

  it("keeps load() strict when a source cannot honor the low-memory contract", async () => {
    const source = JSON.stringify({
      openapi: "3.0.3",
      info: { title: "JSON", version: "1" },
      paths: {},
    });
    const parser = new MultiSpecParser({ spec: { text: source }, options: { lazy: true } });
    await assert.rejects(parser.load(), /requires an indexable OpenAPI YAML source/);
    assert.throws(() => parser.tool("missing"), /parse\(\)/);
  });

  it("uses full parsing for operation hooks while preserving lazy tool caching", async () => {
    let transformCount = 0;
    const parser = new MultiSpecParser({
      spec: { text: COMPLEX_YAML },
      options: {
        lazy: true,
        filterOps: (operation) => operation.method === "POST",
        transforms: {
          operation: (operation) => {
            transformCount += 1;
            return { ...operation, toolName: `allowed_${operation.toolName}` };
          },
        },
      },
    });
    await parser.parse();
    assert.equal(parser.tool("allowed_duplicate_name")?.method, "POST");
    const countAfterCompile = transformCount;
    assert.strictEqual(parser.tool("allowed_duplicate_name"), parser.tool("allowed_duplicate_name"));
    assert.equal(transformCount, countAfterCompile);
  });
});
