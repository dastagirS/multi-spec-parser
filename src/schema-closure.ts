/**
 * Shared-schema hoisting + per-tool reachable-defs closure.
 *
 * Component schemas are normalized ONCE per spec and referenced (never cloned)
 * by every tool. Each tool then attaches only the transitive $ref closure its
 * own input schema reaches, so per-tool $defs are KBs instead of the full spec.
 * This is the fix for the OOM (embedding all schemas per operation) and for
 * opaque $refs (the LLM finally sees the resolved shape of a $ref parameter).
 */

import type { SchemaObject } from "./types.js";

const SCHEMA_REF_RE = /^#\/(?:components\/schemas|\$defs|definitions)\/(.+)$/;

/**
 * Own-property write that survives the __proto__ prototype trap: assigning
 * `obj["__proto__"] = value` on a plain object triggers the prototype setter
 * and silently DROPS the key. Spec content (schema names, property names, param
 * names) can legitimately be "__proto__" (N1).
 */
export function setOwn(obj: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(obj, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    obj[key] = value;
  }
}

/**
 * Rewrite refs and nullable markers with an explicit stack. Spec documents are
 * external input, so iterative traversal prevents aliases or deep schemas from
 * exhausting the JavaScript call stack.
 */
export function normalizeSchemaRefs(node: unknown): unknown {
  if (node === null || typeof node !== "object") return node;
  const states = new WeakMap<object, 1 | 2>();
  const results = new WeakMap<object, unknown>();
  const stack: Array<{ value: object; exit: boolean; depth: number }> = [
    { value: node, exit: false, depth: 0 },
  ];
  let visited = 0;
  while (stack.length > 0) {
    const frame = stack.pop()!;
    const current = frame.value;
    if (frame.depth > MAX_SCHEMA_DEPTH) throw new Error("Schema nesting exceeds the supported depth");
    if (!frame.exit) {
      const state = states.get(current);
      if (state === 1) throw new Error("Cyclic schema object is not supported");
      if (state === 2) continue;
      states.set(current, 1);
      visited += 1;
      if (visited > MAX_SCHEMA_NODES) throw new Error("Schema exceeds the supported node limit");
      if (isExternalRef(current)) {
        results.set(current, current);
        states.set(current, 2);
        continue;
      }
      stack.push({ value: current, exit: true, depth: frame.depth });
      const children = Array.isArray(current)
        ? current
        : Object.entries(current).filter(([key]) => key !== "$ref").map(([, value]) => value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== null && typeof child === "object") {
          stack.push({ value: child, exit: false, depth: frame.depth + 1 });
        }
      }
      continue;
    }
    const original = current;
    let changed = false;
    if (Array.isArray(original)) {
      const output = original.map((child) => {
        const replacement = child !== null && typeof child === "object" ? results.get(child) : child;
        if (replacement !== child) changed = true;
        return replacement;
      });
      results.set(original, changed ? output : original);
      states.set(original, 2);
      continue;
    }
    const source = original as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    const reference = typeof source.$ref === "string" ? source.$ref.match(SCHEMA_REF_RE) : null;
    for (const [key, value] of Object.entries(source)) {
      const replacement = key === "$ref"
        ? reference ? `#/$defs/${reference[1]}` : value
        : value !== null && typeof value === "object" ? results.get(value) : value;
      if (replacement !== value) changed = true;
      setOwn(output, key, replacement);
    }
    const converted = applyNullable(output);
    results.set(original, converted !== output || changed ? converted : original);
    states.set(original, 2);
  }
  return results.get(node);
}

const MAX_SCHEMA_DEPTH = 512;
const MAX_SCHEMA_NODES = 1_000_000;

function isExternalRef(value: object): boolean {
  const reference = (value as Record<string, unknown>).$ref;
  return typeof reference === "string" && !reference.match(SCHEMA_REF_RE);
}

/**
 * OAS 3.0 `nullable: true` → draft-07-valid shape. Always returns a NEW object
 * when `nullable` is present (never mutates the shared input), so the
 * no-clone-on-no-change path stays intact. `nullable: false` → dropped.
 */
function applyNullable(node: Record<string, unknown>): Record<string, unknown> {
  if (typeof node.nullable !== "boolean") return node;
  // Destructuring out `nullable` creates a fresh object via CreateDataProperty
  // (safe for __proto__ keys, unlike bracket assignment).
  const { nullable, ...rest } = node;
  if (!nullable) return rest;
  if (typeof rest.type === "string") {
    return { ...rest, type: [rest.type, "null"] };
  }
  if (Array.isArray(rest.type)) {
    return rest.type.includes("null") ? rest : { ...rest, type: [...rest.type, "null"] };
  }
  if (typeof rest.$ref === "string") {
    // $ref siblings are ignored by draft-07, so wrap: ref-or-null. The $ref
    // node keeps its description etc. for the LLM.
    return { anyOf: [rest, { type: "null" }] };
  }
  if (Array.isArray(rest.enum)) {
    return rest.enum.includes(null) ? rest : { ...rest, enum: [...rest.enum, null] };
  }
  // No type/ref/enum: unconstrained already admits null — drop the keyword.
  return rest;
}

/** Hoist + normalize every component schema once per spec. */
export function normalizeDefs(
  schemas: Record<string, SchemaObject>,
): Record<string, SchemaObject> {
  const out: Record<string, SchemaObject> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    setOwn(out, name, normalizeSchemaRefs(schema) as SchemaObject);
  }
  return out;
}

/**
 * BFS the transitive $ref closure of `roots` against `defs`. The generic
 * recursive scan covers properties / items / additionalProperties / allOf /
 * oneOf / anyOf / not / discriminator without enumerating each keyword.
 * Dangling refs (e.g. Booking's external file refs) are skipped, not thrown.
 */
export function collectReachableDefs(
  roots: readonly unknown[],
  defs: Record<string, SchemaObject>,
): Record<string, SchemaObject> {
  const wanted = new Set<string>();
  for (const root of roots) collectRefNames(root, wanted);

  const result: Record<string, SchemaObject> = {};
  const queue = [...wanted];
  for (let i = 0; i < queue.length; i += 1) {
    const name = queue[i]!;
    if (Object.prototype.hasOwnProperty.call(result, name)) continue;
    if (!Object.prototype.hasOwnProperty.call(defs, name)) continue;
    const def = defs[name];
    if (def === undefined) continue;
    setOwn(result, name, def);
    const next = new Set<string>();
    collectRefNames(def, next);
    for (const ref of next) {
      if (!Object.prototype.hasOwnProperty.call(result, ref)) queue.push(ref);
    }
  }
  return result;
}

/** Collect refs with an explicit stack so hostile schema depth cannot overflow. */
export function collectRefNames(node: unknown, into: Set<string>): void {
  if (node === null || typeof node !== "object") return;
  const pending: unknown[] = [node];
  const visited = new WeakSet<object>();
  let count = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    if (visited.has(current)) continue;
    visited.add(current);
    count += 1;
    if (count > MAX_SCHEMA_NODES) throw new Error("Schema exceeds the supported node limit");
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    for (const [key, value] of Object.entries(current)) {
      if (key === "$ref") {
        if (typeof value === "string") {
          const match = value.match(SCHEMA_REF_RE);
          if (match) into.add(decodeRefSegment(match[1]!));
        }
      } else {
        pending.push(value);
      }
    }
  }
}

/** Remove dangling refs with an explicit stack and bounded traversal. */
export function removeDanglingRefs(
  node: unknown,
  valid: ReadonlySet<string>,
  pruned: Set<string>,
  skipKey?: string,
): unknown {
  if (node === null || typeof node !== "object") return node;
  const states = new WeakMap<object, 1 | 2>();
  const results = new WeakMap<object, unknown>();
  const pending: Array<{ value: object; exit: boolean; depth: number }> = [
    { value: node, exit: false, depth: 0 },
  ];
  let visited = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    const current = frame.value;
    if (frame.depth > MAX_SCHEMA_DEPTH) throw new Error("Schema nesting exceeds the supported depth");
    if (!frame.exit) {
      const state = states.get(current);
      if (state === 1) throw new Error("Cyclic schema object is not supported");
      if (state === 2) continue;
      states.set(current, 1);
      visited += 1;
      if (visited > MAX_SCHEMA_NODES) throw new Error("Schema exceeds the supported node limit");
      if (!Array.isArray(current)) {
        const reference = (current as Record<string, unknown>).$ref;
        if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
          const name = decodeRefSegment(reference.slice("#/$defs/".length));
          if (!valid.has(name)) {
            pruned.add(reference);
            results.set(current, {});
            states.set(current, 2);
            continue;
          }
        }
      }
      pending.push({ value: current, exit: true, depth: frame.depth });
      const children = Array.isArray(current)
        ? current.map((value) => value)
        : Object.entries(current).filter(([key]) => key !== skipKey).map(([, value]) => value);
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child !== null && typeof child === "object") pending.push({ value: child, exit: false, depth: frame.depth + 1 });
      }
      continue;
    }
    let changed = false;
    if (Array.isArray(current)) {
      const output = current.map((child) => {
        const replacement = child !== null && typeof child === "object" ? results.get(child) : child;
        if (replacement !== child) changed = true;
        return replacement;
      });
      results.set(current, changed ? output : current);
      states.set(current, 2);
      continue;
    }
    const output: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(current)) {
      const replacement = key === skipKey
        ? value
        : value !== null && typeof value === "object" ? results.get(value) : value;
      if (replacement !== value) changed = true;
      setOwn(output, key, replacement);
    }
    results.set(current, changed ? output : current);
    states.set(current, 2);
  }
  return results.get(node);
}

/** JSON Pointer tilde-unescape for schema names embedded in refs. */
function decodeRefSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
