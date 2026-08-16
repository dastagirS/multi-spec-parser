import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { validateParsedSpecModel } from "../../src/model-validation.js";
import type { ParsedSpec } from "../../src/types.js";

describe("validateParsedSpecModel", () => {
  it("reports all normalized-model failures instead of stopping at the first", () => {
    // Deliberately malformed external-model fixture; the cast represents data
    // crossing the runtime boundary, not a trusted TypeScript value.
    const malformed = {
      specFormat: "unknown",
      operations: [{
        operationKey: "",
        toolName: "",
        method: "INVALID",
        path: "pets",
        tags: [],
        parameters: [{ name: "", in: "body", required: "yes", schema: null }],
        deprecated: "no",
      }],
      servers: {},
      schemas: [],
    } as unknown as ParsedSpec;

    const findings = validateParsedSpecModel(malformed);
    const codes = findings.map((finding) => finding.code);
    assert.ok(codes.includes("invalidFormat"));
    assert.ok(codes.includes("missingOperationKey"));
    assert.ok(codes.includes("invalidMethod"));
    assert.ok(codes.includes("invalidPath"));
    assert.ok(codes.includes("invalidParameterLocation"));
    assert.ok(codes.includes("invalidDeprecated"));
    assert.ok(findings.length >= 8);
  });
});
