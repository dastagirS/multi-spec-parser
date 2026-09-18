/**
 * Standard Schema adapter tests for the open `~standard` interoperability
 * protocol wrapped around a compiled operation's schema.
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

const SIDE_SCHEMAS = {
  Input: { type: "object", properties: { value: { type: "string" } } },
  Output: { type: "object", properties: { value: { type: "number" } } },
};

const FORMAT_PROJECTION_CASES = [
  {
    format: "swagger2",
    operationName: "swaggerProject",
    spec: {
      swagger: "2.0",
      info: { title: "T", version: "1" },
      paths: {
        "/items": {
          post: {
            operationId: "swaggerProject",
            parameters: [{ name: "body", in: "body", schema: { $ref: "#/definitions/Input" } }],
            responses: { "200": { description: "ok", schema: { $ref: "#/definitions/Output" } } },
          },
        },
      },
      definitions: SIDE_SCHEMAS,
    },
  },
  {
    format: "google-discovery",
    operationName: "google_project",
    spec: {
      kind: "discovery#restDescription",
      name: "google",
      version: "v1",
      rootUrl: "https://example.com/",
      resources: {
        items: {
          methods: {
            project: {
              id: "google.project",
              path: "items",
              httpMethod: "POST",
              request: { $ref: "Input" },
              response: { $ref: "Output" },
            },
          },
        },
      },
      schemas: SIDE_SCHEMAS,
    },
  },
] as const;

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

describe("toStandardSchema", () => {
  it("wraps an operation as the ~standard protocol shape", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const operation = (await parser.getOperation("createPet"))!;
    const std = toStandardSchema(operation);
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

  it("enforces OpenAPI formats consistently without runtime warnings", async () => {
    const formatSpec = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/formats": {
          get: {
            operationId: "formatCheck",
            parameters: [
              { name: "count", in: "query", required: true, schema: { type: "integer", format: "int32" } },
              { name: "pageSize", in: "query", required: true, schema: { type: "integer", format: "uint32" } },
              { name: "historyId", in: "query", required: true, schema: { type: "string", format: "uint64" } },
              { name: "payload", in: "query", required: true, schema: { type: "string", format: "byte" } },
              { name: "when", in: "query", required: true, schema: { type: "string", format: "date-time" } },
              { name: "refreshTime", in: "query", required: true, schema: { type: "string", format: "google-datetime" } },
              { name: "fields", in: "query", required: true, schema: { type: "string", format: "google-fieldmask" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parser = new MultiSpecParser({ spec: { spec: formatSpec } });
    await parser.parse();
    const operation = (await parser.getOperation("formatCheck"))!;
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: Parameters<typeof console.warn>): void => {
      warnings.push(args);
    };
    try {
      const synchronous = toStandardSchema(operation);
      const valid = {
        count: 7,
        pageSize: 4_294_967_295,
        historyId: "18446744073709551615",
        payload: "aGVsbG8=",
        when: "2025-01-01T00:00:00Z",
        refreshTime: "2025-01-01T00:00:00Z",
        fields: "nextPageToken,items.id",
      };
      assert.deepEqual(await synchronous["~standard"].validate(valid), { value: valid });
      const invalidValues = {
        count: 2_147_483_648,
        pageSize: 4_294_967_296,
        historyId: "18446744073709551616",
        payload: "not-base64",
        when: "not-a-date",
        refreshTime: "not-a-date",
        fields: "items(id)",
      };
      const invalid = await synchronous["~standard"].validate(invalidValues);
      assert.ok("issues" in invalid && invalid.issues !== undefined && invalid.issues.length >= 6);
      const asyncInvalid = await parser.toStandardSchema(operation)["~standard"].validate(invalidValues);
      assert.ok("issues" in asyncInvalid);
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(warnings, []);
  });

  it("preserves defaults as annotations without mutating input", async () => {
    const parser = new MultiSpecParser({ spec: { spec: DEFAULT_SPEC } });
    await parser.parse();
    const operation = (await parser.getOperation("getUser"))!;
    const input = {};
    const standard = toStandardSchema(operation);
    assert.deepEqual(standard["~standard"].jsonSchema.input({ target: "draft-2020-12" }).required, ["userId"]);
    const result = await standard["~standard"].validate(input);
    assert.ok("issues" in result && result.issues?.some((issue) => /userId/.test(issue.message)));
    assert.deepEqual(input, {});
  });

  it("returns { value } for valid input and { issues } with messages for invalid", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const operation = (await parser.getOperation("createPet"))!;
    const standard = toStandardSchema(operation);
    assert.deepEqual(standard["~standard"].jsonSchema.input({ target: "draft-2020-12" }).required, ["body"]);
    const { validate } = standard["~standard"];

    // The JSON request body nests under `body` in the operation schema.
    const ok = await validate({ body: { name: "Rex", age: 3 } });
    assert.deepEqual(ok, { value: { body: { name: "Rex", age: 3 } } });

    const bad = await validate({ body: { age: "not-a-number" } });
    assert.ok("issues" in bad && bad.issues !== undefined && bad.issues.length > 0);
    assert.ok("issues" in bad && bad.issues?.every((issue) => typeof issue.message === "string"));

    const missing = await validate({ body: {} });
    assert.ok("issues" in missing && missing.issues?.some((issue) => /name/i.test(issue.message)));
  });

  it("is stable across repeated calls on the same operation", async () => {
    const parser = new MultiSpecParser({ spec: { spec: SPEC } });
    await parser.parse();
    const operation = (await parser.getOperation("createPet"))!;
    const a = toStandardSchema(operation);
    const b = toStandardSchema(operation);
    assert.equal(a, b, "same operation → same wrapped object (memoized)");
  });

  it("projects independent transitive input and output definition closures", async () => {
    const projectionSpec = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/items": {
          post: {
            operationId: "projectItem",
            requestBody: {
              required: true,
              content: { "application/json": { schema: { $ref: "#/components/schemas/InputRoot" } } },
            },
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { $ref: "#/components/schemas/OutputRoot" } } },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          InputRoot: { properties: { input: { $ref: "#/components/schemas/InputOnly" }, shared: { $ref: "#/components/schemas/Shared" } } },
          InputOnly: { type: "string" },
          OutputRoot: { properties: { output: { $ref: "#/components/schemas/OutputOnly" }, shared: { $ref: "#/components/schemas/Shared" } } },
          OutputOnly: { type: "number" },
          Shared: { properties: { leaf: { $ref: "#/components/schemas/Leaf" } } },
          Leaf: { type: "boolean" },
        },
      },
    };
    const parser = new MultiSpecParser({ spec: { spec: projectionSpec } });
    await parser.parse();
    const operation = (await parser.getOperation("projectItem"))!;
    assert.deepEqual(Object.keys(operation.input.definitions).sort(), ["InputOnly", "InputRoot", "Leaf", "Shared"]);
    assert.deepEqual(Object.keys(operation.output!.definitions).sort(), ["Leaf", "OutputOnly", "OutputRoot", "Shared"]);
    const standard = toStandardSchema(operation);
    const input2020 = standard["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    const output2020 = standard["~standard"].jsonSchema.output({ target: "draft-2020-12" });
    assert.deepEqual(Object.keys(input2020.$defs as Record<string, unknown>).sort(), ["InputOnly", "InputRoot", "Leaf", "Shared"]);
    assert.deepEqual(Object.keys(output2020.$defs as Record<string, unknown>).sort(), ["Leaf", "OutputOnly", "OutputRoot", "Shared"]);
    const input07 = standard["~standard"].jsonSchema.input({ target: "draft-07" });
    const output07 = standard["~standard"].jsonSchema.output({ target: "draft-07" });
    assert.equal(input07.$defs, undefined);
    assert.equal(output07.$defs, undefined);
    assert.deepEqual(Object.keys(input07.definitions as Record<string, unknown>).sort(), ["InputOnly", "InputRoot", "Leaf", "Shared"]);
    assert.deepEqual(Object.keys(output07.definitions as Record<string, unknown>).sort(), ["Leaf", "OutputOnly", "OutputRoot", "Shared"]);
    assert.equal(output07.$ref, "#/definitions/OutputRoot");
    assert.deepEqual(Object.keys(operation.input.definitions).sort(), ["InputOnly", "InputRoot", "Leaf", "Shared"]);
  });

  it("projects closures consistently for Swagger and Google Discovery", async () => {
    for (const projectionCase of FORMAT_PROJECTION_CASES) {
      const parser = new MultiSpecParser({ spec: { spec: projectionCase.spec } });
      await parser.parse();
      assert.equal(parser.format, projectionCase.format);
      const standard = parser.toStandardSchema(projectionCase.operationName);
      const input = standard["~standard"].jsonSchema.input({ target: "draft-2020-12" });
      const output = standard["~standard"].jsonSchema.output({ target: "draft-2020-12" });
      assert.deepEqual(Object.keys(input.$defs as Record<string, unknown>), ["Input"]);
      assert.deepEqual(Object.keys(output.$defs as Record<string, unknown>), ["Output"]);
    }
  });

  it("keeps missing local references explicit and safe in projections", async () => {
    const missingReferenceSpec = {
      openapi: "3.0.3",
      info: { title: "T", version: "1" },
      paths: {
        "/missing": {
          post: {
            operationId: "missingReferences",
            requestBody: { content: { "application/json": { schema: { $ref: "#/components/schemas/MissingInput" } } } },
            responses: {
              "200": { description: "ok", content: { "application/json": { schema: { $ref: "#/components/schemas/MissingOutput" } } } },
            },
          },
        },
      },
    };
    const parser = new MultiSpecParser({ spec: { spec: missingReferenceSpec } });
    await parser.parse();
    const operation = (await parser.getOperation("missingReferences"))!;
    assert.deepEqual([...(operation.unresolvedRefs ?? [])].sort(), ["#/$defs/MissingInput", "#/$defs/MissingOutput"]);
    const standard = parser.toStandardSchema(operation);
    const input = standard["~standard"].jsonSchema.input({ target: "draft-2020-12" });
    const output = standard["~standard"].jsonSchema.output({ target: "draft-2020-12" });
    assert.equal(JSON.stringify(input).includes("MissingInput"), false);
    assert.equal(JSON.stringify(output).includes("MissingOutput"), false);
  });

  it("respects per-operation $defs closures (validates against referenced schemas)", async () => {
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
    const operation = (await parser.getOperation("updatePet"))!;
    const std = toStandardSchema(operation);
    const draft07 = std["~standard"].jsonSchema.input({ target: "draft-07" });
    assert.ok(draft07.definitions);
    assert.equal(draft07.$defs, undefined);
    assert.equal(draft07.$ref, undefined);
    assert.deepEqual(std["~standard"].jsonSchema.output({ target: "draft-07" }).$schema, "http://json-schema.org/draft-07/schema#");
    const { validate } = std["~standard"];
    assert.deepEqual(await validate({ id: "1", body: { name: "ok" } }), {
      value: { id: "1", body: { name: "ok" } },
    });
    const bad = await validate({ id: "1", body: {} });
    assert.ok("issues" in bad && bad.issues?.some((issue) => /name/i.test(issue.message)));
  });
});
