/**
 * Lazy JSON-Pointer $ref resolution against a parsed document.
 *
 * Resolves refs on demand; never dereferences whole documents. Per-op schemas
 * keep `$ref`s as strings so the shared component schemas are referenced, not
 * copied (the memory fix — embedding clones per operation is what OOM'd the
 * old pipeline on GitHub's 1220-ops × 969-schemas spec).
 */

import type { RefObject } from "./types.js";

export function isRef(value: unknown): value is RefObject {
  return typeof value === "object" && value !== null && "$ref" in value;
}

export class DocResolver {
  constructor(readonly doc: Record<string, unknown>) {}

  /** Resolve a value that may be a $ref; null when the pointer misses. */
  resolve<T>(value: T | RefObject): T | null {
    if (isRef(value)) {
      return this.resolvePointer(value.$ref) as T | null;
    }
    return value as T;
  }

  /**
   * Resolve an internal JSON Pointer (#/a/b/c). External refs (other files,
   * http://...) return null and are collected as unresolved instead. A miss
   * on the FINAL segment returns null too (a pointer walking into undefined
   * is a dangling ref, not a value).
   */
  resolvePointer(ref: string): unknown {
    if (!ref.startsWith("#/")) return null;
    let current: unknown = this.doc;
    for (const segment of ref.slice(2).split("/")) {
      if (typeof current !== "object" || current === null) return null;
      current = (current as Record<string, unknown>)[decodePointerSegment(segment)];
      if (current === undefined) return null;
    }
    return current;
  }
}

/** JSON Pointer segment unescaping (~1 → /, ~0 → ~). */
function decodePointerSegment(segment: string): string {
  return segment.replace(/~1/g, "/").replace(/~0/g, "~");
}
