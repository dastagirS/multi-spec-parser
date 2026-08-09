Here's the full briefing — everything you need to hand to your LLM agent for the from-scratch parser.

---

# OpenAPI Parser — Handoff Briefing

## 1. Current Pain Points

### P1 — O(ops × schemas) memory blowup (the OOM)
`factory.ts` deep-clones **all** component schemas and attaches them as `$defs` **inside every operation's loop**:
```ts
for (const op of allowedOps) {
  (jsonschema.$defs) = Object.fromEntries(
    Object.entries(schemas).map(([k, v]) => [k, domany(structuredClone(v))]),
  );
}
```
- GitHub spec (1220 ops × 969 schemas = 1.18M clone+clean passes) → **fatal OOM at ~4GB heap**.
- Each tool's inputSchema holds a full ~1MB `$defs` copy → ~1.3GB held simultaneously.
- **Fixed in executor by never embedding shared schemas in per-op schemas** (see §3).

### P2 — LLM sees opaque `$ref`s
`describeSchema()` **strips `$defs`** (added to fix DynamoDB 400KB). Result: a param whose schema is `{ $ref: "#/components/schemas/Message" }` renders as exactly that string — **the LLM cannot know the param's shape**. We're hiding the answer to fix a size problem instead of solving it properly.

### P3 — JSON-only fetching
`fetchSpec()` does `res.json()`. **Booking.com ships YAML** (`.yaml` is the documented download link); we had to discover a hidden `.json` variant URL. Any YAML spec fails with a parse error.

### P4 — Swagger 2.0 unsupported
Clean rejection ("Unrecognized spec format") but no conversion path. Swagger 2.0 is still common (`swagger: "2.0"`, `host`/`basePath`/`schemes`, `securityDefinitions`, `definitions`, `in: "body"` params instead of `requestBody`).

### P5 — Ajv constraint shapes the whole design
Validation goes through `@mastra/schema-compat`'s `JsonSchemaWrapper` → **Ajv requires `$defs` to be present in the same schema object** to resolve `#/$defs/X` refs. Verified: Ajv compiles against a **shared `$defs` object reference without mutating it** (1220 compiles, defs intact, `$ref` validation correct). So sharing by reference is safe.

### P6 — `type: "any"` stripping (Google Discovery)
Ajv rejects `type: "any"`, which Google Discovery emits heavily. We strip it via recursive `domany()`. Executor solves this at the conversion layer with a `VALID_SCHEMA_TYPES` Set — **filter at conversion, don't clean up after**.

### P7 — Google Discovery `$ref` + param quirks
- `$ref: "Message"` → must rewrite to `#/components/schemas/Message`.
- `repeated: true` params → array schema.
- Global params (`prettyPrint`, `alt`, `fields`, `key`, `quotaUser`) injected into every op.
- `flatPath` vs `path` (path may contain legacy template segments).
- `rootUrl` + `basePath` concat for base URL.

### P8 — Noise: Ajv format warnings
`strict: false` still logs "unknown format ignored" for `decimal`, `unix-time`, `currency`, `date-time`, `int32`… on every compile. Harmless but floods logs (saw hundreds during the Stripe battle test).

### P9 — Parameter-level `$ref` not resolved
A param that is itself a `$ref` object (e.g. `#/components/parameters/X`) has no `name`/`in` — our parser mangles it into a broken param. Both OpenAPI and Discovery use this pattern.

### P10 — Request serialization is minimal
`buildRequest` handles path/query/header/body(a JSON or raw string), arrays as repeated query params. Untested against real non-Google APIs. No `style`/`explode` handling, no form/multipart bodies, no media upload (`uploadType=media` — Gmail/Drive support this; executor implements it).

### P11 — No output schemas
We only build **input** schemas. Executor derives `outputSchema` per op (plus NDJSON → array wrapping, binary/base64 detection, `ToolFile` hints). We return raw responses — the LLM has no shape contract for results.

### P12 — No caching
Spec is re-fetched + re-parsed on every `buildTools()` call. Executor content-addresses specs and defs by hash with an LRU compiled-spec cache.

---

## 2. Resources Gathered

### Real specs for testing (already in `/tmp/specs/`)
| Spec | File | Stats | Result |
|---|---|---|---|
| Petstore 3.0.4 | `petstore3.json` (17KB) | 19 ops, 6 schemas | ✅ |
| Booking.com 3.1.0 | `booking.json` (835KB) | 39 ops, **0 components.schemas** (inline only) | ✅ |
| Stripe 3.0.0 | `stripe.json` (7.9MB) | 589 ops, 1440 schemas, heavy `oneOf`/`anyOf`/`$ref` | ✅ |
| GitHub 3.0.3 | `github.json` (12.9MB) | 1220 ops, 969 schemas | ❌ OOM |
| Swagger 2.0 petstore | `swagger2.json` (14KB) | 14 ops | ⚠️ rejected |

### Spec URLs
- Booking (YAML): `https://developers.booking.com/_bundle/demand/docs/open-api/demand-api.yaml` · (JSON): `.../demand-api.json`
- GitHub: `https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json`
- Stripe: `https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json`
- Petstore3: `https://petstore3.swagger.io/api/v3/openapi.json`
- Swagger2: `https://petstore.swagger.io/v2/swagger.json`
- Google Discovery: `https://www.googleapis.com/discovery/v1/apis/{gmail/v1,calendar/v3,drive/v3}/rest`

### Executor's reference implementation (cloned at `/tmp/executor`, sparse: `packages/plugins/openapi/src/sdk/`)
- **`openapi-utils.ts`** — `DocResolver` (lazy JSON-Pointer `$ref` resolution), server URL variable substitution, content negotiation (requests: **first-declared wins**; responses: **JSON-first**), NDJSON detection.
- **`extract.ts`** — `buildInputSchema(parameters, requestBody, servers)` = **only the op's own params+body**, `$ref`s stay as strings; `outputSchemaFromResponseBody`; binary/base64 detection (`format: "binary"|"byte"`, base64url in description).
- **`backing.ts`** — `normalizeOpenApiRefs` (rewrites `#/components/schemas/X` → `#/$defs/X`, one pass, no clone); `hoistedDefs` compiled **once per spec**; `buildDefsJson`/`buildDefsJsonStreaming` (defs blob serialized entry-by-entry, never co-resident with parsed doc — handles 37MB Microsoft Graph); `resolveOpenApiBackedTools` returns `{ tools, definitions }` **separately**; LRU compiled-spec cache (capacity 4).
- **`definitions.ts`** — schema-free tool-path planning (`OperationPathInput` = opId/method/path/tag only) so a 16k-op spec can be planned without materializing schemas; collision resolution in rounds: version segment → method suffix → content hash suffix.
- **`store.ts`** — defs blob content-addressed: `defs/{specHash}`, shared across tenants/selections.
- **`plugin.ts`** — `putDefs(specHash, JSON.stringify(compiled.hoistedDefs))` once at add-time.

### Verified facts about our stack
- `JsonSchemaWrapper` stores schema **by reference** (no copy); Ajv compiles lazily per tool on first `validate`; `jsonSchema.input()` **deep-clones** via `JSON.parse(JSON.stringify(schema))`; validate returns `{ value }` or `{ issues: [{ message, path }] }`.
- **Shared `$defs` reference across N tools: safe** (no Ajv mutation, correct `$ref` validation). *Test harness at `/tmp/defs-share-test2.ts`.*
- Mastra `ToolEntry.inputSchema` = generic Standard Schema; `execute()` validates via `["~standard"].validate()`; `describeSchema()` via `jsonSchema.input({ target: "draft-07" })`.

### Our existing pipeline (working, ~7 commits ahead of main)
- `parse-spec.ts` — dual-format detection (`openapi: 3.x` vs `kind: "discovery#restDescription"`) → normalized `ExtractedOperation[]` + `schemas` + `baseUrl`. **The normalized model is solid — keep it.**
- `request-builder.ts`, `factory.ts`, `types.ts`, per-service wrappers (`tools/google/*`), registry integration (`services/tool-registry/`).
- `factory.test.ts` — 11 tests green.
- Battle-test harness at `/tmp/battle-test.ts` + `/tmp/battle-one.ts`.

---

## 3. Design Guidance for the New Parser

### Architecture (adopt executor's — it's the fix for P1/P2)
1. **Hoist shared schemas once**: normalize (`domany` equivalent, ref-rewrite) each `components.schemas` entry **once per spec** → single defs map.
2. **Per-op schemas stay minimal**: params + body only, `$ref`s as strings.
3. **Attach defs at the boundary, not in the loop**:
   - **Option A**: share the one cleaned defs object by reference on every tool schema (Ajv-safe, verified) — kills OOM, ~10 lines.
   - **Option B (better)**: per-op, BFS the transitive `$ref` closure from params+body and attach only reachable schemas as that op's `$defs` (~40-line walker over `properties`/`items`/`allOf`/`oneOf`/`anyOf`/`additionalProperties`). Per-tool defs drop to KBs → **you can stop stripping `$defs` in `describeSchema`** → LLM finally sees resolved shapes (fixes P2) while staying under the DynamoDB budget (~5–10KB/tool is fine).
4. **Filter, don't clean**: `type:"any"` and unknown types rejected at conversion with a `VALID_SCHEMA_TYPES` Set (executor's pattern) — no recursive `domany` pass (P6).

### Format support matrix (build all three into one detector)
- **OpenAPI 3.0.x** — `openapi: "3.0.x"`; `nullable` keyword; `exclusiveMinimum/Maximum` are **booleans**; `type` is a single string.
- **OpenAPI 3.1.x** — `openapi: "3.1.x"`; **`type` can be an array** (`["string","null"]`); `exclusiveMinimum` is a **number**; `$schema` per-schema.
- **Google Discovery** — `kind`, `rootUrl`+`basePath`, nested `resources`, `methods[].{id,path,flatPath,httpMethod,parameters,request,response,scopes,mediaUpload}`, global `parameters`, `schemas`, `auth.oauth2.scopes`.
- **Swagger 2.0 (P4)** — `swagger: "2.0"`, `host`+`basePath`+`schemes`, `definitions`, `securityDefinitions`, params with `in: "body"` (→ requestBody) and `type` directly on the param (→ schema), `enum`/`items` at param level. **Conversion layer: 2.0 → normalized model directly** (like Discovery), no need to emit 3.x first.

### YAML (P3)
- `js-yaml` to parse YAML → same normalized model. Detect format by sniffing keys: `openapi` (string starting `3.`) / `swagger` (`2.0`) / `kind` (Discovery). **Sniff content, never the extension** — Booking's JSON variant URL ends in `.json` but specs get served under misleading names.

### Naming & collisions
- Executor's `group.leaf` derivation + 3 collision rounds (version → method → hash) is battle-tested and **schema-free** (plan 16k ops without materializing schemas). Our `operationId` sanitize + `_N` suffix loses the name mapping — steal executor's approach.

### Requests
- Content negotiation: **first-declared wins for request bodies** (spec authors order them deliberately), **JSON-first for responses** (server picks, not client).
- Add `style`/`explode` serialization (OpenAPI 3.0 `form`, `spaceDelimited`, `pipeDelimited`, `deepObject`), media upload for `uploadType=media` (Gmail/Drive), multipart/form bodies.
- Server URL `{variables}` substitution with defaults.

### Responses
- Derive per-op `outputSchema` (fixes P11). Handle NDJSON → array-of-lines (executor's `ndjsonArrayOutputSchema`); binary/base64 → `ToolFile`-style hint or our S3-processor path.

### Noise & robustness
- **Silence unknown-format warnings**: register no-op Ajv format stubs or pre-filter `format` values — don't let Ajv log per compile (P8).
- Parameter-level `$ref` (P9): resolve `#/components/parameters/X` and `#/components/requestBodies/X` — both OpenAPI 3.0+ use these, Discovery uses `$ref` for bodies too.
- Keep the truncation guard (>250KB responses) and the S3-processor pattern from the current pipeline — they're production fixes, not parser concerns.

### Caching (P12)
- Content-address specs and defs by hash; small LRU for compiled output. Specs are multi-MB; re-parsing per request is the executor's documented OOM site #2.

### Test gate
- The 5 specs in `/tmp/specs/` must all build. Gate: GitHub (1220 ops) must build **without OOM** and with bounded memory; Booking (no components.schemas) must work; Swagger2 must convert; all tools must `describeSchema` and validate. Assert op counts exactly (19/39/589/1220/14).

---

**The one-line summary for your LLM agent:** *Never embed shared component schemas into per-operation schemas — hoist them once, keep per-op schemas minimal with lazy `$ref`s, resolve reachable schemas only where the model actually needs them, sniff format from content (OpenAPI 3.0/3.1/Discovery/Swagger2), support YAML, and gate on the 5 real specs.*
