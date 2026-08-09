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

/** Rewrite schema refs to #/$defs/X. One pass; returns the same object when
 *  nothing changed (no clone on the common no-ref path). */
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
        out[k] = n;
      }
      return changed ? out : obj;
    }
    return obj;
  }
  let changed = false;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = normalizeSchemaRefs(v);
    if (n !== v) changed = true;
    out[k] = n;
  }
  return changed ? out : obj;
}

/** Hoist + normalize every component schema once per spec. */
export function normalizeDefs(
  schemas: Record<string, SchemaObject>,
): Record<string, SchemaObject> {
  const out: Record<string, SchemaObject> = {};
  for (const [name, schema] of Object.entries(schemas)) {
    out[name] = normalizeSchemaRefs(schema) as SchemaObject;
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
    result[name] = def;
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
 */
export function removeDanglingRefs(
  node: unknown,
  valid: ReadonlySet<string>,
  pruned: Set<string>,
): unknown {
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((item) => {
      const n = removeDanglingRefs(item, valid, pruned);
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
    const n = removeDanglingRefs(v, valid, pruned);
    if (n !== v) changed = true;
    out[k] = n;
  }
  return changed ? out : obj;
}

/** JSON Pointer tilde-unescape for schema names embedded in refs. */
function decodeRefSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
