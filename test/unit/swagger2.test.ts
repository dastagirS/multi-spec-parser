import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

describe("Swagger 2.0 adapter", () => {
  it("parses the swagger2 petstore: 20 ops, 6 schemas, host+basePath+schemes → baseUrl", () => {
    const parsed = parseSpec(fixture("swagger2.json"));
    assert.equal(parsed.specFormat, "swagger2");
    assert.equal(parsed.operations.length, 20);
    assert.equal(Object.keys(parsed.schemas).length, 6);
    assert.equal(parsed.baseUrl, "https://petstore.swagger.io/v2");
  });

  it("converts in:body params into requestBody with schema", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "t", version: "1" },
      host: "api.example.com",
      basePath: "/v1",
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            consumes: ["application/json"],
            parameters: [
              {
                name: "pet",
                in: "body",
                required: true,
                schema: { $ref: "#/definitions/Pet" },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
      definitions: { Pet: { type: "object", properties: { name: { type: "string" } } } },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    assert.equal(op.requestBody?.required, true);
    assert.equal(op.requestBody?.contentType, "application/json");
    assert.deepEqual(op.requestBody?.schema, { $ref: "#/definitions/Pet" });
    assert.equal(op.parameters.length, 0);
  });

  it("converts in:formData params into an object-schema body (urlencoded)", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "t", version: "1" },
      consumes: ["application/x-www-form-urlencoded"],
      paths: {
        "/survey": {
          post: {
            operationId: "submitSurvey",
            parameters: [
              { name: "name", in: "formData", type: "string", required: true },
              { name: "age", in: "formData", type: "integer" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    assert.equal(op.requestBody?.contentType, "application/x-www-form-urlencoded");
    const schema = op.requestBody!.schema!;
    assert.equal(schema.type, "object");
    assert.deepEqual(schema.required, ["name"]);
    assert.equal((schema.properties!.name as { type?: string }).type, "string");
    assert.equal((schema.properties!.age as { type?: string }).type, "integer");
  });

  it("uses multipart/form-data when a file part exists", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "t", version: "1" },
      paths: {
        "/upload": {
          post: {
            operationId: "uploadFile",
            parameters: [
              { name: "file", in: "formData", type: "file", required: true },
              { name: "note", in: "formData", type: "string" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    assert.equal(op.requestBody?.contentType, "multipart/form-data");
    assert.equal((op.requestBody!.schema!.properties!.file as { format?: string }).format, "binary");
  });

  it("maps collectionFormat multi → form+explode:true, csv → form+explode:false", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          get: {
            operationId: "getX",
            parameters: [
              { name: "tags", in: "query", type: "array", items: { type: "string" }, collectionFormat: "multi" },
              { name: "ids", in: "query", type: "array", items: { type: "string" }, collectionFormat: "csv" },
              { name: "pipes", in: "query", type: "array", items: { type: "string" }, collectionFormat: "pipes" },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    const byName = Object.fromEntries(op.parameters.map((p) => [p.name, p]));
    assert.deepEqual([byName.tags!.style, byName.tags!.explode], ["form", true]);
    assert.deepEqual([byName.ids!.style, byName.ids!.explode], ["form", false]);
    assert.deepEqual([byName.pipes!.style, byName.pipes!.explode], ["pipeDelimited", false]);
  });

  it("derives outputSchema from 200 responses with schema", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "t", version: "1" },
      paths: {
        "/pets/{id}": {
          get: {
            operationId: "getPet",
            parameters: [{ name: "id", in: "path", type: "integer", required: true }],
            responses: {
              "200": { description: "ok", schema: { $ref: "#/definitions/Pet" } },
            },
          },
        },
      },
      definitions: { Pet: { type: "object" } },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    assert.deepEqual(op.outputSchema, { $ref: "#/definitions/Pet" });
  });

  it("resolves global parameter $refs (#/parameters/X)", () => {
    const spec = {
      swagger: "2.0",
      info: { title: "t", version: "1" },
      parameters: {
        LimitParam: { name: "limit", in: "query", type: "integer", required: false },
      },
      paths: {
        "/x": {
          get: {
            operationId: "getX",
            parameters: [{ $ref: "#/parameters/LimitParam" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    assert.equal(op.parameters.length, 1);
    assert.equal(op.parameters[0]!.name, "limit");
    assert.equal((op.parameters[0]!.schema as { type?: string }).type, "integer");
  });
});
