import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  collectReachableDefs,
  normalizeDefs,
  normalizeSchemaRefs,
} from "../../src/schema-closure.js";
import type { SchemaObject } from "../../src/types.js";

describe("normalizeSchemaRefs", () => {
  it("rewrites components/schemas, $defs, and definitions to #/$defs/X", () => {
    const schema = {
      $ref: "#/components/schemas/Pet",
      properties: { nested: { $ref: "#/definitions/Old" }, inline: { type: "string" } },
    };
    const out = normalizeSchemaRefs(schema) as Record<string, unknown>;
    assert.equal(out.$ref, "#/$defs/Pet");
    assert.equal(
      ((out.properties as Record<string, unknown>).nested as SchemaObject).$ref,
      "#/$defs/Old",
    );
  });

  it("returns the same object when nothing changed (no clone)", () => {
    const schema = { type: "object", properties: { a: { type: "string" } } };
    assert.equal(normalizeSchemaRefs(schema), schema);
  });

  it("leaves external refs untouched", () => {
    const schema = { $ref: "../other.json#/definitions/X" };
    assert.equal(normalizeSchemaRefs(schema), schema);
  });
});

describe("collectReachableDefs", () => {
  it("walks a diamond ref graph transitively", () => {
    const defs: Record<string, SchemaObject> = {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" }, c: { $ref: "#/$defs/C" } } },
      B: { type: "object", properties: { d: { $ref: "#/$defs/D" } } },
      C: { type: "object", properties: { d: { $ref: "#/$defs/D" } } },
      D: { type: "string" },
      E: { type: "number" }, // unreachable — must NOT appear
    };
    const closure = collectReachableDefs([{ $ref: "#/$defs/A" }], defs);
    assert.deepEqual(Object.keys(closure).sort(), ["A", "B", "C", "D"]);
  });

  it("terminates on reference cycles", () => {
    const defs: Record<string, SchemaObject> = {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" } } },
      B: { type: "object", properties: { a: { $ref: "#/$defs/A" } } },
    };
    const closure = collectReachableDefs([{ $ref: "#/$defs/A" }], defs);
    assert.deepEqual(Object.keys(closure).sort(), ["A", "B"]);
  });

  it("skips dangling refs instead of throwing", () => {
    const defs: Record<string, SchemaObject> = { A: { type: "string" } };
    const closure = collectReachableDefs([{ $ref: "#/$defs/Missing" }, { $ref: "#/$defs/A" }], defs);
    assert.deepEqual(Object.keys(closure), ["A"]);
  });

  it("collects refs from combinators (allOf/oneOf/anyOf) and arrays", () => {
    const defs: Record<string, SchemaObject> = {
      A: {
        anyOf: [{ $ref: "#/$defs/B" }, { allOf: [{ $ref: "#/$defs/C" }] }],
        items: { $ref: "#/$defs/D" },
      },
      B: { type: "string" },
      C: { type: "number" },
      D: { type: "boolean" },
    };
    const closure = collectReachableDefs([{ $ref: "#/$defs/A" }], defs);
    assert.deepEqual(Object.keys(closure).sort(), ["A", "B", "C", "D"]);
  });
});

describe("normalizeDefs", () => {
  it("normalizes every entry once, preserving keys", () => {
    const schemas: Record<string, SchemaObject> = {
      Pet: { type: "object", properties: { tag: { $ref: "#/components/schemas/Tag" } } },
      Tag: { type: "string" },
    };
    const defs = normalizeDefs(schemas);
    assert.equal((defs.Pet!.properties!.tag as SchemaObject).$ref, "#/$defs/Tag");
    assert.deepEqual(Object.keys(defs).sort(), ["Pet", "Tag"]);
  });
});
