## Ground Truth

- Do not rely on training data or assume anything about this project's dependencies, APIs, or patterns. Always cross-check with:
  - Local docs under `docs/` (e.g. `docs/mastra/`, `docs/python.md`)
  - Web search / official documentation
  - The actual source code in this repo
- If docs exist for a library or tool, read them. Do not guess API signatures, config keys, or behavior.

- All initialization/bootstrap code (Mastra instance, service init, storage/vector wiring) goes in `src/lib/`. No init logic outside `src/lib/`.

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
