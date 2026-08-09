import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { compileSpecToTools, clearSpecCache, loadSpecSource } from "../../src/factory.js";
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
    assert.equal(props.body, undefined); // form fields flattened, not nested
    assert.equal((props.file as { format?: string }).format, "binary");
    assert.ok(props.additionalMetadata, "form field flattened to top level");
    // file is optional in the fixture — only petId is required.
    assert.deepEqual(upload.inputSchema.required, ["petId"]);
  });

  it("flattens Slack's formData bodies to top-level tool properties", () => {
    const parsed = parseSpec(fixture("slack.json"));
    const { tools } = compileSpecToTools(parsed);
    assert.equal(tools.length, 174);
    const approve = tools.find((t) => t.name === "admin_apps_approve");
    assert.ok(approve, "expected admin_apps_approve");
    const approveProps = approve.inputSchema.properties as Record<string, unknown>;
    assert.equal(approveProps.body, undefined);
    assert.ok(approveProps.app_id, "formData field at top level");
    assert.ok(approveProps.request_id, "formData field at top level");
    assert.ok(approveProps.token, "header param stays top-level");
    const upload = tools.find((t) => t.name === "files_upload");
    assert.ok(upload, "expected files_upload");
    const uploadProps = upload.inputSchema.properties as Record<string, unknown>;
    assert.equal(uploadProps.body, undefined);
    // Slack declares `file` as a plain string (no type:file anywhere in the
    // spec) — assert the source's own typing, not an assumed binary format.
    assert.equal((uploadProps.file as { type?: string }).type, "string");
    assert.ok(uploadProps.channels, "file-upload form field at top level");
    assert.ok(uploadProps.filename);
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
    const { tools } = compileSpecToTools(parsed);
    const names = tools.map((t) => t.name);
    assert.deepEqual(names, ["getPet", "getPet_1", "getPet_2"]);
    assert.equal(new Set(names).size, names.length);
  });

  it("prunes dangling refs (input + output) and records them on the tool", () => {
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
    const { tools } = compileSpecToTools(parsed);
    const input = tools.find((t) => t.name === "danglingInput")!;
    const output = tools.find((t) => t.name === "danglingOutput")!;
    const inputProps = input.inputSchema.properties as Record<string, unknown>;
    assert.deepEqual(inputProps.x, {}); // dangling ref replaced with unconstrained
    assert.deepEqual(output.outputSchema, {});
    assert.ok(input.unresolvedRefs?.some((r) => r.includes("Missing")));
    assert.ok(output.unresolvedRefs?.some((r) => r.includes("Missing")));
    // The good tool is untouched and reports nothing.
    assert.ok(tools.every((t) => t.name !== "danglingInput" || t.inputSchema.$defs === undefined));
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

  it("bounds the text/URL cache (LRU eviction beyond 32 entries)", async () => {
    clearSpecCache();
    let hits = 0;
    const server = createServer((req, res) => {
      hits += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ openapi: "3.0.0", info: { title: "t", version: "1" }, paths: {} }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/spec`;
    try {
      for (let i = 0; i < 33; i += 1) await loadSpecSource(`${base}${i}`);
      assert.equal(hits, 33);
      await loadSpecSource(`${base}0`); // oldest entry evicted → refetch
      assert.equal(hits, 34);
      await loadSpecSource(`${base}32`); // most recent still cached
      assert.equal(hits, 34);
    } finally {
      clearSpecCache();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
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
