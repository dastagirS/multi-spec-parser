import assert from "node:assert/strict";

const MAX_VALIDATION_HEAD_BYTES = 4 * 1024;
const MAX_URL_LENGTH = 8 * 1024;

export type SpecValidationResult =
  | { ok: true; kind: "unknown" | "openapi" | "swagger" }
  | { ok: false; reason: string };

/** Reject URLs that are structurally unlikely to identify a specification. */
export function validateSpecUrl(url: string): void {
  assert(typeof url === "string", "spec URL must be a string");
  assert(url.length <= MAX_URL_LENGTH, `spec URL exceeds ${MAX_URL_LENGTH} characters`);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("Spec URL is not a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Spec URL must use http or https.");
  }
  if (/\/oauth(?:\/|$)|\/authorize(?:[/?#]|$)/i.test(parsed.pathname)) {
    throw new Error("Spec URL points to an OAuth endpoint, not a specification.");
  }
}

/** Classify obvious non-spec responses before the parser reports a generic error. */
export function validateSpecText(
  text: string,
  contentType: string | null = null,
): SpecValidationResult {
  assert(typeof text === "string", "spec text must be a string");
  assert(contentType === null || typeof contentType === "string", "content type must be string or null");
  const head = text.slice(0, MAX_VALIDATION_HEAD_BYTES);
  if (isHtml(contentType, head)) {
    return { ok: false, reason: "the response is an HTML page, not a specification" };
  }
  if (/^\s*asyncapi\s*:/im.test(head) || /["']asyncapi["']\s*:/i.test(head)) {
    return { ok: false, reason: "the document is AsyncAPI, not an OpenAPI specification" };
  }
  if (text.includes('"_postman_id"') || /"item"\s*:\s*\[/i.test(head)) {
    return { ok: false, reason: "the document is a Postman collection, not an OpenAPI specification" };
  }
  if (/["']error["']\s*:\s*["'](?:invalid_client|invalid_request|unauthorized_client)["']/i.test(head)) {
    return { ok: false, reason: "the response is an OAuth error, not a specification" };
  }
  if (/^\s*openapi\s*:/im.test(head) || /["']openapi["']\s*:/i.test(head)) {
    return { ok: true, kind: "openapi" };
  }
  if (/^\s*swagger\s*:/im.test(head) || /["']swagger["']\s*:/i.test(head)) {
    return { ok: true, kind: "swagger" };
  }
  return { ok: true, kind: "unknown" };
}

export function assertValidSpecText(text: string, contentType: string | null = null): void {
  assert(typeof text === "string", "spec text must be a string");
  assert(contentType === null || typeof contentType === "string", "content type must be string or null");
  const result = validateSpecText(text, contentType);
  if (!result.ok) throw new Error(`Spec document rejected: ${result.reason}.`);
}

function isHtml(contentType: string | null, head: string): boolean {
  assert(contentType === null || typeof contentType === "string", "content type must be string or null");
  assert(typeof head === "string", "spec head must be a string");
  return Boolean(contentType && /text\/html/i.test(contentType)) || /<!doctype\s+html|<html[\s>]/i.test(head);
}
