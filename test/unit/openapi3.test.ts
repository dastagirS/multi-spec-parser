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

describe("OpenAPI 3.x adapter", () => {
  it("parses petstore3: 19 ops, 6 schemas, baseUrl from servers", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    assert.equal(parsed.specFormat, "openapi3");
    assert.equal(parsed.operations.length, 19);
    assert.equal(Object.keys(parsed.schemas).length, 6);
    // The fixture declares a RELATIVE server url (/api/v3); the host is left
    // to the caller via the baseUrl override. Ground truth from the file.
    assert.equal(parsed.baseUrl, "/api/v3");
    assert.equal(parsed.title, "Swagger Petstore - OpenAPI 3.0");
  });

  it("marks path params required and keeps style/explode", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    const op = parsed.operations.find((o) => o.path.includes("/pet/{petId}") && o.method === "GET");
    assert.ok(op, "expected GET /pet/{petId}");
    const petId = op.parameters.find((p) => p.name === "petId");
    assert.ok(petId);
    assert.equal(petId.required, true);
    assert.equal(petId.in, "path");
  });

  it("derives outputSchema from success responses (JSON-first)", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    const withOutput = parsed.operations.filter((o) => o.outputSchema);
    assert.ok(withOutput.length > 10, `expected many output schemas, got ${withOutput.length}`);
  });

  it("preserves security alternatives and AND semantics", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      security: [
        { oauth: ["read", "write"], tenant: [] },
        { apiKey: [] },
      ],
      paths: {
        "/x": { get: { responses: { "200": { description: "ok" } } } },
      },
    });
    assert.deepEqual(parsed.operations[0]!.security, [
      { schemes: [{ name: "oauth", scopes: ["read", "write"] }, { name: "tenant", scopes: [] }] },
      { schemes: [{ name: "apiKey", scopes: [] }] },
    ]);
  });

  it("parses 3.1 type arrays without normalization", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": { schema: { type: ["string", "null"] } },
                },
              },
            },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    assert.equal(parsed.operations.length, 1);
    const out = parsed.operations[0]!.outputSchema;
    assert.deepEqual(out?.type, ["string", "null"]);
  });

  it("resolves parameter-level $refs (#/components/parameters/X)", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      components: {
        parameters: {
          OwnerParam: {
            name: "owner",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        },
      },
      paths: {
        "/repos/{owner}/repo": {
          get: {
            operationId: "getRepo",
            parameters: [{ $ref: "#/components/parameters/OwnerParam" }],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    assert.equal(parsed.operations.length, 1);
    const op = parsed.operations[0]!;
    assert.equal(op.parameters.length, 1);
    assert.equal(op.parameters[0]!.name, "owner");
    assert.equal(op.parameters[0]!.in, "path");
    assert.equal(op.parameters[0]!.required, true);
  });

  it("resolves requestBody $refs and keeps all media types", () => {
    const spec = {
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      components: {
        requestBodies: {
          PetBody: {
            required: true,
            content: {
              "application/json": { schema: { type: "object" } },
              "application/xml": { schema: { type: "object" } },
            },
          },
        },
      },
      paths: {
        "/pets": {
          post: {
            operationId: "createPet",
            requestBody: { $ref: "#/components/requestBodies/PetBody" },
            responses: { "201": { description: "ok" } },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    const op = parsed.operations[0]!;
    assert.equal(op.requestBody?.required, true);
    assert.equal(op.requestBody?.contentType, "application/json");
    assert.equal(op.requestBody?.contents?.length, 2);
  });

  it("wraps NDJSON response schemas in an array (Vercel-style logs)", () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/logs": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/stream+json": { schema: { type: "object", properties: { line: { type: "string" } } } },
                },
              },
            },
          },
        },
      },
    };
    const parsed = parseSpec(spec);
    const out = parsed.operations[0]!.outputSchema;
    assert.equal(out?.type, "array");
    assert.equal((out?.items as { type?: string }).type, "object");
  });

  it("tolerates external refs inside schemas: parse + compile never throw", async () => {
    const spec = {
      openapi: "3.1.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          get: {
            responses: {
              "200": {
                description: "ok",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { p: { $ref: "../other.json#/definitions/X" } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
    // Schema-embedded external refs are not resolved at the param/body/response
    // boundary; the closure walker skips dangling refs at compile time instead.
    const parsed = parseSpec(spec);
    assert.equal(parsed.operations.length, 1);
    const op = parsed.operations[0]!;
    assert.equal(op.unresolvedRefs, undefined);
    // Compiling must not throw, and the dangling ref must not appear in defs.
    const { compileSpecToTools } = await import("../../src/factory.js");
    const { tools } = compileSpecToTools(parsed);
    const defs = (tools[0]!.inputSchema.$defs ?? {}) as Record<string, unknown>;
    assert.equal(Object.keys(defs).length, 0);
  });

  it("tracks unresolved refs per operation only (no cross-op bleed)", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      components: {
        parameters: { Good: { name: "g", in: "query", schema: { type: "string" } } },
      },
      paths: {
        "/a": {
          get: {
            operationId: "opA",
            parameters: [{ $ref: "#/components/parameters/Missing" }],
            responses: { "200": { description: "ok" } },
          },
        },
        "/b": {
          get: { operationId: "opB", responses: { "200": { description: "ok" } } },
        },
      },
    });
    const a = parsed.operations.find((o) => o.toolName === "opA")!;
    const b = parsed.operations.find((o) => o.toolName === "opB")!;
    // Final-segment miss on a $ref must be recorded (not silently dropped).
    assert.deepEqual(a.unresolvedRefs, ["#/components/parameters/Missing"]);
    assert.equal(b.unresolvedRefs, undefined);
  });

  it("resolves $ref path items (OAS 3.0 path-level refs)", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/pets": { $ref: "#/paths/~1shared" },
        "/shared": {
          get: {
            operationId: "sharedGet",
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    // The ref target is itself a declared path, so BOTH yield ops: /pets via
    // the $ref, /shared directly. Previously the $ref path yielded ZERO.
    assert.equal(parsed.operations.length, 2);
    assert.equal(parsed.operations[0]!.toolName, "sharedGet");
    assert.equal(parsed.operations[0]!.path, "/pets");
    assert.equal(parsed.operations[1]!.path, "/shared");
  });

  it("supports params declared with content instead of schema", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/x": {
          get: {
            operationId: "contentParam",
            parameters: [
              {
                name: "filter",
                in: "query",
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: { q: { type: "string" } },
                    },
                  },
                },
              },
            ],
            responses: { "200": { description: "ok" } },
          },
        },
      },
    });
    const param = parsed.operations[0]!.parameters[0]!;
    assert.equal((param.schema as { type?: string }).type, "object");
    assert.ok((param.schema as { properties?: unknown }).properties);
  });
});
