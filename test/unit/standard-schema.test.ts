/**
 * Item 6: Standard Schema adapter — the open `~standard` protocol (Mastra,
 * Zod, Valibot, ArkType consumers) wrapped around a compiled tool's schema.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { MultiSpecParser } from "../../src/multi-spec-parser.js";
import { toStandardSchema } from "../../src/standard-schema.js";

const DEFAULT_SPEC = {
  openapi: "3.0.3",
  info: { title: "T", version: "1" },
  paths: {
    "/users": {
      get: {
        operationId: "getUser",
        parameters: [{ name: "userId", in: "query", required: true, schema: { type: "string", default: "me" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
};

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
    const std = toStandardSchema(tool);
    assert.equal(std["~standard"].version, 1);
    assert.equal(std["~standard"].vendor, "multi-spec-parser");
    assert.equal(typeof std["~standard"].validate, "function");
    assert.equal(typeof std["~standard"].jsonSchema.input, "function");
    assert.equal(typeof std["~standard"].jsonSchema.output, "function");
    const draft07 = std["~standard"].jsonSchema.input({ target: "draft-07" });
    assert.equal(draft07.$schema, "http://json-schema.org/draft-07/schema#");
    const draft2020 = std["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    assert.equal(draft2020.$schema, "https://json-schema.org/draft/2020-12/schema");
  });

  it("enforces OpenAPI formats consistently without Ajv warnings", async () => {
    const formatSpec = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/formats": {
          get: {
            operationId: "formatCheck",
            parameters: [
              { name: "count", in: "query", required: true, schema: { type: "integer", format: "int32" } },
              { name: "payload", in: "query", required: true, schema: { type: "string", format: "byte" } },
              { name: "when", in: "query", required: true, schema: { type: "string", format: "date-time" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parser = new MultiSpecParser({ spec: { spec: formatSpec } });
    await parser.parse();
    const tool = parser.tool("formatCheck")!;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: Parameters<typeof console.warn>): void => {
      warnings.push(args);
    };
    try {
      const synchronous = toStandardSchema(tool);
      assert.deepEqual(synchronous["~standard"].validate({ count: 7, payload: "aGVsbG8=", when: "2025-01-01T00:00:00Z" }), {
        value: { count: 7, payload: "aGVsbG8=", when: "2025-01-01T00:00:00Z" },
      });
      const invalid = synchronous["~standard"].validate({ count: 2147483648, payload: "not-base64", when: "not-a-date" });
      assert.ok("issues" in invalid && invalid.issues !== undefined && invalid.issues.length >= 3);
      const asyncInvalid = await parser.validate(tool, { count: 2147483648, payload: "not-base64", when: "not-a-date" });
      assert.equal(asyncInvalid.valid, false);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, []);
  });

  it("applies defaults only when explicitly requested and does not mutate input", async () => {
    const parser = new MultiSpecParser({ spec: { spec: DEFAULT_SPEC } });
    await parser.parse();
    const tool = parser.tool("getUser")!;
    const input = {};
    const applied = toStandardSchema(tool, { defaultPolicy: "apply" });
    assert.deepEqual(await applied["~standard"].validate(input), { value: { userId: "me" } });
    assert.deepEqual(input, {});
    assert.equal(applied["~standard"].jsonSchema.input({ target: "draft-2020-12" }).required, undefined);
    const preserved = toStandardSchema(tool);
    assert.deepEqual(preserved["~standard"].jsonSchema.input({ target: "draft-2020-12" }).required, ["userId"]);
    const result = preserved["~standard"].validate(input) as { issues?: Array<{ message: string }> };
    assert.ok(result.issues?.some((issue) => /userId/.test(issue.message)));
  });

  it("returns { value } for valid input and { issues } with messages for invalid", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const tool = parser.tool("createPet")!;
    const appliedSchema = toStandardSchema(tool, { defaultPolicy: "apply" });
    assert.deepEqual(appliedSchema["~standard"].jsonSchema.input({ target: "draft-2020-12" }).required, ["body"]);
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
    const std = toStandardSchema(tool);
    const draft07 = std["~standard"].jsonSchema.input({ target: "draft-07" });
    assert.ok(draft07.definitions);
    assert.equal(draft07.$defs, undefined);
    assert.equal(draft07.$ref, undefined);
    assert.deepEqual(std["~standard"].jsonSchema.output({ target: "draft-07" }).$schema, "http://json-schema.org/draft-07/schema#");
    const { validate } = std["~standard"];
    assert.deepEqual(validate({ id: "1", body: { name: "ok" } }), {
      value: { id: "1", body: { name: "ok" } },
    });
    const bad = validate({ id: "1", body: {} }) as { issues?: Array<{ message: string }> };
    assert.ok(bad.issues!.some((i) => /name/i.test(i.message)));
  });
});
