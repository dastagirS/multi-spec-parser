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

```ts
import { parseSpecText, compileSpecToTools } from "multi-spec-parser";

// Text → object → normalized model (JSON or YAML, content-sniffed)
const specObj = parseSpecText(specText); // specText may be JSON or YAML

// Parse any of the 4 formats into one model
const parsed = parseSpec(specObj); // { operations, schemas, baseUrl, specFormat }

// Compile memory-safe tool definitions (input + output JSON Schema per op)
const { tools, defs } = compileSpecToTools(parsed);
for (const tool of tools) {
  // tool.inputSchema  — JSON Schema with per-tool $defs closure (Ajv-compilable)
  // tool.outputSchema — success-response schema, refs resolve against inputSchema.$defs
  // tool.operation    — the normalized operation (params, requestBody, servers…)
}
```

### From a URL or text, cached

```ts
import { compileSpecSource } from "multi-spec-parser";

const { tools } = await compileSpecSource("https://petstore3.swagger.io/api/v3/openapi.json");
```

### Build a request

```ts
import { buildRequest } from "multi-spec-parser";

const req = buildRequest(tool.operation, { petId: "5", body: { name: "Rex" } }, {
  baseUrl: "https://api.example.com",
  headers: { Authorization: "Bearer …" },
});
// req = { url, method, headers, body }
```

Full OAS3 serialization: `style`/`explode` (form, spaceDelimited, pipeDelimited,
deepObject), `allowReserved` path encoding, form-urlencoded / multipart /
octet-stream bodies, `bodyBase64` media uploads, cookie params, server URL
`{variables}` substitution.

## Formats

| Format | Detection | Notes |
|---|---|---|
| OpenAPI 3.0.x | `openapi: "3.0.x"` | `nullable`, boolean `exclusiveMinimum` |
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
- `compileSpecSource` content-addresses parsed+compiled results (WeakMap for
  objects, Map for text/URLs).

## Tests

```sh
npm test     # unit tests (node:test)
npm run battle  # battle suite: 5 real specs in heap-capped child processes
```

The battle suite is the gate: GitHub (1220 ops) must parse + compile under a
**1GB heap cap** (the old pipeline OOM'd at 4GB), all 5 specs must hit exact op
counts, every tool's input schema must compile under Ajv with all `$ref`s
resolvable, and the parent process stays light (children own the heavy work,
with per-spec timeouts and a fail-fast watchdog).

## License

MIT
