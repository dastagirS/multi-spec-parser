import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileSpecToOperations } from "../../src/operation-compiler.js";
import { parseSpec } from "../../src/parse-spec.js";

const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(
    readFixtureFile(name),
  ) as Record<string, unknown>;

const readFixtureFile = (name: string): string => {
  const path = fileURLToPath(new URL(`../../../test/fixtures/${name}`, import.meta.url));
  if (!existsSync(path)) {
    throw new Error(`Missing fixture ${name} — run \`npm run fixtures\` first (fixtures are git-ignored).`);
  }
  return readFileSync(path, "utf8");
};

describe("compileSpecToOperations", () => {
  it("compiles petstore3 into 19 operations with per-op $defs closure", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    const { operations, defs } = compileSpecToOperations(parsed);
    assert.equal(operations.length, 19);
    assert.ok(Object.keys(defs).length >= 6);

    for (const operation of operations) {
      assert.equal(operation.inputSchema.type, "object");
      assert.ok(operation.inputSchema.properties !== undefined);
      // Every $ref inside the input schema must resolve within its own $defs.
      const refs = collectSchemaRefs(operation.inputSchema);
      const localDefs = (operation.inputSchema.$defs ?? {}) as Record<string, unknown>;
      for (const ref of refs) {
        const name = ref.replace(/^#\/\$defs\//, "");
        assert.ok(name in localDefs, `${operation.name}: $ref ${ref} not in per-operation $defs`);
      }
    }
  });

  it("keeps per-operation $defs within the cap (Stripe's anyOf web is dense)", () => {
    const parsed = parseSpec(fixture("stripe.json"));
    const { operations } = compileSpecToOperations(parsed);
    let maxBytes = 0;
    for (const operation of operations) {
      const bytes = JSON.stringify(operation.inputSchema.$defs ?? {}).length;
      maxBytes = Math.max(maxBytes, bytes);
    }
    // Stripe's 1440-schema anyOf graph reaches ~1MB per operation naturally; the
    // factory cap (default 1MB) bounds it, falling back to the shared defs map
    // by reference for pathological operations instead of cloning per op. The
    // fallback size is the full spec's defs (~1.8MB), so the bound is the
    // full-defs size, NOT the old bug's 1GB of embedded clones.
    assert.ok(maxBytes <= 2_500_000, `max per-operation $defs = ${maxBytes} bytes`);
  });

  it("GitHub closure proves per-op defs are tiny vs the 3.2GB-embedded old bug", () => {
    const parsed = parseSpec(fixture("github.json"));
    const { operations } = compileSpecToOperations(parsed);
    let maxBytes = 0;
    for (const operation of operations) {
      const bytes = JSON.stringify(operation.inputSchema.$defs ?? {}).length;
      maxBytes = Math.max(maxBytes, bytes);
    }
    // 1220 ops × 969 schemas embedded per op would be ~3.2GB of JSON; the
    // closure keeps the largest operation at ~90KB (webhook schemas).
    assert.ok(maxBytes < 200_000, `max per-operation $defs = ${maxBytes} bytes`);
  });

  it("compiles booking (0 component schemas) with no $defs and no crash", () => {
    const parsed = parseSpec(fixture("booking.json"));
    assert.equal(Object.keys(parsed.schemas).length, 0);
    const { operations } = compileSpecToOperations(parsed);
    assert.equal(operations.length, 39);
    for (const operation of operations) {
      assert.equal(operation.inputSchema.$defs, undefined);
    }
  });

  it("compiles swagger2 petstore with converted request bodies", () => {
    const parsed = parseSpec(fixture("swagger2.json"));
    const { operations } = compileSpecToOperations(parsed);
    assert.equal(operations.length, 20);
    const upload = operations.find((t) => t.operation.path.includes("uploadImage"));
    assert.ok(upload, "expected uploadImage op");
    const props = upload.inputSchema.properties as Record<string, unknown>;
    assert.equal(props.bodyBase64, undefined); // multipart, not octet
    assert.equal(props.body, undefined); // form fields flattened, not nested
    assert.equal((props.file as { format?: string }).format, "binary");
    assert.ok(props.additionalMetadata, "form field flattened to top level");
    // file is optional in the fixture — only petId is required.
    assert.deepEqual(upload.inputSchema.required, ["petId"]);
  });

  it("flattens Slack's formData bodies to top-level operation properties", () => {
    const parsed = parseSpec(fixture("slack.json"));
    const { operations } = compileSpecToOperations(parsed);
    assert.equal(operations.length, 174);
    const approve = operations.find((t) => t.name === "admin_apps_approve");
    assert.ok(approve, "expected admin_apps_approve");
    const approveProps = approve.inputSchema.properties as Record<string, unknown>;
    assert.equal(approveProps.body, undefined);
    assert.ok(approveProps.app_id, "formData field at top level");
    assert.ok(approveProps.request_id, "formData field at top level");
    assert.ok(approveProps.token, "header param stays top-level");
    const upload = operations.find((t) => t.name === "files_upload");
    assert.ok(upload, "expected files_upload");
    const uploadProps = upload.inputSchema.properties as Record<string, unknown>;
    assert.equal(uploadProps.body, undefined);
    // Slack declares `file` as a plain string (no type:file anywhere in the
    // spec) — assert the source's own typing, not an assumed binary format.
    assert.equal((uploadProps.file as { type?: string }).type, "string");
    assert.ok(uploadProps.channels, "file-upload form field at top level");
    assert.ok(uploadProps.filename);
  });

  it("renames duplicate operation names deterministically", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { operationId: "dup", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "dup", responses: { "200": { description: "ok" } } } },
      },
    });
    const { operations } = compileSpecToOperations(parsed);
    assert.deepEqual(operations.map((t) => t.name), ["dup", "dup_1"]);
  });

  it("bumps duplicate names past real suffixed ids (no shadowing)", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { operationId: "getPet", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "getPet_1", responses: { "200": { description: "ok" } } } },
        "/c": { get: { operationId: "getPet", responses: { "200": { description: "ok" } } } },
      },
    });
    const { operations } = compileSpecToOperations(parsed);
    const names = operations.map((t) => t.name);
    assert.deepEqual(names, ["getPet", "getPet_1", "getPet_2"]);
    assert.equal(new Set(names).size, names.length);
  });

  it("separates colliding wire parameters from model input names", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/users/{id}": {
          get: {
            operationId: "users",
            parameters: [
              { name: "id", in: "path", required: true, schema: { type: "string" } },
              { name: "id", in: "query", schema: { type: "string" } },
              { name: "constructor", in: "query", schema: { type: "string" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const operation = compileSpecToOperations(parsed).operations[0]!;
    const properties = operation.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties), ["path_id", "query_id", "constructor_2"]);
    assert.deepEqual(
      operation.operation.parameters.map((parameter) => [parameter.name, parameter.inputName]),
      [["id", "path_id"], ["id", "query_id"], ["constructor", "constructor_2"]],
    );
  });

  it("prunes dangling refs (input + output) and records them on the operation", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      components: { schemas: { Real: { type: "object" } } },
      paths: {
        "/a": {
          get: {
            operationId: "danglingInput",
            parameters: [
              { name: "x", in: "query", schema: { $ref: "#/components/schemas/Missing" } },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
        "/b": {
          get: {
            operationId: "danglingOutput",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/Missing" } },
                },
              },
            },
          },
        },
      },
    });
    const { operations } = compileSpecToOperations(parsed);
    const input = operations.find((t) => t.name === "danglingInput")!;
    const output = operations.find((t) => t.name === "danglingOutput")!;
    const inputProps = input.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(inputProps.x, {}); // dangling ref replaced with unconstrained
    assert.deepEqual(output.outputSchema, {});
    assert.ok(input.unresolvedRefs?.some((r) => r.includes("Missing")));
    assert.ok(output.unresolvedRefs?.some((r) => r.includes("Missing")));
    // The good operation is untouched and reports nothing.
    assert.ok(operations.every((t) => t.name !== "danglingInput" || t.inputSchema.$defs === undefined));
  });

  it("includes OAuth scopes and deprecation in descriptions", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      security: [{ oauth2: ["read"] }],
      paths: {
        "/x": {
          get: {
            operationId: "getX",
            deprecated: true,
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const { operations } = compileSpecToOperations(parsed);
    const desc = operations[0]!.description;
    assert.ok(desc.includes("Required OAuth scopes: read"));
    assert.ok(desc.includes("DEPRECATED"));
  });

  it("keeps __proto__-named schemas and safely remaps the input parameter (N1)", () => {
    const spec = JSON.parse(`{
      "openapi": "3.0.0", "info": {"title":"t","version":"1"},
      "components": { "schemas": {
        "__proto__": { "type": "string" },
        "Holder": { "type": "object", "properties": { "__proto__": { "type": "string" } } }
      } },
      "paths": { "/a": { "get": { "operationId": "a",
        "parameters": [{ "name": "__proto__", "in": "query", "schema": { "type": "string" } }],
        "responses": { "200": { "description": "ok", "content": { "application/json": { "schema": { "$ref": "#/components/schemas/Holder" } } } } } } } }
    }`);
    const { operations, defs } = compileSpecToOperations(parseSpec(spec));
    assert.ok(
      Object.prototype.hasOwnProperty.call(defs, "__proto__"),
      "defs keeps the __proto__ schema",
    );
    const props = operations[0]!.inputSchema.properties as Record<string, unknown>;
    assert.ok(Object.prototype.hasOwnProperty.call(props, "__proto___2"), "param input was remapped");
    assert.deepEqual(props["__proto___2"], { type: "string" });
    const holderProps = (defs.Holder as { properties?: Record<string, unknown> }).properties!;
    assert.ok(Object.prototype.hasOwnProperty.call(holderProps, "__proto__"));
  });

  it("does not clobber a param named body with the request body (N2)", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": {
          post: {
            operationId: "a",
            parameters: [{ name: "body", in: "query", schema: { type: "string" } }],
            requestBody: {
              content: {
                "application/json": {
                  schema: { type: "object", properties: { x: { type: "string" } } },
                },
              },
            },
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const { operations } = compileSpecToOperations(parsed);
    const props = operations[0]!.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(props.query_body, { type: "string" });
    assert.deepEqual(props.body, {
      type: "object",
      properties: { x: { type: "string" } },
    });
  });

  it("prunes def-internal dangling refs once and reports them per operation (P1)", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      components: {
        schemas: {
          A: {
            type: "object",
            properties: { gone: { $ref: "#/components/schemas/Missing" } },
          },
        },
      },
      paths: {
        "/a": {
          get: {
            operationId: "usesA",
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { $ref: "#/components/schemas/A" } },
                },
              },
            },
          },
        },
        "/b": {
          get: { operationId: "usesNothing", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const { operations } = compileSpecToOperations(parsed);
    const usesA = operations.find((t) => t.name === "usesA")!;
    const usesNothing = operations.find((t) => t.name === "usesNothing")!;
    assert.ok(!JSON.stringify(usesA.inputSchema).includes("Missing"), "no dangling ref survives");
    assert.ok(
      usesA.unresolvedRefs?.includes("#/$defs/Missing"),
      "operation that uses A reports the pruned ref",
    );
    assert.equal(usesNothing.unresolvedRefs, undefined, "unrelated operation stays clean");
  });

  it("exposes the successful response schema per operation", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    const { operations } = compileSpecToOperations(parsed);
    const withOutput = operations.filter((t) => t.outputSchema);
    assert.ok(withOutput.length > 10);
  });


});

/** Walk a schema collecting every #/$defs/X ref (nested included). */
function collectSchemaRefs(node: unknown, into: Set<string> = new Set()): string[] {
  if (typeof node === "string") {
    if (node.startsWith("#/$defs/")) into.add(node);
    return [...into];
  }
  if (Array.isArray(node)) {
    for (const item of node) collectSchemaRefs(item, into);
    return [...into];
  }
  if (node !== null && typeof node === "object") {
    for (const value of Object.values(node as Record<string, unknown>)) {
      collectSchemaRefs(value, into);
    }
  }
  return [...into];
}
