# multi-spec-parser

Parse **OpenAPI 3.0/3.1**, **Swagger 2.0**, and **Google Discovery** specs into
one normalized model, then compile memory-safe JSON Schema tools for LLMs.

YAML uses a dependency-free Node-API addon with platform prebuilds and bundled
C-source fallback. Ajv is optional for validation and Standard Schema support.

> ⚠️ **WIP — expect breaking changes.** This is pre-1.0 (`0.x`); breaking
> changes may land in minor releases. Pin an exact version before upgrading.
> `name`, `method`, `path`, `inputSchema`, and `outputSchema` are the stable
> compiled-tool fields; other APIs may change shape.

## Why

- **Memory safety:** shared schemas are normalized once; each tool receives only
  its reachable `$ref` closure. GitHub's 1220-operation spec uses about 7MB of
  per-tool definitions instead of 3.2GB of embedded clones.
- **Visible references:** every tool carries the definitions needed to resolve
  its input and output `$ref`s.
- **One model:** OpenAPI, Swagger, and Google Discovery specs use one detector
  and normalized representation.

## Install

```sh
npm install multi-spec-parser
```

A matching native prebuild is used when available. Otherwise installation
compiles bundled `native/parser.c` with a local C compiler. If Node.js headers
are missing, it downloads, verifies, and caches the exact matching headers.

Set `CC` to select a compiler,
`MULTI_SPEC_PARSER_NODE_HEADERS` for an absolute headers directory, or
`MULTI_SPEC_PARSER_NODE_LIB` for an explicit Windows `node.lib` path. Windows
builds download and cache the matching import library when needed. Node-API
keeps the addon compatible across supported Node.js versions.

## Quick start

```ts
import { MultiSpecParser } from "multi-spec-parser";

const parser = new MultiSpecParser({
  // Use exactly one source: { url }, { text }, or { spec }.
  spec: { url: "https://petstore3.swagger.io/api/v3/openapi.json" },
  options: {
    baseUrl: "https://petstore3.swagger.io",
    headers: { Authorization: "Bearer …" },
    maxDefsBytes: 1_000_000,
  },
});

const document = await parser.parse(); // raw parsed document
console.log(parser.format); // openapi3 | swagger2 | google-discovery

const tool = parser.tool("findPetsByStatus");
// tool.inputSchema, tool.outputSchema, tool.operation
// tool.operationKey is the stable `METHOD /path` identity; tool.name is the LLM-facing name.

const request = parser.buildRequest("findPetsByStatus", { status: "available" });
const result = await parser.execute("findPetsByStatus", { status: "available" });
// result = { status: "success" | "error", httpStatus, data, error? }
```

The internal `parseSpec` and `compileSpecToTools` functions are not public;
use the `MultiSpecParser` class.

### Cancellation, limits, and cache

```ts
const result = await parser.execute("listPets", {}, {
  signal: new AbortController().signal,
  timeoutMs: 10_000,
  maxResponseBodyBytes: 5_000_000,
});
```

Results include response metadata and structured error codes such as `ABORTED`,
`TIMEOUT`, `NETWORK_ERROR`, `HTTP_ERROR`, and `RESPONSE_TOO_LARGE`. Execution
uses `fetch` unless `options.transport` is supplied:

```ts
const parser = new MultiSpecParser({
  spec: { spec: document },
  options: {
    transport: ({ url, method, headers, body, signal }) =>
      fetch(url, { method, headers, body, signal }),
  },
});
```

Configure parsed-source caching with `options.cache.enabled`, `maxEntries`, and
`ttlMs`; use `parser.clearCache()` and `parser.cacheStats()` to manage it.

Set `options.lazy: true` to experiment with on-demand source and tool loading.
For the lowest retained memory, use `load()` instead of `parse()`:

```js
const parser = new MultiSpecParser({
  spec: { url: "https://example.com/openapi.yaml" },
  options: { lazy: true },
});
await parser.load();
const tool = parser.tool("getPet");
```

`load()` returns nothing and indexes supported OpenAPI YAML without constructing
the complete raw or normalized document. The first access to a tool extracts its
path item and transitive local component references, compiles it, and caches the
result. Unsupported text layouts and formats fall back to full materialization
through `parse()`; strict low-memory `load()` rejects them instead. Text-source
`load()` also rejects operation filters/transforms because deriving the final
name index would require evaluating every complete operation. Schema transforms
and `extraParameterRules` still run when each tool compiles.

`tools()`, `describeTools()`, and `defs` intentionally materialize the complete
specification. Object sources remain caller-owned, so lazy mode cannot release
the source object. Compile-time transforms must be deterministic because lazy
materialization may reapply them. This mode is experimental and is intended for
large specifications where callers access only a subset of operations.

## Examples

Runnable examples are in [`examples/`](examples/) and ship in the npm tarball:

```sh
npm run examples                         # run all examples
node examples/basic.mjs                  # text → model → schemas
node examples/multi-format.mjs           # OpenAPI, Swagger, and Discovery
node examples/requests.mjs               # build + execute live requests
node examples/llm-tools.mjs              # OpenAI-style tool definitions
node examples/policies.mjs               # filters, processors, retry, validation
node examples/consumer-media-upload.mjs  # Google media upload
node examples/google-attachment-to-s3.mjs # Gmail attachment → S3
```

### Build a request

```ts
const request = parser.buildRequest(
  "addPet", // tool name or CompiledTool
  { body: { name: "Rex", photoUrls: ["https://example.com/rex.jpg"] } },
  { headers: { "X-Trace": "abc" } }, // per-call options override defaults
);
// request = { url, method, headers, body }
```

`buildRequest` accepts a `path` template override; placeholders resolve against
the operation's parameters. It supports OAS3 `style`/`explode`,
`allowReserved`, server variables, path/query/header/cookie parameters,
JSON, urlencoded, multipart, and octet-stream bodies. JSON and octet-stream
bodies use `body`; form bodies expose flat fields. Relative servers resolve
against `baseUrl`; absolute servers are replaced by it.

## Formats

| Format | Detection | Notable behavior |
|---|---|---|
| OpenAPI 3.0.x | `openapi: "3.0.x"` | `nullable` conversion; boolean `exclusiveMinimum` |
| OpenAPI 3.1.x | `openapi: "3.1.x"` | `type` arrays; numeric `exclusiveMinimum` |
| Swagger 2.0 | `swagger: "2.0"` | body/formData conversion; `collectionFormat` mapping |
| Google Discovery | `kind: "discovery#restDescription"` | `flatPath`, `repeated`, global params, `rootUrl` + `servicePath` |

Detection uses content, not URL or extension. The bundled YAML parser accepts
the JSON-compatible API-description profile and rejects tags, aliases, and
other graph features that cannot be represented safely as JSON.

## Memory and behavior

- Schemas are normalized once per spec and shared without cloning.
- Each canonical tool gets the combined transitive `$ref` closure of its input and
  output schemas; Standard JSON Schema projections independently include only
  definitions reachable from their respective roots.
- Closures over `maxDefsBytes` (default 1MB) use the shared defs map instead.
- Parsed objects use a `WeakMap`; text and URLs use a bounded 32-entry LRU.
- Missing `$ref`s become `{}` and are reported as `unresolvedRefs`.
- OAS 3.0 `nullable` becomes a type array, nullable `anyOf`, or enum `null`;
  output schemas use successful responses only (`2xx`, then `2XX`).
- `__proto__` keys are preserved safely. Security alternatives remain OR-ed;
  schemes within an alternative remain AND-ed. Consumers own auth policy.
- `method` is exposed on every tool for approval and read-only gating.

> ⚠️ Tool `$defs` may be live references to `parser.defs`. Treat compiled
> schemas as read-only or deep-copy them before editing.

## Policies and hooks

`options.transforms` supports operation, schema, request, and response changes.
Other hooks provide filtering, authentication refresh, response processing,
truncation, extra LLM-visible parameters, and custom transport. They are
consumer-owned; provider protocols and storage policies stay outside the
package.

```ts
const parser = new MultiSpecParser({
  spec: { url: GMAIL_DISCOVERY_URL },
  options: {
    filterOps: (op) =>
      !["POST", "PUT", "PATCH", "DELETE"].includes(op.method) &&
      !DESTRUCTIVE.has(op.toolName),
    onUnauthorized: async () => `Bearer ${await refreshToken()}`,
    maxAuthRetries: 1,
    maxResponseBytes: 250_000,
    onTruncate: (size, toolName) => logger.warn(`${toolName}: ${size} bytes`),
    describeMaxBytes: 20_000,
    processors: [
      {
        matches: (tool) => tool.operation.tags.includes("attachments"),
        process: async (result, { args }) => {
          if (result.status !== "success" || !result.data?.data) return result;
          const s3Url = await s3.upload(`attachments/${args.userId}/${args.id}`, result.data.data);
          return { status: "success", data: { s3Url }, httpStatus: 200 };
        },
      },
    ],
    extraParameterRules: [
      {
        matches: (operation) => operation.tags.includes("attachments"),
        parameters: [
          { name: "fileName", schema: { type: "string" } },
          { name: "mimeType", schema: { type: "string" } },
        ],
      },
    ],
  },
});
```

Hook semantics:

- `extraParameterRules` is compile-time and matches an `ExtractedOperation`, not
  the final generated tool name. Prefer tags, method, and path predicates; use
  `operationKey` when an exact stable operation selector is needed. The former
  name-keyed `extraParameters` map is not supported.
- `filterOps` runs before name dedup; filtered operations cannot be listed or
  executed.
- `extraParameterRules` matches normalized operations before name dedup; every
  matching rule contributes its LLM-visible parameters.
- `processors` run in declaration order after fetch and before truncation;
  failures become explicit error results and `execute()` does not throw.
- `onUnauthorized` replaces `Authorization` and retries up to
  `maxAuthRetries`; refresh failures do not loop.
- `describeTools()` projects schemas for LLM budgets, replacing over-budget
  `$defs` with reference names in `$refs`.
- `validate()` returns `{ valid: true }` or `{ valid: false, issues }` and loads
  Ajv lazily. `parser.toStandardSchema(tool)` returns a combined Standard
  Schema + Standard JSON Schema adapter; the synchronous low-level helper is
  also available from `multi-spec-parser/standard-schema`.

```ts
const schema = parser.toStandardSchema("createPet");
const validation = await schema["~standard"].validate({ body: { name: "Rex" } });
const inputSchema = schema["~standard"].jsonSchema.input({ target: "draft-07" });
const outputSchema = schema["~standard"].jsonSchema.output({ target: "draft-07" });
// Each projection is self-contained and includes only its reachable definitions.

// Opt in to non-mutating default application:
const applied = parser.toStandardSchema("createPet", { defaultPolicy: "apply" });
const normalized = await applied["~standard"].validate({});
```

Authentication and transport can also be overridden for one execution without
mutating the parser. This is useful when one compiled parser serves multiple
users or clients:

```ts
const result = await parser.execute("listPets", {}, {
  headers: await userClient.getHeaders(),
  transport: (request) => userClient.transport(request),
  onUnauthorized: () => userClient.refreshAuthorization(),
  runtimeContext: { userId, storageClient },
});
```

Execution-local values take precedence over parser defaults and remain isolated
from concurrent executions. `runtimeContext` is opaque and is passed only to
request/response transforms and processor hooks; it never enters tool schemas,
model arguments, logs, or serialized results. The parser still owns retries,
processors, truncation, and response handling.

## Options reference

| Option | Applies at | Default |
|---|---|---|
| `maxDefsBytes` | `parse()` | 1MB |
| `filterOps`, `extraParameterRules` | `parse()` | keep all / none |
| `baseUrl`, `headers` | build/execute | spec server / none |
| `transport` | execute / per-execution override | global `fetch` |
| `runtimeContext` | runtime hooks during `execute()` | absent |
| `executeTimeoutMs` | `execute()` | 30s |
| `maxResponseBodyBytes` | `execute()` | 50MiB |
| `processors`, `onUnauthorized`, `maxAuthRetries` | `execute()` | none / disabled / 1 |
| `maxResponseBytes`, `onTruncate` | `execute()` | no cap / none |
| `transforms` | parse/build/execute | none |
| `cache` | `parse()` | enabled, bounded |
| `lazy` | parse/tool access | false |
| `defaultPolicy` | validate/execute/Standard Schema | preserve |
| `describeMaxBytes` | `describeTools()` | 64KB |

With `defaultPolicy: "apply"`, Standard Schema input projections omit
`required` entries whose properties define defaults; the canonical tool schema
remains unchanged. Ajv validation recognizes standard JSON Schema formats plus
OpenAPI and Google Discovery formats including `int32`, `int64`, `uint32`,
`uint64`, `byte`, `google-datetime`, and `google-fieldmask`. `int64` validation
accepts only JavaScript-safe numbers; Discovery `uint64` values are validated as
decimal strings because wider integers cannot be represented exactly by Node.js.

## Consumer-side protocols

The package provides primitives, not vendor protocols or policies. Use
`parse()` to access raw fields such as Google `mediaUpload` and extensions, then
build the custom request with `buildRequest(tool, args, { path })`:

```ts
const { resources } = await parser.parse();
const uploadPath = resources.users.methods.send.mediaUpload.protocols.simple.path;
const request = parser.buildRequest(tool, { userId: "me" }, { path: uploadPath });
request.url += (request.url.includes("?") ? "&" : "?") + "uploadType=media";
request.body = bytes;
request.headers["Content-Type"] = "application/octet-stream";
const response = await fetch(request.url, {
  method: request.method, headers: request.headers, body: request.body,
});
```

Multipart framing, OAuth exchange, and S3 storage remain consumer code. See
[`examples/consumer-media-upload.mjs`](examples/consumer-media-upload.mjs).

## Releasing

Releases run from the `release` branch or manually through Actions. Configure
an npm publish token as the `NPM_TOKEN` repository secret.

```sh
npm version <version>     # bump, commit, and tag
npm run check              # local release gate
npm run examples
# push release, or run the workflow manually
```

The workflow validates the package version, builds all native targets, runs the
unit and battle suites, publishes to npm, and creates a GitHub Release. CI runs
on pushes and pull requests to `master`.

## Performance benchmark

```sh
npm run benchmark
BENCHMARK_ITERATIONS=5 npm run benchmark
```

Benchmarks fetch current upstream specs and run each case in a heap-capped
child process. They report download time, size, tool count, median/p95 parse
time, and heap usage; network and upstream changes make results observational.
`npm test` and `npm run check` do not fetch benchmark sources.

## Tests

```sh
npm test       # deterministic unit tests
npm run battle # real and synthetic specs
```

The battle gate checks exact operation counts, Ajv-compilable schemas with
resolvable `$ref`s, and GitHub's 1220-operation spec under a 1GB heap cap.
Heavy work runs in bounded child processes.

## License

MIT

## Contributing

1. Run `npm ci` and `npm test`.
2. For parser, adapter, or battle changes, run `npm run fixtures` then
   `npm run check`.
3. Run `npm run examples` when changing public usage or requests.
4. Keep pull requests focused, add regression tests, and do not commit
   generated output, fixtures, credentials, or secrets.

## Opening issues

Search existing issues first. Include a minimal reproduction or spec excerpt,
Node.js/OS/package versions, expected versus actual behavior, and sanitized
errors or test output.

Open issues at [GitHub Issues](https://github.com/dastagirS/multi-spec-parser/issues).
