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
 * Rewrite schema refs to #/$defs/X AND convert OAS 3.0 `nullable` into
 * draft-07-valid shapes (PR4): `type` → [type, "null"], `$ref` → anyOf with
 * {type:"null"}, `enum` → append null. One pass; returns the same object when
 * nothing changed (no clone on the common no-ref/no-nullable path).
 */
export function normalizeSchemaRefs(node: unknown): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = normalizeSchemaRefs(item);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string") {
    const m = obj.$ref.match(SCHEMA_REF_RE);
    // $ref may carry siblings (OpenAPI 3.1 allows description/summary); those
    // siblings must be normalized too, so recurse instead of returning early.
    if (m) {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        const n = k === "$ref" ? `#/$defs/${m[1]}` : normalizeSchemaRefs(v);
        if (n !== v) changed = true;
        setOwn(out, k, n);
      }
      const converted = applyNullable(out);
      return converted !== out || changed ? converted : obj;
    }
    return obj;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeSchemaRefs(v);
    if (n !== v) changed = true;
    setOwn(out, k, n);
  }
  const converted = applyNullable(out);
  return converted !== out || changed ? converted : obj;
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
    if (name in result) continue;
    const def = defs[name];
    if (!def) continue;
    setOwn(result, name, def);
    const next = new Set<string>();
    collectRefNames(def, next);
    for (const ref of next) {
      if (!(ref in result)) queue.push(ref);
    }
  }
  return result;
}

/** Collect the names of every schema ref reachable in `node`, without resolving.
 *  Only `$ref` KEY values count — a description/enum/example string that merely
 *  looks like a ref must not pull defs into a tool's closure (G10). Bare
 *  strings are never refs (a `$ref` value is always reached via its key). */
export function collectRefNames(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefNames(item, into);
    return;
  }
  if (node === null || typeof node !== "object") return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "$ref") {
      if (typeof value === "string") {
        const m = value.match(SCHEMA_REF_RE);
        if (m) into.add(decodeRefSegment(m[1]!));
      }
    } else {
      collectRefNames(value, into);
    }
  }
}

/**
 * Remove dangling $refs (pointing at names missing from `valid`) from a
 * schema graph, replacing them with `{}` (anything allowed) so the schema
 * stays Ajv-compilable. Returns a NEW graph when anything changed, else the
 * same node (mirrors normalizeSchemaRefs' no-clone-on-no-change path — the
 * memory model depends on it). Pruned names are collected into `pruned`.
 *
 * `skipKey` (e.g. "$defs") stops recursion into one subtree, keeping it by
 * reference — used by the per-tool pass, which relies on the shared defs
 * having been pruned once globally (P1).
 */
export function removeDanglingRefs(
  node: unknown,
  valid: ReadonlySet<string>,
  pruned: Set<string>,
  skipKey?: string,
): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = removeDanglingRefs(item, valid, pruned, skipKey);
      if (n !== item) changed = true;
      return n;
    });
    return changed ? out : node;
  }
  if (node === null || typeof node !== "object") return node;
  const obj = node as Record<string, unknown>;
  if (typeof obj.$ref === "string" && obj.$ref.startsWith("#/$defs/")) {
    const name = decodeRefSegment(obj.$ref.slice("#/$defs/".length));
    if (!valid.has(name)) {
      pruned.add(obj.$ref);
      return {}; // dangling ref → unconstrained rather than broken
    }
    return obj;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === skipKey) {
      setOwn(out, k, v);
      continue;
    }
    const n = removeDanglingRefs(v, valid, pruned, skipKey);
    if (n !== v) changed = true;
    setOwn(out, k, n);
  }
  return changed ? out : obj;
}

/** JSON Pointer tilde-unescape for schema names embedded in refs. */
function decodeRefSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
