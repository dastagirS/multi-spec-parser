# multi-spec-parser

Parse **OpenAPI 3.0/3.1**, **Swagger 2.0**, and **Google Discovery** API specs
into one normalized model, then compile memory-safe JSON-Schema tool
definitions for LLM tool sets. TypeScript, two tiny runtime deps
(`js-yaml`, `ajv`), no framework coupling.

> ⚠️ **WIP — expect breaking changes.** This package is pre-1.0 (`0.x`). The
> API is still settling: new features land in minor versions, and breaking
> changes can too (per semver convention for `0.x`). Pin an exact version
> (`multi-spec-parser@0.2.1`) and re-check the README before upgrading.
> The compiled-tool fields `name`/`method`/`path`/`inputSchema`/
> `outputSchema` are the stable core; `operation()` and other
> internals may change shape.

## Why

Building LLM tools from real-world specs hits three walls:

1. **OOM on big specs** — GitHub's spec (1220 ops × 969 schemas) kills parsers
   that embed shared component schemas into every operation. This package
   hoists schemas once and attaches only each tool's reachable `$ref` closure
   (GitHub: ~7MB of per-tool defs instead of ~3.2GB of embedded clones).
2. **Opaque `$ref`s** — tools whose schemas say `{"$ref": "#/components/schemas/Message"}`
   with no definition attached are useless to an LLM. Per-tool `$defs` closures
   keep the resolved shape visible.
3. **Format sprawl** — Swagger 2.0, Google Discovery, and OpenAPI 3.0/3.1 are
   all still in the wild. One detector, one normalized model.

## Install

```sh
npm install multi-spec-parser
```

## Quick start

One class owns the whole lifecycle — config → parse → tools → requests:

```ts
import { MultiSpecParser } from "multi-spec-parser";

const parser = new MultiSpecParser({
  spec: { url: "https://petstore3.swagger.io/api/v3/openapi.json" },
  // spec source is exactly one of:
  //   { url: "https://…" }      — fetched (content-addressed cache)
  //   { text: "…" }            — raw JSON or YAML, content-sniffed
  //   { spec: { … } }          — pre-parsed object
  options: {
    baseUrl: "https://petstore3.swagger.io", // default for requests; origin for relative servers
    headers: { Authorization: "Bearer …" },  // default request headers
    maxDefsBytes: 1_000_000,                 // per-tool $defs closure cap
  },
});

await parser.parse();
console.log(parser.format);   // "openapi3" | "swagger2" | "google-discovery"

// parse() returns the RAW parsed document, TYPED to the input spec for
// object sources — the parser's view of the underlying schema:
const { paths } = await parser.parse();   // typeof yourSpec.paths

const tool = parser.tool("findPetsByStatus");
// tool.inputSchema  — JSON Schema with per-tool $defs closure (Ajv-compilable)
// tool.outputSchema — success-response schema, refs resolve against inputSchema.$defs
// tool.operation    — the normalized operation (params, requestBody, servers…)

// Build a request, or build + execute in one step:
const req = parser.buildRequest("findPetsByStatus", { status: "available" });
const res = await parser.execute("findPetsByStatus", { status: "available" });
// res = { status: "success" | "error", httpStatus, data, error? }
```

The internal functions (`parseSpec`, `compileSpecToTools`, …) are not part of
the public API — the exports map blocks them; everything hangs off the class.

### Cancellation, limits, and cache controls

Parsing and execution accept caller cancellation. Execution also supports a
per-call timeout and raw response-body limit:

```ts
const controller = new AbortController();
const result = await parser.execute("listPets", {}, {
  signal: controller.signal,
  timeoutMs: 10_000,
  maxResponseBodyBytes: 5_000_000,
});
```

Execution results include response metadata and structured `errorDetails` with
codes such as `ABORTED`, `TIMEOUT`, `NETWORK_ERROR`, `HTTP_ERROR`, and
`RESPONSE_TOO_LARGE`. API execution uses the library's default `fetch`
transport unless `options.transport` is supplied:

```ts
const parser = new MultiSpecParser({
  spec: { spec: document },
  options: {
    transport: ({ url, method, headers, body, signal }) =>
      fetch(url, { method, headers, body, signal }),
  },
});
```

Configure parsed-source caching with
`options.cache.enabled`, `maxEntries`, and `ttlMs`; `parser.clearCache()` and
`parser.cacheStats()` control and inspect the shared cache.

## Examples

Runnable, copy-pasteable usage lives in [`examples/`](examples/) (also shipped in the npm tarball):

```sh
npm run examples            # run all seven
node examples/basic.mjs     # text → model → per-tool schemas
node examples/multi-format.mjs  # OpenAPI 3.0/3.1 + Swagger 2.0 + Google Discovery
node examples/requests.mjs  # build + execute live requests (needs network)
node examples/llm-tools.mjs # OpenAI-style tool definitions from a real spec
node examples/policies.mjs  # filterOps, processors, 401 retry, truncation, validate, Standard Schema
node examples/consumer-media-upload.mjs  # Google media upload done consumer-side
node examples/google-attachment-to-s3.mjs  # Gmail attachment → S3, parser ends at the bytes
```

### Build a request

```ts
const req = parser.buildRequest(
  "addPet",                       // tool name or CompiledTool
  { body: { name: "Rex", photoUrls: ["https://example.com/rex.jpg"] } },
  { headers: { "X-Trace": "abc" } }, // per-call options merge over config defaults
);
// req = { url, method, headers, body }

`buildRequest` also takes a `path` template override — placeholders still
resolve against the op's params. This is the primitive that lets consumers
implement Google media uploads themselves (see “Consumer-side protocols”).
```

Full OAS3 serialization: `style`/`explode` (form, spaceDelimited, pipeDelimited,
deepObject), `allowReserved` path encoding, form-urlencoded / multipart /
octet-stream bodies, cookie params, server URL
`{variables}` substitution. JSON/octet-stream bodies nest under a `body` key;
form-style bodies (urlencoded/multipart, e.g. Slack's `formData`) are exposed
as flat top-level fields and serialized accordingly. A relative spec server
(e.g. petstore3's `/api/v3`) resolves against the `baseUrl` override as
origin; absolute servers are replaced outright.

## Formats

| Format | Detection | Notes |
|---|---|---|
| OpenAPI 3.0.x | `openapi: "3.0.x"` | `nullable` converted to type-arrays/anyOf at compile time; boolean `exclusiveMinimum` |
| OpenAPI 3.1.x | `openapi: "3.1.x"` | `type` arrays pass through; numeric `exclusiveMinimum` |
| Swagger 2.0 | `swagger: "2.0"` | `in:body`/`in:formData` → requestBody, `collectionFormat` → style/explode |
| Google Discovery | `kind: "discovery#restDescription"` | `flatPath`, `repeated`, global params, `rootUrl+servicePath`, `type:"any"` filtered |

Detection is by **content**, never URL/extension (Booking ships YAML under a
JSON-variant URL).

## Memory model

- Component schemas are normalized **once per spec** (`normalizeDefs`) and
  referenced — never cloned — by every tool.
- Each tool carries only the transitive `$ref` closure of its own input +
  output schemas (`collectReachableDefs`).
- Tools whose closure exceeds `maxDefsBytes` (default 1MB) share the hoisted
  defs map by reference instead — Ajv compiles against it without mutating.
- `parse` content-addresses parsed results (WeakMap for objects, a bounded
  32-entry LRU for text/URLs), so a multi-MB spec (GitHub 12.9MB) parses once
  per process even across MultiSpecParser instances, and long-lived processes
  don't retain every spec forever.

> ⚠️ **Shared `$defs` are live references.** Every tool's `inputSchema.$defs.X`
> is the *same object* as `parser.defs.X` — mutating one tool's schema
> corrupts every other tool (that sharing is the memory win). Treat compiled
> schemas as read-only, or deep-copy before editing.

## Behavioral notes

- **`nullable` (OAS 3.0) is compiled away** — `type` becomes `[type, "null"]`,
  `$ref` becomes `anyOf: [$ref, {type: "null"}]`, `enum` gains `null`. Tool
  schemas are draft-07-clean for strict Ajv consumers.
- **Output contracts** come from success responses only (exact `2xx`, then
  `2XX` wildcard); `default` is excluded (it usually carries the error shape).
- **Dangling `$ref`s** (missing schemas) are pruned to unconstrained `{}` so
  every tool stays Ajv-compilable, and the dropped refs are surfaced on the
  tool as `unresolvedRefs`.
- **`__proto__` keys** (schema/property/param names) are preserved as own
  properties — the parser never trips the prototype trap.
- Security metadata preserves OpenAPI semantics: alternatives are OR-ed, and
  schemes inside one alternative are AND-ed. The parser exposes declarations;
  consumers own authentication policy.
- The `method` (GET/POST/…) is exposed on every tool so approval/gating
  layers can derive read-only semantics themselves (`!["POST","PUT","PATCH","DELETE"].includes(tool.method)`).

## Policies & hooks

`options.transforms` provides generic consumer-owned seams for operation,
schema, request, and response changes. Transforms do not add authentication or
provider-specific protocols; they let a consumer adapt metadata or transport
without forking the parser.

```ts
const parser = new MultiSpecParser({
  spec: { text: openApiText },
  options: {
    transforms: {
      operation: (operation) => ({ ...operation, tags: [...operation.tags, "internal"] }),
      request: (request) => ({
        ...request,
        headers: { ...request.headers, "X-Request-Source": "agent" },
      }),
    },
  },
});
```

All hooks are optional, and omitted hooks preserve the default behavior.
`processors` is intentionally a pattern-matching pipeline rather than a
name-keyed map; this WIP package may make breaking API changes. Whatever is
stack-specific (S3, OAuth, storage budgets) lives in **your** closure; the
package only calls the hooks.

```ts
const parser = new MultiSpecParser({
  spec: { url: GMAIL_DISCOVERY_URL },
  options: {
    // Open compile-time filter: return true to keep an op. A filtered op
    // never becomes a tool — it can't be listed, described, or executed.
    // "Read-only" is one predicate on the HTTP method.
    filterOps: (op) =>
      !["POST", "PUT", "PATCH", "DELETE"].includes(op.method) &&
      !DESTRUCTIVE.has(op.toolName),

    // 401 → refresh → retry once (or maxAuthRetries times).
    onUnauthorized: async () => `Bearer ${await refreshToken()}`,
    maxAuthRetries: 1,

    // Uniform result-size guarantee for storage layers (e.g. DynamoDB).
    maxResponseBytes: 250_000,
    onTruncate: (size, toolName) => logger.warn(`${toolName}: ${size} bytes`),

    // LLM-side schema budget for describeTools().
    describeMaxBytes: 20_000,

    // Ordered response processor rules. Every matching rule runs.
    processors: [
      {
        matches: (tool) =>
          tool.operation.tags.includes("attachments") && tool.method === "GET",
        process: async (result, { args }) => {
          if (result.status !== "success" || !result.data?.data) return result;
          const s3Url = await s3.upload(`attachments/${args.userId}/${args.id}`, result.data.data);
          return { status: "success", data: { s3Url }, httpStatus: 200 };
        },
      },
    ],

    // Extra LLM-visible inputs that buildRequest ignores (processor metadata).
    extraParameters: {
      gmail_users_messages_attachments_get: [
        { name: "fileName", schema: { type: "string" }, description: "Original filename." },
      ],
    },
  },
});
```

Semantics:

- **`processors`** is an ordered pipeline. Each `matches(tool)` predicate
  receives compiled metadata such as method, path, tags, scopes, and vendor
  extensions. Every matching rule runs in declaration order; a matcher or
  processor failure stops the pipeline with an explicit error.
- **`filterOps(op) → boolean`** filters at compile time, before name dedup —
  a filtered op consumes no name slot, it never appears in `tools()` /
  `describeTools()`, and `execute()`/`tool()` by its name throws "unknown
tool" (the safety boundary: a tool that doesn't exist can't be called).
  Match on anything in the operation model: `toolName`, `method`,
  `requiredScopes`, `tags`.
- **`processors`** run after fetch, before truncation; they see every result
  (success and error) and may return any `ExecuteResult`. A throwing
  processor — or one returning a non-`ExecuteResult` — degrades to
  `{ status: "error", error: "Processor …" }`; `execute()` never throws.
- **`onUnauthorized`** replaces the `Authorization` header on the retried
  request (per-call headers win over config). A failing refresher degrades to
  an explicit error result — no retry loop.
- **`maxResponseBytes`** truncates *after* processors (a processor can shrink
  the result) to `{ status: "truncated", size, toolName, message }`.
- **`describeTools()`** is the LLM/prompt projection: full `$defs` stay on
  `tool.inputSchema` (Ajv side); over-budget schemas drop `$defs` and expose
  the closure's ref names as `$refs` instead. Includes the bounded
  `outputSchema` contract per tool.
- **`parser.validate(tool, args)`** returns `{ valid: true }` or
  `{ valid: false, issues }` — never throws. Ajv is loaded lazily on first
  call, so the core module stays free of a static ajv import.
- **`toStandardSchema(tool)`** wraps a tool as the open Standard Schema
  protocol (`~standard`) — drop-in for Mastra/Zod/Valibot/ArkType adapters,
  with a real Ajv-backed `validate`. Imported from the **subpath**
  `multi-spec-parser/standard-schema` (ajv is an optional dependency, so the
  main entry never loads it).

## Options reference

| Option | Applies at | Default |
|---|---|---|
| `maxDefsBytes` | `parse()` (compile) | 1MB |
| `filterOps` | `parse()` (compile) | keep all ops |
| `extraParameters` | `parse()` (compile) | none |
| `baseUrl` | `buildRequest()` / `execute()` | spec server |
| `headers` | `buildRequest()` / `execute()` | none |
| `transport` | `execute()` | global `fetch` |
| `executeTimeoutMs` | `execute()` | 30s |
| `maxResponseBodyBytes` | `execute()` (raw body) | 50MiB |
| `processors` | `execute()` (after fetch) | none |
| `onUnauthorized` | `execute()` (on 401) | disabled |
| `maxAuthRetries` | `execute()` (on 401) | 1 |
| `maxResponseBytes` | `execute()` (after processors) | no cap |
| `onTruncate` | `execute()` (on truncate) | none |
| `transforms` | parse/build/execute | none |
| `cache` | `parse()` | enabled, bounded cache |
| `describeMaxBytes` | `describeTools()` | 64KB |

## Consumer-side protocols

The package is a **parser + generic primitives + hooks** — it never implements
a *protocol* or *policy* (that's consumer behavior). If you need something
format- or vendor-specific — Google media uploads, resumable uploads, OAuth
exchange, S3 storage — you build it on top of what the parser gives you:

- **`parse()` returns the raw document**, typed to your input spec — so the
  spec's own data (Google `mediaUpload` paths, `x-` extensions, anything not
  normalized into the model) is in your hands:

  ```ts
  const { resources } = await parser.parse();
  const uploadPath = resources.users.methods.send.mediaUpload.protocols.simple.path;
  ```

- **`buildRequest(tool, args, { path })`** builds on any path template —
  placeholders resolve against the op's params, and the upload path shares
  them:

  ```ts
  const req = parser.buildRequest(tool, { userId: "me" }, { path: uploadPath });
  req.url += (req.url.includes("?") ? "&" : "?") + "uploadType=media";
  req.body = bytes;                                // your bytes
  req.headers["Content-Type"] = "application/octet-stream";
  const res = await fetch(req.url, {
    method: req.method, headers: req.headers, body: req.body,
  });
  ```

  `multipart/related` framing is yours too (~20 lines, see
  `examples/consumer-media-upload.mjs`, which runs the whole recipe against a
  local server).

- **The hooks** (`filterOps`, `processors`, `onUnauthorized`, `onTruncate`,
  `extraParameters`, `transforms`, `transport`) are the seams where your
  policy plugs in — S3/OAuth/etc. live in your closures, never in the package.

## Releasing

Releases are **manual** (Actions → *Release to npm* → Run workflow) so you
control exactly what ships. Setup once: generate a publish-scoped automation
token on npmjs.org and add it as the `NPM_TOKEN` repo secret (Settings →
Secrets and variables → Actions).

```sh
npm version 0.2.0          # bump + commit + tag
npm run check              # sanity, locally
npm run examples           # sanity, live
# then run the release workflow with version: 0.2.0
```

The workflow validates the input against `package.json`, runs the full test
gate (build + unit + battle suite), publishes to npm, and creates a GitHub
Release with an auto-generated changelog. CI runs the same gate on every
push/PR to `master`.

## Performance benchmark

```sh
npm run benchmark
BENCHMARK_ITERATIONS=5 npm run benchmark
```

The benchmark fetches the latest official upstream documents at runtime and
runs each case in a fresh heap-capped child process. It measures the public
`parse()` lifecycle (text decoding, normalization, and per-tool compilation),
not network time; download time, document size, tool count, median/p95 parse
time, and heap usage are reported separately. Cases currently include Slack,
Microsoft Graph v1.0 (including Outlook), Gmail, Google Drive, Stripe, and
GitHub. Because upstream documents and network conditions change, benchmark
numbers are observational rather than CI pass/fail thresholds.

`npm test` and `npm run check` remain deterministic and do not fetch benchmark
sources.

## Tests

```sh
npm test     # unit tests (node:test)
npm run battle  # battle suite: 7 real specs + 8 synthetic, best → worst
```

The battle suite is the gate: GitHub (1220 ops) must parse + compile under a
**1GB heap cap** (the old pipeline OOM'd at 4GB), every spec must hit exact op
counts (incl. Slack's official Swagger 2.0 Web API spec and the Booking.com
YAML download), every tool's input schema must compile under Ajv with all
`$ref`s resolvable, and the parent process stays light (children own the heavy
work, with per-spec timeouts and a fail-fast watchdog).

## License

MIT
