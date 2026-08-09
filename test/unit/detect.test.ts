import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { detectSpecFormat, parseSpec } from "../../src/parse-spec.js";

describe("detectSpecFormat", () => {
  it("detects OpenAPI 3.0 and 3.1 from content", () => {
    assert.equal(detectSpecFormat({ openapi: "3.0.4" }), "openapi3");
    assert.equal(detectSpecFormat({ openapi: "3.1.1" }), "openapi3");
  });

  it("detects Swagger 2.0", () => {
    assert.equal(detectSpecFormat({ swagger: "2.0" }), "swagger2");
  });

  it("detects Google Discovery", () => {
    assert.equal(
      detectSpecFormat({ kind: "discovery#restDescription", rootUrl: "https://x/" }),
      "google-discovery",
    );
  });

  it("rejects unknown formats", () => {
    assert.throws(() => detectSpecFormat({ raml: "1.0" }));
    assert.throws(() => detectSpecFormat({}));
    assert.throws(() => detectSpecFormat({ openapi: "2.0" }));
  });
});

describe("parseSpec dispatch", () => {
  it("routes each format to its adapter", () => {
    const openapi = parseSpec({ openapi: "3.0.4", info: { title: "t", version: "1" }, paths: {} });
    assert.equal(openapi.specFormat, "openapi3");

    const swagger = parseSpec({ swagger: "2.0", info: { title: "t", version: "1" }, paths: {} });
    assert.equal(swagger.specFormat, "swagger2");

    const google = parseSpec({
      kind: "discovery#restDescription",
      name: "x",
      version: "v1",
      title: "t",
      rootUrl: "https://x/",
      resources: {},
    });
    assert.equal(google.specFormat, "google-discovery");
  });
});
