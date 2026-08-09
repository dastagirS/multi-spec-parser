/**
 * Item 6: Standard Schema adapter — the open `~standard` protocol (Mastra,
 * Zod, Valibot, ArkType consumers) wrapped around a compiled tool's schema.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";
import { toStandardSchema } from "../../src/standard-schema.js";

const SPEC = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  paths: {
    "/pets": {
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                required: ["name"],
                properties: { name: { type: "string" }, age: { type: "integer" } },
                additionalProperties: false,
              },
            },
          },
        },
        responses: { "201": { description: "created" } },
      },
    },
  },
};

describe("toStandardSchema (item 6)", () => {
  it("wraps a tool as the ~standard protocol shape", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const tool = parser.tool("createPet")!;
    const std = toStandardSchema(tool) as {
      "~standard": { version: number; vendor: string; validate: (v: unknown) => unknown };
    };
    assert.equal(std["~standard"].version, 1);
    assert.equal(std["~standard"].vendor, "multi-spec-parser");
    assert.equal(typeof std["~standard"].validate, "function");
  });

  it("returns { value } for valid input and { issues } with messages for invalid", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const tool = parser.tool("createPet")!;
    const { validate } = toStandardSchema(tool)["~standard"];

    // The JSON request body nests under `body` in the tool schema.
    const ok = validate({ body: { name: "Rex", age: 3 } });
    assert.deepEqual(ok, { value: { body: { name: "Rex", age: 3 } } });

    const bad = validate({ body: { age: "not-a-number" } }) as {
      issues?: Array<{ message: string }>;
    };
    assert.ok(Array.isArray(bad.issues));
    assert.ok(bad.issues!.length > 0);
    assert.ok(bad.issues!.every((i) => typeof i.message === "string"));

    const missing = validate({ body: {} }) as { issues?: Array<{ message: string }> };
    assert.ok(missing.issues!.some((i) => /name/i.test(i.message)));
  });

  it("is stable across repeated calls on the same tool", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const tool = parser.tool("createPet")!;
    const a = toStandardSchema(tool);
    const b = toStandardSchema(tool);
    assert.equal(a, b, "same tool → same wrapped object (memoized)");
  });

  it("respects per-tool $defs closures (validates against referenced schemas)", async () => {
    const specWithRef = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/pets/{id}": {
          post: {
            operationId: "updatePet",
            parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
            requestBody: {
              required: true,
              content: {
                "application/json": { schema: { $ref: "#/components/schemas/NewPet" } },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
      components: {
        schemas: {
          NewPet: {
            type: "object",
            required: ["name"],
            properties: { name: { type: "string" } },
          },
        },
      },
    };
    const parser = new MultiSpecParser({ spec: { spec: specWithRef } });
    await parser.parse();
    const tool = parser.tool("updatePet")!;
    const { validate } = toStandardSchema(tool)["~standard"];
    assert.deepEqual(validate({ id: "1", body: { name: "ok" } }), {
      value: { id: "1", body: { name: "ok" } },
    });
    const bad = validate({ id: "1", body: {} }) as { issues?: Array<{ message: string }> };
    assert.ok(bad.issues!.some((i) => /name/i.test(i.message)));
  });
});
