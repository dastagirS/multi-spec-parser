## Ground Truth

- Do not rely on training data or assume anything about this project's dependencies, APIs, or patterns. Always cross-check with:
  - Local docs under `docs/` (e.g. `docs/mastra/`, `docs/python.md`)
  - Web search / official documentation
  - The actual source code in this repo
- If docs exist for a library or tool, read them. Do not guess API signatures, config keys, or behavior.

- All initialization/bootstrap code (Mastra instance, service init, storage/vector wiring) goes in `src/lib/`. No init logic outside `src/lib/`.

## API Decisions

- Do not prepare another release until parser robustness gates are explicitly
  agreed and passing; API cleanup alone is not release readiness.
- The package parses and projects API descriptions only. Apart from bounded URL
  source loading, it does not build requests, execute operations, manage
  authentication, process responses, or inject consumer-owned fields into
  source models.
- Canonical public units are compiled operations, not LLM tools. LLM/provider
  formats may be separate adapters but never define the parser's domain model.
- Sources are caller-provided URLs, JSON/YAML text, or parsed objects. URL
  loading is a bounded parser convenience with cancellation; authentication,
  retries, custom transports, and source caches remain caller-owned.
- Low-memory loading means indexing a large source document without
  materializing its complete parsed or normalized model, then materializing
  requested operations and transitive schema references on demand. Object
  sources cannot satisfy this contract because callers already own them;
  unsupported formats/layouts must reject rather than fall back to eager parsing.
  URL sources may use bounded temporary files as seekable backing storage;
  idempotent `close()` owns deterministic cleanup, loading failures clean up
  automatically, and lazy access after closing must reject. Lazy URL loading is
  required for JSON sources in all three supported formats—OpenAPI 3.x, Swagger
  2.0, and Google Discovery—through dedicated format indexers. OpenAPI 3.x block
  YAML also remains supported. Support may ship incrementally, and any encoding
  or layout not yet indexed must reject. `options.lazy: true` selects this mode;
  omitted or false remains eager.
- Canonical operation schemas retain their combined input/output definition
  closure; Standard JSON Schema projections independently expose only
  definitions reachable from their respective input or output root.
- `parse({ compact: true, maxBytes })` creates bounded copies without mutating
  canonical operations. Budgets use serialized UTF-8 bytes.
- Standard Schema adapters expose ergonomic `validate()`, `input()`, and
  `output()` methods; `~standard` remains only for ecosystem interoperability.
- Canonical schemas remain private normalized JSON Schema. Public operation
  schemas expose bounded compact TypeScript preview strings, separate referenced
  type definitions, and lazy memoized validation against the canonical schema.
  Preview rendering degrades to `unknown` beyond safety limits. Do not introduce
  a second validation model or custom type AST.
- Runtime validation must remain Ajv-free and dependency-free. Build a bounded
  targeted validator available only through parser-produced operation input and
  output handles; never expose arbitrary-schema validation, claim support for
  arbitrary JSON Schema, or silently ignore unsupported assertion keywords.
- Zod is out of scope and must not be shipped or exposed. Prioritize bounded
  low-memory source loading before adding further schema adapters.
- Object sources remain caller-owned and are never mutated. Arbitrary compile
  transforms and consumer-added parameters are intentionally unsupported.

## Naming

- Class names/constructors: PascalCase.
- Class methods and all other identifiers: camelCase.
- File names: kebab-case (foo-bar-baz). No snake_case or PascalCase in filenames.

## Code Patterns

### Naming

- **Filenames**: `kebab-case` (e.g. `open-meteo.ts`, `use-onboarding.ts`).
- **Class methods**: `camelCase`.
- **Other**: follow language conventions (`snake_case` for Python/Rust, `camelCase` for JS/TS).

### Helpers

- Don't extract helper functions prematurely. Only create a helper if a function or identical logic appears in **2+ places** **and** extracting it reduces total code.

### Variables

- Don't assign variables that are only used once. Inline them at the call site instead.
  - Bad: `const bg = c.surfaceColor; ... backgroundColor: bg`
  - Good: `backgroundColor: c.surfaceColor`
- Exception: assigning improves readability when the expression is long or the name adds meaningful context (e.g. `firstName` from `user.name.split(" ")[0]`).

### Comments

- Don't comment things that are obvious to a developer reading the code.
- Only add comments when:
  - It's a **workaround** (e.g. library bug, platform quirk, race condition hack).
  - The **why** requires digging 3-5 layers deep into definitions/dependencies to figure out.
  - It captures a **non-obvious decision** (constraints, trade-offs, why this and not that).
- Always state **why**, not what. The code shows what; the comment justifies it.

### Detailed Code Diffs

When presenting new features, fixes, plans, or architectural changes, always show the implementation with detailed code diffs. Use `diff`-formatted blocks that include the file path and line numbers so the reader can see exactly what changed. No hand-wavy summaries — show the actual before/after.

### No Mindless `any`

In type-safe languages (TypeScript, Rust, etc.), do not use `any` / `as any` / `unknown` as a reflex to silence the type checker. First exhaust all options:
1. Import the correct type from the library or define it locally.
2. Use branded types, discriminated unions, generics, or type narrowing.
3. Cast through `unknown` with a documented reason.

Only use `any` when there truly is no defined type (dynamic JSON, plugin systems, etc.) — and document why. Every `any` is a debt: it disables type safety for that scope and hides real bugs.

### Ask Before Assuming

Interview one question at a time, recommend an answer with each, and **search the codebase first** before asking. Challenge fuzzy or overloaded terms by proposing precise canonical names. Cross-reference user claims with the actual code and surface contradictions immediately. When a term or pattern is resolved, update `AGENTS.md` inline — don't batch. Offer ADRs only when the decision is hard to reverse, surprising without context, **and** a real trade-off. **Never hallucinate or guess** — if behavior, intent, or technical detail isn't in the codebase, ask. Fix only what was asked; surface adjacent bugs instead of silently fixing them; don't add deps, change public APIs, or touch unrelated files without discussion.
