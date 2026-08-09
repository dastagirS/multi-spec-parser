import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRequest, queryParamEntries } from "../../src/request-builder.js";
import type { ExtractedOperation } from "../../src/types.js";

function op(overrides: Partial<ExtractedOperation> = {}): ExtractedOperation {
  return {
    toolName: "test",
    method: "GET",
    path: "/x",
    tags: [],
    parameters: [],
    deprecated: false,
    ...overrides,
  };
}

describe("queryParamEntries (OAS3 style/explode)", () => {
  const param = (style?: string, explode?: boolean) => ({
    name: "id",
    in: "query" as const,
    required: false,
    schema: {},
    ...(style ? { style } : {}),
    ...(explode !== undefined ? { explode } : {}),
  });

  it("default form+explode:true repeats the key for arrays", () => {
    assert.deepEqual(queryParamEntries([3, 4, 5], param()), [
      ["id", "3"],
      ["id", "4"],
      ["id", "5"],
    ]);
  });

  it("form+explode:false joins arrays with commas", () => {
    assert.deepEqual(queryParamEntries([3, 4, 5], param("form", false)), [["id", "3,4,5"]]);
  });

  it("spaceDelimited/pipeDelimited join non-exploded arrays", () => {
    assert.deepEqual(queryParamEntries(["a", "b"], param("spaceDelimited", false)), [["id", "a b"]]);
    assert.deepEqual(queryParamEntries(["a", "b"], param("pipeDelimited", false)), [["id", "a|b"]]);
  });

  it("form+explode:true flattens objects to top-level fields", () => {
    assert.deepEqual(queryParamEntries({ region: "west", tier: "standard" }, param()), [
      ["region", "west"],
      ["tier", "standard"],
    ]);
  });

  it("deepObject serializes param[prop]=value", () => {
    assert.deepEqual(queryParamEntries({ role: "admin" }, param("deepObject")), [
      ["id[role]", "admin"],
    ]);
  });

  it("ignores null/undefined values", () => {
    assert.deepEqual(queryParamEntries(null, param()), []);
    assert.deepEqual(queryParamEntries(undefined, param()), []);
  });
});

describe("buildRequest", () => {
  it("substitutes path params and encodes reserved characters", () => {
    const request = buildRequest(
      op({
        path: "/users/{id}/files/{name}",
        parameters: [
          { name: "id", in: "path", required: true, schema: {} },
          { name: "name", in: "path", required: true, schema: {} },
        ],
      }),
      { id: "a/b", name: "hello world" },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.url, "https://api.example.com/users/a%2Fb/files/hello%20world");
  });

  it("throws on missing required path params", () => {
    assert.throws(() =>
      buildRequest(
        op({ path: "/users/{id}", parameters: [{ name: "id", in: "path", required: true, schema: {} }] }),
        {},
        { baseUrl: "https://api.example.com" },
      ),
    );
  });

  it("serializes query params with style/explode and merges integration params", () => {
    const request = buildRequest(
      op({
        path: "/search",
        parameters: [
          { name: "q", in: "query", required: false, schema: {} },
          { name: "tag", in: "query", required: false, schema: {}, style: "form", explode: true },
        ],
      }),
      { q: "dogs", tag: ["a", "b"] },
      { baseUrl: "https://api.example.com", queryParams: { key: "secret" } },
    );
    assert.equal(
      request.url,
      "https://api.example.com/search?key=secret&q=dogs&tag=a&tag=b",
    );
  });

  it("sends header and cookie params", () => {
    const request = buildRequest(
      op({
        path: "/x",
        parameters: [
          { name: "X-Trace", in: "header", required: false, schema: {} },
          { name: "session", in: "cookie", required: false, schema: {} },
        ],
      }),
      { "X-Trace": "abc", session: "s1" },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.headers["X-Trace"], "abc");
    assert.equal(request.headers.Cookie, "session=s1");
  });

  it("serializes JSON bodies by default", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/pets",
        requestBody: {
          required: true,
          contentType: "application/json",
          schema: { type: "object" },
        },
      }),
      { body: { name: "Rex" } },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.body, '{"name":"Rex"}');
    assert.equal(request.headers["Content-Type"], "application/json");
  });

  it("serializes urlencoded bodies from object args", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/survey",
        requestBody: {
          required: false,
          contentType: "application/x-www-form-urlencoded",
          schema: { type: "object" },
        },
      }),
      { body: { name: "Amy Smith", tags: ["a", "b"] } },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.headers["Content-Type"], "application/x-www-form-urlencoded");
    // encodeURIComponent (not URLSearchParams) → %20 for spaces.
    assert.equal(String(request.body), "name=Amy%20Smith&tags=a&tags=b");
  });

  it("builds FormData for multipart bodies", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/upload",
        requestBody: {
          required: false,
          contentType: "multipart/form-data",
          schema: { type: "object" },
        },
      }),
      { body: { note: "hi", file: new Blob(["abc"]) } },
      { baseUrl: "https://api.example.com" },
    );
    assert.ok(request.body instanceof FormData);
    assert.equal(request.headers["Content-Type"], "multipart/form-data");
  });

  it("decodes bodyBase64 for octet-stream bodies (media upload)", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/upload",
        requestBody: {
          required: false,
          contentType: "application/octet-stream",
          schema: { type: "string", format: "binary" },
        },
      }),
      { bodyBase64: "aGVsbG8=" },
      { baseUrl: "https://api.example.com" },
    );
    assert.ok(request.body instanceof Uint8Array);
    assert.equal(new TextDecoder().decode(request.body as Uint8Array), "hello");
  });

  it("allows contentType override for multi-media request bodies", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/x",
        requestBody: {
          required: false,
          contentType: "application/json",
          contents: [
            { contentType: "application/json", schema: {} },
            { contentType: "application/xml", schema: {} },
          ],
          schema: { type: "object" },
        },
      }),
      { body: "<x/>", contentType: "application/xml" },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.headers["Content-Type"], "application/xml");
    assert.equal(request.body, "<x/>");
  });

  it("substitutes server URL variables with defaults and overrides", () => {
    const request = buildRequest(
      op({
        path: "/x",
        servers: [
          {
            url: "https://{region}.example.com/{version}",
            variables: {
              region: { default: "us" },
              version: { default: "v1" },
            },
          },
        ],
      }),
      { server: { variables: { region: "eu" } } },
    );
    assert.equal(request.url, "https://eu.example.com/v1/x");
  });
});
