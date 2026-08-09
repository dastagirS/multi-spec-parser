# multi-spec-parser

Parse **OpenAPI 3.0/3.1**, **Swagger 2.0**, and **Google Discovery** API specs
into one normalized model, then compile memory-safe JSON-Schema tool
definitions for LLM tool sets. TypeScript, zero runtime deps beyond `js-yaml`,
no framework coupling.

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

## Examples

Runnable, copy-pasteable usage lives in [`examples/`](examples/) (also shipped in the npm tarball):

```sh
npm run examples            # run all four
node examples/basic.mjs     # text → model → per-tool schemas
node examples/multi-format.mjs  # OpenAPI 3.0/3.1 + Swagger 2.0 + Google Discovery
node examples/requests.mjs  # build + execute live requests (needs network)
node examples/llm-tools.mjs # OpenAI-style tool definitions from a real spec
```

### Build a request

```ts
const req = parser.buildRequest(
  "addPet",                       // tool name or CompiledTool
  { body: { name: "Rex", photoUrls: ["https://example.com/rex.jpg"] } },
  { headers: { "X-Trace": "abc" } }, // per-call options merge over config defaults
);
// req = { url, method, headers, body }
```

Full OAS3 serialization: `style`/`explode` (form, spaceDelimited, pipeDelimited,
deepObject), `allowReserved` path encoding, form-urlencoded / multipart /
octet-stream bodies, `bodyBase64` media uploads, cookie params, server URL
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
