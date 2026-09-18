import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOperationSchema } from "../../src/operation-schema.js";

describe("OperationSchema", () => {
  it("renders a compact TypeScript root and referenced definitions", () => {
    const schema = createOperationSchema(
      {
        type: "object",
        required: ["pet"],
        properties: { pet: { $ref: "#/$defs/Pet" }, note: { type: "string" } },
        additionalProperties: false,
      },
      {
        Pet: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
          additionalProperties: false,
        },
        Unused: { type: "number" },
      },
    );

    assert.deepEqual(Object.keys(schema).sort(), ["definitions", "type", "validate"]);
    assert.equal(schema.type, "{ pet: Pet; note?: string; }");
    assert.deepEqual(schema.definitions, { Pet: "{ name: string; }" });
  });

  it("renders local constraints together with applied schemas", () => {
    const schema = createOperationSchema(
      {
        type: "object",
        properties: { local: { type: "string" } },
        allOf: [{ type: "object", properties: { applied: { type: "number" } } }],
      },
      {},
    );

    assert.equal(schema.type, "({ applied?: number; }) & { local?: string; }");
  });

  it("validates references, objects, arrays, and combinators without mutation", async () => {
    const schema = createOperationSchema(
      {
        type: "object",
        required: ["items"],
        properties: {
          items: {
            type: "array",
            minItems: 1,
            uniqueItems: true,
            items: { $ref: "#/$defs/Item" },
          },
          choice: { oneOf: [{ type: "string" }, { type: "number" }] },
        },
        additionalProperties: false,
      },
      {
        Item: {
          type: "object",
          required: ["id"],
          properties: { id: { type: "integer", minimum: 1 } },
          additionalProperties: false,
        },
      },
    );
    const value = { items: [{ id: 1 }], choice: "text" };

    assert.deepEqual(await schema.validate(value), { status: "ok", value });
    assert.deepEqual(value, { items: [{ id: 1 }], choice: "text" });

    const invalid = await schema.validate({ items: [{ id: 0 }, { id: 0 }], choice: true });
    assert.equal(invalid.status, "error");
    assert.equal(invalid.status === "error" && invalid.error._tag, "ValidationFailed");
    if (invalid.status === "error" && invalid.error._tag === "ValidationFailed") {
      assert.ok(invalid.error.issues.some((issue) => issue.keyword === "minimum"));
      assert.ok(invalid.error.issues.some((issue) => issue.keyword === "uniqueItems"));
      assert.ok(invalid.error.issues.some((issue) => issue.keyword === "oneOf"));
    }
  });

  it("resolves JSON Pointer suffixes beneath definitions", async () => {
    const schema = createOperationSchema(
      { $ref: "#/$defs/Container/properties/id" },
      {
        Container: {
          type: "object",
          properties: { id: { type: "string", minLength: 2 } },
        },
      },
    );

    assert.equal((await schema.validate("ab")).status, "ok");
    assert.equal((await schema.validate("a")).status, "error");
  });

  it("validates draft-07 tuple items used by Swagger documents", async () => {
    const schema = createOperationSchema(
      {
        type: "array",
        items: [{ type: "string" }, { type: "integer" }],
        additionalItems: false,
      },
      {},
    );

    assert.equal((await schema.validate(["item", 2])).status, "ok");
    const wrongType = await schema.validate(["item", "2"]);
    assert.equal(wrongType.status, "error");
    const additional = await schema.validate(["item", 2, true]);
    assert.equal(additional.status, "error");
  });

  it("supports negative numeric bounds", async () => {
    const schema = createOperationSchema(
      { type: "number", minimum: -1, maximum: 1 },
      {},
    );

    assert.equal((await schema.validate(-1)).status, "ok");
    assert.equal((await schema.validate(-2)).status, "error");
  });

  it("rejects invalid numeric assertions and formatted values", async () => {
    const invalidMultiple = createOperationSchema({ type: "number", multipleOf: -2 }, {});
    const invalidMultipleResult = await invalidMultiple.validate(4);
    assert.equal(invalidMultipleResult.status, "error");
    assert.equal(
      invalidMultipleResult.status === "error" && invalidMultipleResult.error._tag,
      "UnsupportedValidationKeyword",
    );

    for (const [format, value] of [["date", "2023-02-30"], ["date-time", "2023-02-30T12:00:00Z"], ["ipv6", "::::"]]) {
      assert.equal((await createOperationSchema({ type: "string", format }, {}).validate(value)).status, "error");
    }
    for (const [format, value] of [["date", "2024-02-29"], ["date-time", "2024-02-29T12:00:00Z"], ["ipv6", "2001:db8::1"]]) {
      assert.equal((await createOperationSchema({ type: "string", format }, {}).validate(value)).status, "ok");
    }
  });

  it("supports contains bounds and conditional validation", async () => {
    const schema = createOperationSchema(
      {
        type: "object",
        properties: {
          values: {
            type: "array",
            contains: { type: "integer", minimum: 2 },
            minContains: 2,
            maxContains: 2,
          },
          kind: { type: "string" },
        },
        if: { properties: { kind: { const: "named" } }, required: ["kind"] },
        then: { required: ["name"] },
        else: { not: { required: ["name"] } },
      },
      {},
    );

    assert.equal((await schema.validate({ values: [2, 3], kind: "named", name: "A" })).status, "ok");
    const invalid = await schema.validate({ values: [2, 3, 4], kind: "named" });
    assert.equal(invalid.status, "error");
    if (invalid.status === "error" && invalid.error._tag === "ValidationFailed") {
      assert.ok(invalid.error.issues.some((issue) => issue.keyword === "contains"));
      assert.ok(invalid.error.issues.some((issue) => issue.keyword === "required"));
    }
  });

  it("returns a typed limit error when validation cannot reach a conclusion", async () => {
    const schema = createOperationSchema(
      { type: "array", items: { type: "number" } },
      {},
    );
    const value = new Array(100_001).fill(1);

    const result = await schema.validate(value);
    assert.equal(result.status, "error");
    assert.deepEqual(result.status === "error" ? result.error : undefined, {
      _tag: "ValidationLimitExceeded",
      limit: "arrayItems",
      maximum: 100_000,
      message: "arrayItems exceeds 100000.",
    });
  });

  it("rejects unsupported assertions instead of silently ignoring them", async () => {
    const schema = createOperationSchema(
      { type: "object", unevaluatedProperties: false },
      {},
    );

    assert.deepEqual(await schema.validate({}), {
      status: "error",
      error: {
        _tag: "UnsupportedValidationKeyword",
        keyword: "unevaluatedProperties",
        schemaPath: ["unevaluatedProperties"],
        message: "Unsupported validation keyword: unevaluatedProperties",
      },
    });
  });
});
