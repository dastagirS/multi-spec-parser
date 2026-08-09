/**
 * Build HTTP requests from extracted operations + user args.
 *
 * Covers OAS3 style/explode serialization, form-urlencoded / multipart /
 * octet-stream bodies, media upload (bodyBase64), cookie params, server URL
 * {variables} substitution, and allowReserved-aware path encoding.
 */

import type {
  ExtractedOperation,
  HttpMethod,
  NormalizedParameter,
  NormalizedRequestBody,
  ServerInfo,
} from "./types.js";

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string | FormData | Uint8Array;
}

export interface RequestBuildOptions {
  /** Base URL override; spec server (with {variables} substituted) is default. */
  baseUrl?: string;
  /** Headers applied to every request (auth etc.). */
  headers?: Record<string, string>;
  /** Query params applied to every request (integration-level). */
  queryParams?: Record<string, string>;
}

const RESERVED_UNENCODED_RE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/;

/** RFC 3986 reserved-aware encoding: allowReserved:true passes reserved chars. */
function encodeReservedAware(raw: string, allowReserved: boolean): string {
  if (!allowReserved) return encodeURIComponent(raw);
  let out = "";
  for (const ch of raw) {
    out += RESERVED_UNENCODED_RE.test(ch) ? ch : encodeURIComponent(ch);
  }
  return out;
}

export function buildRequest(
  op: ExtractedOperation,
  args: Record<string, unknown>,
  options: RequestBuildOptions = {},
): BuiltRequest {
  const headers: Record<string, string> = { ...(options.headers ?? {}) };
  const baseUrl = resolveBaseUrl(options.baseUrl, op.servers, args.server);

  const resolvedPath = resolvePath(op.path, args, op.parameters);
  const path = resolvedPath.startsWith("/") ? resolvedPath : `/${resolvedPath}`;

  const queryParams = new URLSearchParams();
  for (const [name, value] of Object.entries(options.queryParams ?? {})) {
    queryParams.set(name, value);
  }
  for (const param of op.parameters) {
    if (param.in !== "query") continue;
    const value = readParamValue(args, param);
    for (const [name, serialized] of queryParamEntries(value, param)) {
      queryParams.append(name, serialized);
    }
  }

  const queryString = queryParams.toString();
  const url = `${baseUrl}${path}${queryString ? `?${queryString}` : ""}`;

  for (const param of op.parameters) {
    if (param.in !== "header") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    headers[param.name] = String(value);
  }

  const cookieValues: string[] = [];
  for (const param of op.parameters) {
    if (param.in !== "cookie") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    cookieValues.push(`${param.name}=${primitiveToString(value)}`);
  }
  if (cookieValues.length > 0) {
    headers.Cookie = cookieValues.join("; ");
  }

  let body: string | FormData | Uint8Array | undefined;
  if (op.requestBody) {
    const encoded = encodeBody(op, args);
    if (encoded.body !== undefined) {
      body = encoded.body;
      headers["Content-Type"] = encoded.contentType;
    }
    headers.Accept = "application/json";
  }

  return { url, method: op.method, headers, ...(body !== undefined ? { body } : {}) };
}

/** Read a param from args — direct name, or nested in a container key. */
function readParamValue(args: Record<string, unknown>, param: NormalizedParameter): unknown {
  const direct = args[param.name];
  if (direct !== undefined) return direct;
  const containers: Record<NormalizedParameter["in"], string[]> = {
    path: ["path", "pathParams", "params"],
    query: ["query", "queryParams", "params"],
    header: ["headers", "header"],
    cookie: ["cookies", "cookie"],
  };
  for (const key of containers[param.in] ?? []) {
    const container = args[key];
    if (typeof container === "object" && container !== null && !Array.isArray(container)) {
      const nested = (container as Record<string, unknown>)[param.name];
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function primitiveToString(value: unknown): string {
  return typeof value === "object" && value !== null ? JSON.stringify(value) : String(value);
}

/**
 * OAS3 style/explode serialization (swagger.io/docs/specification/v3_0/serialization/).
 * Query default: form + explode:true (id=3&id=4). form+explode:false → csv.
 * spaceDelimited / pipeDelimited apply to non-exploded arrays. deepObject →
 * param[prop]=value.
 */
export function queryParamEntries(
  value: unknown,
  param: NormalizedParameter,
): Array<[string, string]> {
  if (value === undefined || value === null) return [];
  const style = param.style ?? "form";
  const explode = param.explode ?? true;

  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== undefined && v !== null,
    );
    if (style === "form") {
      if (explode) return entries.map(([n, v]) => [n, primitiveToString(v)]);
      return [[param.name, entries.flatMap(([n, v]) => [n, primitiveToString(v)]).join(",")]];
    }
    if (style === "deepObject") {
      return entries.map(([n, v]) => [`${param.name}[${n}]`, primitiveToString(v)]);
    }
    return [[param.name, primitiveToString(value)]];
  }

  if (!Array.isArray(value)) return [[param.name, primitiveToString(value)]];
  if (explode) return value.map((v) => [param.name, primitiveToString(v)]);
  const separator = style === "spaceDelimited" ? " " : style === "pipeDelimited" ? "|" : ",";
  return [[param.name, value.map(primitiveToString).join(separator)]];
}

/** Substitute {param} and {+param} placeholders; unresolved vars fail loudly. */
function resolvePath(
  pathTemplate: string,
  args: Record<string, unknown>,
  parameters: NormalizedParameter[],
): string {
  let resolved = pathTemplate;
  for (const param of parameters) {
    if (param.in !== "path") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) {
      if (param.required) {
        throw new Error(`Missing required path parameter: ${param.name}`);
      }
      continue;
    }
    const encoded = encodeReservedAware(
      String(value),
      param.allowReserved === true,
    );
    resolved = resolved.replaceAll(`{${param.name}}`, encoded);
    resolved = resolved.replaceAll(`{+${param.name}}`, encoded);
  }
  const remaining = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");
  for (const name of remaining) {
    const value = args[name];
    if (value !== undefined && value !== null) {
      resolved = resolved.replaceAll(`{${name}}`, encodeURIComponent(String(value)));
    }
  }
  const unresolved = [...resolved.matchAll(/\{([^{}]+)\}/g)]
    .map((m) => m[1])
    .filter((v): v is string => typeof v === "string");
  if (unresolved.length > 0) {
    throw new Error(`Unresolved path parameters: ${[...new Set(unresolved)].join(", ")}`);
  }
  return resolved;
}

/**
 * Serialize a request body by the declared media type. The declared content
 * type wins over the JS shape (a multipart endpoint rejects JSON framing).
 * First-declared content type by default; caller overrides via args.contentType.
 */
function encodeBody(
  op: ExtractedOperation,
  args: Record<string, unknown>,
): { body?: string | FormData | Uint8Array; contentType: string } {
  const rb = op.requestBody!;
  const contentType = (args.contentType as string | undefined) ?? rb.contentType;
  const base = baseContentType(contentType);

  // Flattened form bodies (Slack-style formData): the tool schema exposes form
  // fields at the top level of args, not under `body`. Pick those fields out so
  // `server`/`contentType`/param keys never leak into the serialized body.
  const isForm =
    base === "application/x-www-form-urlencoded" || base === "multipart/form-data";
  const formFieldNames = isForm ? formFieldNamesOf(rb) : [];
  const pickedForm = formFieldNames.length > 0 ? pickKeys(args, formFieldNames) : undefined;
  const bodyValue = args.body ?? pickedForm ?? args.input;

  // Media upload (Google uploadType=media): bytes via bodyBase64 or raw string.
  if (op.mediaUpload && base === "application/octet-stream") {
    const raw = args.bodyBase64;
    if (typeof raw === "string") {
      const bytes = base64ToUint8Array(raw);
      if (bytes) return { body: bytes, contentType };
    }
  }
  if (base === "application/octet-stream") {
    if (typeof bodyValue === "string") return { body: bodyValue, contentType };
    if (bodyValue instanceof Uint8Array) return { body: bodyValue, contentType };
    const raw = args.bodyBase64;
    if (typeof raw === "string") {
      const bytes = base64ToUint8Array(raw);
      if (bytes) return { body: bytes, contentType };
    }
  }

  if (bodyValue === undefined) return { contentType };

  if (base === "application/x-www-form-urlencoded" && isRecord(bodyValue)) {
    const parts: string[] = [];
    for (const [key, raw] of Object.entries(bodyValue)) {
      if (raw === undefined || raw === null) continue;
      if (Array.isArray(raw)) {
        for (const item of raw) {
          parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(item))}`);
        }
      } else if (typeof raw === "object") {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(JSON.stringify(raw))}`);
      } else {
        parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(raw))}`);
      }
    }
    return { body: parts.join("&"), contentType };
  }

  if (base === "multipart/form-data" && isRecord(bodyValue)) {
    const form = new FormData();
    for (const [key, raw] of Object.entries(bodyValue)) {
      if (raw === undefined || raw === null) continue;
      if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") {
        form.append(key, String(raw));
      } else if (raw instanceof Blob) {
        form.append(key, raw);
      } else if (raw instanceof Uint8Array) {
        form.append(key, new Blob([toArrayBuffer(raw)]));
      } else {
        form.append(key, JSON.stringify(raw));
      }
    }
    return { body: form, contentType };
  }

  if (typeof bodyValue === "string") return { body: bodyValue, contentType };
  return { body: JSON.stringify(bodyValue), contentType };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function baseContentType(value: string): string {
  return value.split(";")[0]!.trim().toLowerCase();
}

/** Form-field names of a form-style body schema (empty when not object-typed). */
function formFieldNamesOf(rb: NormalizedRequestBody): string[] {
  if (rb.schema?.type !== "object" || !rb.schema.properties) return [];
  return Object.keys(rb.schema.properties);
}

/** Pick args entries by name; undefined when nothing matched (→ no body). */
function pickKeys(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let picked = 0;
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key];
      picked += 1;
    }
  }
  return picked > 0 ? out : undefined;
}

/** Copy a Uint8Array into a fresh ArrayBuffer — Node's BodyInit types reject
 *  SharedArrayBuffer-backed views, and fetch shouldn't share the buffer anyway. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}

function toBodyInit(body: BuiltRequest["body"]): BodyInit | undefined {
  if (body === undefined || typeof body === "string" || body instanceof FormData) return body;
  return toArrayBuffer(body);
}

function base64ToUint8Array(value: string): Uint8Array | null {
  const compact = value.replace(/\s/g, "");
  let binary: string;
  try {
    binary = atob(compact);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Resolve base URL: override wins; else first server with {variables} filled
 *  from args.server (overrides) and spec defaults. */
function resolveBaseUrl(
  override: string | undefined,
  servers: ServerInfo[] | undefined,
  serverArg: unknown,
): string {
  if (override) {
    const server = servers?.[0];
    // Relative spec servers (petstore3 ships "/api/v3") resolve against the
    // override as origin; absolute servers are replaced outright.
    if (server?.url.startsWith("/")) {
      try {
        const origin = override.endsWith("/") ? override : `${override}/`;
        return new URL(server.url, origin).toString().replace(/\/+$/, "");
      } catch {
        // Non-URL override (e.g. a bare host) — fall through to plain override.
      }
    }
    return override.replace(/\/+$/, "");
  }
  const server = servers?.[0];
  if (!server) return "";
  let url = server.url;
  const arg = (
    typeof serverArg === "object" && serverArg !== null && !Array.isArray(serverArg)
      ? serverArg
      : {}
  ) as { url?: unknown; variables?: Record<string, unknown> };
  const chosen = servers!.find((s) => s.url === arg.url) ?? server;
  url = chosen.url;
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(chosen.variables ?? {})) {
    values[name] = v.default;
  }
  for (const [name, value] of Object.entries(arg.variables ?? {})) {
    if (value != null && value !== "") values[name] = String(value);
  }
  for (const [name, value] of Object.entries(values)) {
    url = url.replaceAll(`{${name}}`, value);
  }
  return url.replace(/\/+$/, "");
}

export interface ExecuteOptions {
  timeoutMs?: number;
}

export interface ExecuteResult {
  status: "success" | "error";
  data: unknown;
  httpStatus: number;
  error?: string;
}

/** Execute a built request with a timeout; JSON body parsed, text fallback. */
export async function executeRequest(
  request: BuiltRequest,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 30_000);
  try {
    const res = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: toBodyInit(request.body),
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (res.status === 204) {
      return { status: "success", data: null, httpStatus: 204 };
    }
    const contentType = res.headers.get("content-type") ?? "";
    let data: unknown;
    if (contentType.includes("json")) {
      try {
        data = await res.json();
      } catch {
        data = await res.text();
      }
    } else {
      data = await res.text();
    }
    if (!res.ok) {
      return {
        status: "error",
        data,
        httpStatus: res.status,
        error: extractErrorMessage(data, res.status),
      };
    }
    return { status: "success", data, httpStatus: res.status };
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof DOMException && err.name === "AbortError") {
      return { status: "error", data: null, httpStatus: 0, error: "Request timed out" };
    }
    return {
      status: "error",
      data: null,
      httpStatus: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function extractErrorMessage(data: unknown, status: number): string {
  if (typeof data === "string") return data.length > 0 ? data : `HTTP ${status}`;
  if (data !== null && typeof data === "object") {
    const record = data as Record<string, unknown>;
    const nested = record.error;
    if (typeof nested === "object" && nested !== null) {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string") return message;
    }
    if (typeof record.message === "string") return record.message;
    if (typeof record.error === "string") return record.error;
  }
  return `HTTP ${status}`;
}
