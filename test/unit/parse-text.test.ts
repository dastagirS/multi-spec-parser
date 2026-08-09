import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseSpec, parseSpecText } from "../../src/parse-spec.js";

const YAML_SPEC = `openapi: 3.1.0
info:
  title: YAML Test
  version: 1.0.0
paths:
  /ping:
    get:
      summary: ping
      responses:
        "200":
          description: ok
`;

describe("parseSpecText", () => {
  it("parses JSON", () => {
    const parsed = parseSpecText('{"openapi":"3.0.0","info":{},"paths":{}}');
    assert.equal(parsed.openapi, "3.0.0");
  });

  it("parses YAML (block style, the Booking profile)", () => {
    const parsed = parseSpecText(YAML_SPEC);
    assert.equal(parsed.openapi, "3.1.0");
    assert.equal((parsed.paths as Record<string, unknown>)["/ping"] !== undefined, true);
  });

  it("parses YAML containing JSON-looking first lines", () => {
    // A YAML doc whose first non-space char is not { or [ must go through js-yaml.
    const parsed = parseSpecText("openapi: '3.0.0'\ninfo: {}\npaths: {}\n");
    assert.equal(parsed.openapi, "3.0.0");
  });

  it("rejects empty input", () => {
    assert.throws(() => parseSpecText("   "));
  });

  it("rejects non-object YAML (arrays)", () => {
    assert.throws(() => parseSpecText("- a\n- b\n"));
  });

  it("wraps invalid JSON+YAML with a helpful error", () => {
    assert.throws(() => parseSpecText("a: [unclosed"), /not valid JSON or YAML/);
  });

  it("parses the real Booking.com YAML spec (the documented download)", () => {
    const path = fileURLToPath(
      new URL("../../../test/fixtures/booking.yaml", import.meta.url),
    );
    if (!existsSync(path)) {
      throw new Error(
        "Missing fixture booking.yaml — run `npm run fixtures` first (fixtures are git-ignored).",
      );
    }
    const text = readFileSync(path, "utf8");
    const parsed = parseSpec(parseSpecText(text));
    assert.equal(parsed.specFormat, "openapi3");
    assert.equal(parsed.operations.length, 39);
    assert.equal(Object.keys(parsed.schemas).length, 0);
    assert.equal(parsed.baseUrl, "https://demandapi.booking.com/3.1");
  });
});
