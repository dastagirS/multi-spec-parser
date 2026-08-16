import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { buildRequest, executeRequest, queryParamEntries } from "../../src/request-builder.js";
import type { ExtractedOperation } from "../../src/types.js";

function op(overrides: Partial<ExtractedOperation> = {}): ExtractedOperation {
  return {
    operationKey: "GET /x",
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

describe("executeRequest", () => {
  it("returns structured errors and bounds response bodies", async () => {
    const response = await executeRequest(
      { url: "data:text/plain,123456", method: "GET", headers: {} },
      { maxResponseBodyBytes: 3 },
    );
    assert.equal(response.status, "truncated");
    assert.equal(response.errorDetails?.code, "RESPONSE_TOO_LARGE");

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = await executeRequest(
      { url: "data:text/plain,ok", method: "GET", headers: {} },
      { signal: aborted.signal },
    );
    assert.equal(cancelled.errorDetails?.code, "ABORTED");
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

  it("uses distinct model names for colliding wire parameters", () => {
    const request = buildRequest(
      op({
        path: "/users/{id}",
        parameters: [
          { name: "id", inputName: "path_id", in: "path", required: true, schema: {} },
          { name: "id", inputName: "query_id", in: "query", required: false, schema: {} },
          { name: "constructor", inputName: "constructor_2", in: "query", required: false, schema: {} },
          { name: "__proto__", inputName: "__proto___2", in: "header", required: false, schema: {} },
        ],
      }),
      { path_id: "user-1", query_id: "related", constructor_2: "safe", __proto___2: "trace" },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.url, "https://api.example.com/users/user-1?id=related&constructor=safe");
    assert.equal(Object.hasOwn(request.headers, "__proto__"), true);
    assert.equal(request.headers["__proto__"], "trace");
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

  it("serializes flattened urlencoded form fields from top-level args", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/survey",
        requestBody: {
          required: false,
          contentType: "application/x-www-form-urlencoded",
          schema: {
            type: "object",
            properties: {
              name: { type: "string" },
              tags: { type: "array", items: { type: "string" } },
            },
          },
        },
      }),
      // Top-level form fields; `server` must NOT leak into the body.
      { name: "Amy Smith", tags: ["a", "b"], server: { url: "https://other.example.com" } },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(String(request.body), "name=Amy%20Smith&tags=a&tags=b");
    assert.equal(request.headers["Content-Type"], "application/x-www-form-urlencoded");
  });

  it("builds FormData from flattened multipart form fields", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/upload",
        requestBody: {
          required: false,
          contentType: "multipart/form-data",
          schema: {
            type: "object",
            properties: {
              note: { type: "string" },
              file: { type: "string", format: "binary" },
            },
          },
        },
      }),
      { note: "hi", file: new Blob(["abc"]), server: { url: "https://other.example.com" } },
      { baseUrl: "https://api.example.com" },
    );
    assert.ok(request.body instanceof FormData);
    assert.equal(request.body.get("note"), "hi");
    assert.ok(request.body.get("file") instanceof Blob);
    assert.equal(request.headers["Content-Type"], "multipart/form-data");
  });

  it("resolves a relative spec server against the baseUrl override", () => {
    const request = buildRequest(
      op({
        method: "GET",
        path: "/pet/findByStatus",
        servers: [{ url: "/api/v3" }],
      }),
      {},
      { baseUrl: "https://petstore3.swagger.io" },
    );
    assert.equal(request.url, "https://petstore3.swagger.io/api/v3/pet/findByStatus");
  });

  it("replaces absolute spec servers with the baseUrl override", () => {
    const request = buildRequest(
      op({
        method: "GET",
        path: "/pets",
        servers: [{ url: "https://original.example.com/v1" }],
      }),
      {},
      { baseUrl: "https://override.example.com" },
    );
    assert.equal(request.url, "https://override.example.com/pets");
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

  it("builds against an override path template (path option)", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/users/{userId}/messages/send",
        parameters: [
          { name: "userId", in: "path", required: true, schema: {} },
        ],
      }),
      { userId: "me" },
      {
        baseUrl: "https://api.example.com",
        // A Google Discovery media-upload path shares the op's placeholders.
        path: "/upload/mail/v1/users/{userId}/messages/send",
      },
    );
    assert.equal(
      request.url,
      "https://api.example.com/upload/mail/v1/users/me/messages/send",
    );
  });

  it("path override never leaks into the default template", () => {
    const request = buildRequest(
      op({ method: "GET", path: "/pets/{petId}" }),
      { petId: "1" },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.url, "https://api.example.com/pets/1");
  });

  it("sets Accept on every request, not just body-bearing ones", () => {
    const request = buildRequest(op({ path: "/pets" }), {}, { baseUrl: "https://api.example.com" });
    assert.equal(request.headers.Accept, "application/json");
  });

  it("does not treat an undocumented `input` arg as the body", () => {
    const request = buildRequest(
      op({
        method: "POST",
        path: "/pets",
        requestBody: {
          required: false,
          contentType: "application/json",
          schema: { type: "object" },
        },
      }),
      { input: { name: "Rex" } },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.body, undefined);
  });

  it("percent-encodes cookie names and values", () => {
    const request = buildRequest(
      op({
        path: "/x",
        parameters: [{ name: "session id", in: "cookie", required: false, schema: {} }],
      }),
      { "session id": "a b;c" },
      { baseUrl: "https://api.example.com" },
    );
    assert.equal(request.headers.Cookie, "session%20id=a%20b%3Bc");
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
