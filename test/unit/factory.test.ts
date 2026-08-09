import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { compileSpecToTools } from "../../src/factory.js";
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

describe("compileSpecToTools", () => {
  it("compiles petstore3 into 19 tools with per-op $defs closure", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    const { tools, defs } = compileSpecToTools(parsed);
    assert.equal(tools.length, 19);
    assert.ok(Object.keys(defs).length >= 6);

    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, "object");
      assert.ok(tool.inputSchema.properties !== undefined);
      // Every $ref inside the input schema must resolve within its own $defs.
      const refs = collectSchemaRefs(tool.inputSchema);
      const localDefs = (tool.inputSchema.$defs ?? {}) as Record<string, unknown>;
      for (const ref of refs) {
        const name = ref.replace(/^#\/\$defs\//, "");
        assert.ok(name in localDefs, `${tool.name}: $ref ${ref} not in per-tool $defs`);
      }
    }
  });

  it("keeps per-tool $defs within the cap (Stripe's anyOf web is dense)", () => {
    const parsed = parseSpec(fixture("stripe.json"));
    const { tools } = compileSpecToTools(parsed);
    let maxBytes = 0;
    for (const tool of tools) {
      const bytes = JSON.stringify(tool.inputSchema.$defs ?? {}).length;
      maxBytes = Math.max(maxBytes, bytes);
    }
    // Stripe's 1440-schema anyOf graph reaches ~1MB per tool naturally; the
    // factory cap (default 1MB) bounds it, falling back to the shared defs map
    // by reference for pathological tools instead of cloning per op. The
    // fallback size is the full spec's defs (~1.8MB), so the bound is the
    // full-defs size, NOT the old bug's 1GB of embedded clones.
    assert.ok(maxBytes <= 2_500_000, `max per-tool $defs = ${maxBytes} bytes`);
  });

  it("GitHub closure proves per-op defs are tiny vs the 3.2GB-embedded old bug", () => {
    const parsed = parseSpec(fixture("github.json"));
    const { tools } = compileSpecToTools(parsed);
    let maxBytes = 0;
    for (const tool of tools) {
      const bytes = JSON.stringify(tool.inputSchema.$defs ?? {}).length;
      maxBytes = Math.max(maxBytes, bytes);
    }
    // 1220 ops × 969 schemas embedded per op would be ~3.2GB of JSON; the
    // closure keeps the largest tool at ~90KB (webhook schemas).
    assert.ok(maxBytes < 200_000, `max per-tool $defs = ${maxBytes} bytes`);
  });

  it("compiles booking (0 component schemas) with no $defs and no crash", () => {
    const parsed = parseSpec(fixture("booking.json"));
    assert.equal(Object.keys(parsed.schemas).length, 0);
    const { tools } = compileSpecToTools(parsed);
    assert.equal(tools.length, 39);
    for (const tool of tools) {
      assert.equal(tool.inputSchema.$defs, undefined);
    }
  });

  it("compiles swagger2 petstore with converted request bodies", () => {
    const parsed = parseSpec(fixture("swagger2.json"));
    const { tools } = compileSpecToTools(parsed);
    assert.equal(tools.length, 20);
    const upload = tools.find((t) => t.operation.path.includes("uploadImage"));
    assert.ok(upload, "expected uploadImage op");
    const props = upload.inputSchema.properties as Record<string, unknown>;
    assert.equal(props.bodyBase64, undefined); // multipart, not octet
    assert.ok(props.body, "multipart body property present");
  });

  it("renames duplicate tool names deterministically", () => {
    const parsed = parseSpec({
      openapi: "3.0.0",
      info: { title: "t", version: "1" },
      paths: {
        "/a": { get: { operationId: "dup", responses: { "200": { description: "ok" } } } },
        "/b": { get: { operationId: "dup", responses: { "200": { description: "ok" } } } },
      },
    });
    const { tools } = compileSpecToTools(parsed);
    assert.deepEqual(tools.map((t) => t.name), ["dup", "dup_1"]);
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
    const { tools } = compileSpecToTools(parsed);
    const desc = tools[0]!.description;
    assert.ok(desc.includes("Required OAuth scopes: read"));
    assert.ok(desc.includes("DEPRECATED"));
  });

  it("exposes outputSchema per tool for the LLM contract", () => {
    const parsed = parseSpec(fixture("petstore3.json"));
    const { tools } = compileSpecToTools(parsed);
    const withOutput = tools.filter((t) => t.outputSchema);
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
