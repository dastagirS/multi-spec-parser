/**
 * Build HTTP requests from extracted operations + user args.
 *
 * Covers OAS3 style/explode serialization, form-urlencoded / multipart /
 * octet-stream bodies (base64 via bodyBase64), cookie params, server URL
 * {variables} substitution, and allowReserved-aware path encoding.
 */

import type {
  ExtractedOperation,
  HttpMethod,
  NormalizedParameter,
  NormalizedRequestBody,
  ServerInfo,
} from "./types.js";
import { setOwn } from "./schema-closure.js";

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string | FormData | Uint8Array;
}

export interface TransportRequest {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: BodyInit;
  signal: AbortSignal;
}

/** Optional request transport. The default adapter uses global fetch. */
export type RequestTransport = (request: TransportRequest) => Promise<Response>;

export interface RequestBuildOptions {
  /** Base URL override; spec server (with {variables} substituted) is default. */
  baseUrl?: string;
  /** Headers applied to every request (auth etc.). */
  headers?: Record<string, string>;
  /** Query params applied to every request (integration-level). */
  queryParams?: Record<string, string>;
  /** Path template override; {placeholders} still resolve against the op's
   *  params. E.g. a Google Discovery media-upload path, which shares the
   *  regular op's placeholders — the consumer owns the protocol, the
   *  primitive does the substitution. */
  path?: string;
}

const RESERVED_UNENCODED_RE = /[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=]/;
const DEFAULT_MAX_RESPONSE_BODY_BYTES = 50 * 1024 * 1024;

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
  const serverArgument = hasOwn(args, "server") ? args.server : undefined;
  const baseUrl = resolveBaseUrl(options.baseUrl, op.servers, serverArgument);

  const pathTemplate = options.path ?? op.path;
  const resolvedPath = resolvePath(pathTemplate, args, op.parameters);
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
    setOwn(headers, param.name, String(value));
  }

  const cookieValues: string[] = [];
  for (const param of op.parameters) {
    if (param.in !== "cookie") continue;
    const value = readParamValue(args, param);
    if (value === undefined || value === null) continue;
    // Percent-encode: cookie values with spaces/semicolons would corrupt the
    // Cookie header framing otherwise (I6).
    cookieValues.push(
      `${encodeURIComponent(param.name)}=${encodeURIComponent(primitiveToString(value))}`,
    );
  }
  if (cookieValues.length > 0) {
    headers.Cookie = cookieValues.join("; ");
  }

  headers.Accept = "application/json"; // every request, not just body-bearing ones (G4)

  let body: string | FormData | Uint8Array | undefined;
  if (op.requestBody) {
    const encoded = encodeBody(op, args);
    if (encoded.body !== undefined) {
      body = encoded.body;
      headers["Content-Type"] = encoded.contentType;
    }
  }

  return { url, method: op.method, headers, ...(body !== undefined ? { body } : {}) };
}

/** Read a param from args — direct name, or nested in a container key. */
function readParamValue(args: Record<string, unknown>, param: NormalizedParameter): unknown {
  const inputName = param.inputName ?? param.name;
  const direct = Object.hasOwn(args, inputName) ? args[inputName] : undefined;
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
      const nested = Object.hasOwn(container, inputName)
        ? (container as Record<string, unknown>)[inputName]
        : undefined;
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
    const value = Object.hasOwn(args, name) ? args[name] : undefined;
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
  const contentType = (hasOwn(args, "contentType") && typeof args.contentType === "string"
    ? args.contentType
    : undefined) ?? rb.contentType;
  const base = baseContentType(contentType);

  // Flattened form bodies (Slack-style formData): the tool schema exposes form
  // fields at the top level of args, not under `body`. Pick those fields out so
  // `server`/`contentType`/param keys never leak into the serialized body.
  const isForm =
    base === "application/x-www-form-urlencoded" || base === "multipart/form-data";
  const formFieldNames = isForm ? formFieldNamesOf(rb) : [];
  const pickedForm = formFieldNames.length > 0 ? pickKeys(args, formFieldNames) : undefined;
  // args.body only — `input` was an undocumented backdoor that silently became
  // the body for consumers guessing at naming (G3).
  const bodyValue = (hasOwn(args, "body") ? args.body : undefined) ?? pickedForm;

  if (base === "application/octet-stream") {
    if (typeof bodyValue === "string") return { body: bodyValue, contentType };
    if (bodyValue instanceof Uint8Array) return { body: bodyValue, contentType };
    const raw = hasOwn(args, "bodyBase64") ? args.bodyBase64 : undefined;
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
    if (hasOwn(source, key) && source[key] !== undefined) {
      setOwn(out, key, source[key]);
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
  const arg = normalizeServerArgument(serverArg);
  const chosen = servers!.find((candidate) => candidate.url === arg.url) ?? server;
  url = chosen.url;
  const values: Record<string, string> = {};
  for (const [name, v] of Object.entries(chosen.variables ?? {})) {
    setOwn(values, name, v.default);
  }
  for (const [name, value] of Object.entries(arg.variables ?? {})) {
    if (value != null && value !== "") setOwn(values, name, String(value));
  }
  for (const [name, value] of Object.entries(values)) {
    url = url.replaceAll(`{${name}}`, value);
  }
  return url.replace(/\/+$/, "");
}

export type ExecuteErrorCode =
  | "TIMEOUT"
  | "ABORTED"
  | "NETWORK_ERROR"
  | "HTTP_ERROR"
  | "RESPONSE_TOO_LARGE"
  | "INVALID_RESPONSE"
  | "INVALID_REQUEST";

export interface ExecuteErrorDetails {
  code: ExecuteErrorCode;
  message: string;
  httpStatus?: number;
  url: string;
  method: HttpMethod;
  contentType?: string;
  retryCount: number;
  causeMessage?: string;
}

export interface ExecuteResponseMetadata {
  url: string;
  status: number;
  headers: Record<string, string>;
  contentType?: string;
}

export interface ExecuteOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  maxResponseBodyBytes?: number;
  retryCount?: number;
  transport?: RequestTransport;
}

export interface ExecuteRequestOptions extends RequestBuildOptions {
  timeoutMs?: number;
  maxResponseBodyBytes?: number;
  signal?: AbortSignal;
  /** Opaque execution-local dependencies for runtime hooks only. */
  runtimeContext?: unknown;
  /** Execution-local transport; overrides the parser default. */
  transport?: RequestTransport;
  /** Execution-local 401 refresh callback; returns an Authorization value. */
  onUnauthorized?: () => string | Promise<string>;
}

export interface ExecuteResult {
  status: "success" | "error" | "truncated";
  data: unknown;
  httpStatus: number;
  error?: string;
  errorDetails?: ExecuteErrorDetails;
  response?: ExecuteResponseMetadata;
  /** Item 4: serialized size that exceeded maxResponseBytes (truncated only). */
  size?: number;
  /** Item 4: tool whose result was truncated (truncated only). */
  toolName?: string;
  /** Item 4: what the LLM/storage layer sees instead of the blob. */
  message?: string;
}

/** Execute a built request with a timeout; JSON body parsed, text fallback.
 *  The timeout covers the body read too — clearing right after fetch() resolves
 *  would leave a slow download unbounded (G8). */
export async function executeRequest(
  request: BuiltRequest,
  options: ExecuteOptions = {},
): Promise<ExecuteResult> {
  const retryCount = options.retryCount ?? 0;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const signal = combineSignals(options.signal, timeoutMs);
  try {
    const responseTransport = options.transport ?? defaultRequestTransport;
    const response = await responseTransport({
      url: request.url,
      method: request.method,
      headers: request.headers,
      body: toBodyInit(request.body),
      signal,
    });
    const metadata = responseMetadata(response, request);
    if (response.status === 204) {
      return { status: "success", data: null, httpStatus: 204, response: metadata };
    }
    const body = await readResponseBody(response, options.maxResponseBodyBytes ?? DEFAULT_MAX_RESPONSE_BODY_BYTES);
    if (body.tooLarge) {
      return {
        status: "truncated",
        data: null,
        httpStatus: response.status,
        response: metadata,
        size: body.size,
        message: `Response exceeded the ${body.limit}-byte body limit.`,
        errorDetails: errorDetails("RESPONSE_TOO_LARGE", `Response exceeded the ${body.limit}-byte body limit.`, request, response, retryCount, metadata.contentType),
      };
    }
    const data = decodeResponseBody(body.bytes, metadata.contentType);
    if (!response.ok) {
      const message = extractErrorMessage(data, response.status);
      return {
        status: "error",
        data,
        httpStatus: response.status,
        error: message,
        response: metadata,
        errorDetails: errorDetails("HTTP_ERROR", message, request, response, retryCount, metadata.contentType),
      };
    }
    return { status: "success", data, httpStatus: response.status, response: metadata };
  } catch (error: unknown) {
    const aborted = error instanceof DOMException && error.name === "AbortError";
    const callerAborted = options.signal?.aborted === true;
    const code: ExecuteErrorCode = callerAborted ? "ABORTED" : aborted ? "TIMEOUT" : "NETWORK_ERROR";
    const message = callerAborted ? "Request aborted" : aborted ? "Request timed out" : error instanceof Error ? error.message : String(error);
    return {
      status: "error",
      data: null,
      httpStatus: 0,
      error: message,
      errorDetails: { code, message, url: request.url, method: request.method, retryCount, causeMessage: error instanceof Error ? error.message : String(error) },
    };
  }
}

interface BoundedResponseBody {
  bytes: Uint8Array;
  size: number;
  tooLarge: boolean;
  limit: number;
}

const defaultRequestTransport: RequestTransport = async (request) =>
  fetch(request.url, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  });

function combineSignals(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
}

async function readResponseBody(response: Response, limit: number): Promise<BoundedResponseBody> {
  if (!response.body) return { bytes: new Uint8Array(), size: 0, tooLarge: false, limit };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return { bytes: new Uint8Array(), size, tooLarge: true, limit };
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, size, tooLarge: false, limit };
}

function decodeResponseBody(bytes: Uint8Array, contentType: string | undefined): unknown {
  const text = new TextDecoder().decode(bytes);
  if (!contentType?.includes("json")) return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function responseMetadata(response: Response, request: BuiltRequest): ExecuteResponseMetadata {
  const headers: Record<string, string> = {};
  for (const [name, value] of response.headers) setOwn(headers, name, value);
  const contentType = response.headers.get("content-type") ?? undefined;
  return {
    url: response.url || request.url,
    status: response.status,
    headers,
    ...(contentType ? { contentType } : {}),
  };
}

function errorDetails(
  code: ExecuteErrorCode,
  message: string,
  request: BuiltRequest,
  response: Response,
  retryCount: number,
  contentType: string | undefined,
): ExecuteErrorDetails {
  return {
    code,
    message,
    httpStatus: response.status,
    url: request.url,
    method: request.method,
    ...(contentType ? { contentType } : {}),
    retryCount,
  };
}

function normalizeServerArgument(serverArgument: unknown): {
  url?: unknown;
  variables?: Record<string, unknown>;
} {
  if (typeof serverArgument !== "object" || serverArgument === null || Array.isArray(serverArgument)) {
    return {};
  }
  const source = serverArgument as Record<string, unknown>;
  const result: { url?: unknown; variables?: Record<string, unknown> } = {};
  if (hasOwn(source, "url")) result.url = source.url;
  if (hasOwn(source, "variables") && isRecord(source.variables)) {
    result.variables = source.variables;
  }
  return result;
}

function hasOwn(object: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
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
