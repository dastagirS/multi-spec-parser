/**
 * Parse OpenAPI 3.x, Swagger 2.0, and Google Discovery specs into the
 * normalized model. Format is detected from CONTENT (never the URL/extension —
 * Booking's documented download is .yaml under a JSON-variant URL).
 */

import { load as yamlLoad } from "js-yaml";

import { DocResolver, isRef } from "./ref-resolver.js";
import { setOwn } from "./schema-closure.js";
import type {
  ExtractedOperation,
  GoogleDiscoveryDoc,
  GoogleMethodObject,
  GoogleParameterObject,
  GoogleResourceObject,
  GoogleSchemaObject,
  HttpMethod,
  NormalizedParameter,
  NormalizedRequestBody,
  OpenApi3PathItem,
  OpenApi3Spec,
  OperationObject,
  ParameterObject,
  ParsedSpec,
  RefObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  ServerInfo,
  SpecFormat,
  Swagger2Operation,
  Swagger2Parameter,
  Swagger2PathItem,
  Swagger2Response,
  Swagger2Spec,
} from "./types.js";

const HTTP_METHODS = ["get", "put", "post", "patch", "delete", "head", "options", "trace"] as const;

const VALID_PARAM_LOCATIONS = new Set(["query", "path", "header", "cookie"]);
const VALID_SCHEMA_TYPES = new Set([
  "array",
  "boolean",
  "integer",
  "null",
  "number",
  "object",
  "string",
]);

/** NDJSON media types: the body is one JSON doc per line (e.g. Vercel logs). */
const NDJSON_MEDIA_TYPES = new Set(["application/stream+json", "application/x-ndjson", "application/jsonl"]);

/** Guard against hung/failed fetches: parse() must not hang forever (G6). */
const FETCH_TIMEOUT_MS = 60_000;
const MAX_SPEC_BYTES = 200 * 1024 * 1024;

function isNdjsonMediaType(mediaType: string): boolean {
  return NDJSON_MEDIA_TYPES.has(mediaType.split(";")[0]!.trim().toLowerCase());
}

// ---------------------------------------------------------------------------
// Fetch + text parsing
// ---------------------------------------------------------------------------

/** Fetch spec text — never res.json(): YAML specs (Booking) fail JSON parsing. */
export async function fetchSpecText(url: string): Promise<string> {
  const res = await fetch(url, {
    headers: { Accept: "application/json, application/yaml, text/yaml, */*" },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch spec: ${res.status} ${res.statusText}`);
  }
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > MAX_SPEC_BYTES) {
    throw new Error(
      `Spec too large: content-length ${contentLength} bytes exceeds ${MAX_SPEC_BYTES} byte limit`,
    );
  }
  return await res.text();
}

/** Parse spec text as JSON when it looks like JSON, else YAML. */
export function parseSpecText(text: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("Spec document is empty");
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      // Not valid JSON — fall through to YAML (JSON is a YAML subset).
    }
  }
  const parsed = (() => {
    try {
      return yamlLoad(trimmed, { json: true }) as unknown;
    } catch (err) {
      // Not JSON and not YAML — surface both attempts (I5).
      throw new Error(
        `Spec document is not valid JSON or YAML: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  })();
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Spec document must parse to an object");
  }
  return parsed as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

export function detectSpecFormat(obj: Record<string, unknown>): SpecFormat {
  if (typeof obj.openapi === "string" && obj.openapi.startsWith("3.")) return "openapi3";
  if (obj.swagger === "2.0") return "swagger2";
  if (obj.kind === "discovery#restDescription" && typeof obj.rootUrl === "string") {
    return "google-discovery";
  }
  throw new Error(
    "Unrecognized spec format. Expected OpenAPI 3.x (openapi: '3.x'), " +
      "Swagger 2.0 (swagger: '2.0'), or Google Discovery (kind: 'discovery#restDescription').",
  );
}

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

/** Parse a parsed spec object into the normalized model. */
export function parseSpec(specObj: Record<string, unknown>): ParsedSpec {
  const specFormat = detectSpecFormat(specObj);
  switch (specFormat) {
    case "openapi3":
      return parseOpenApi3(specObj as unknown as OpenApi3Spec);
    case "swagger2":
      return parseSwagger2(specObj as unknown as Swagger2Spec);
    case "google-discovery":
      return parseGoogleDiscovery(specObj as unknown as GoogleDiscoveryDoc);
  }
}

// ---------------------------------------------------------------------------
// OpenAPI 3.x adapter
// ---------------------------------------------------------------------------

function parseOpenApi3(spec: OpenApi3Spec): ParsedSpec {
  const r = new DocResolver(spec as unknown as Record<string, unknown>);
  const servers = extractServers(spec.servers);
  const schemas: Record<string, SchemaObject> = {};
  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    setOwn(schemas, name, schema);
  }

  const operations: ExtractedOperation[] = [];
  for (const [path, rawPathItem] of Object.entries(spec.paths ?? {})) {
    if (!rawPathItem) continue;
    // Path items may be $refs (OAS 3.0 "#/paths/~1pets") — resolve once per
    // path; misses feed into every op derived from it (G7).
    const pathUnresolved = new Set<string>();
    const pathItem = resolvePathItemRef(rawPathItem, r, pathUnresolved);
    for (const method of HTTP_METHODS) {
      const op = pathItem[method];
      if (!op) continue;
      operations.push(
        openApi3Operation(path, pathItem, method, op, spec, r, servers, pathUnresolved),
      );
    }
  }

  return {
    operations,
    specFormat: "openapi3",
    baseUrl: servers[0]?.url,
    servers,
    schemas,
    title: spec.info?.title,
    description: spec.info?.description,
    version: spec.info?.version,
  };
}

function openApi3Operation(
  path: string,
  pathItem: OpenApi3PathItem,
  method: (typeof HTTP_METHODS)[number],
  op: OperationObject,
  spec: OpenApi3Spec,
  r: DocResolver,
  docServers: ServerInfo[],
  pathUnresolved: Set<string>,
): ExtractedOperation {
  const toolName = deriveToolName(op, method, path);
  // Per-op tracking: an op must only report refs IT touched, not refs other
  // ops left dangling (B3). Path-level misses (a $ref path item) carry over.
  const unresolved = new Set<string>(pathUnresolved);
  const parameters = extractOpenApi3Parameters(pathItem, op, r, unresolved);
  const requestBody = extractRequestBody(op, r, unresolved);
  const outputSchema = extractOutputSchema(op, r, unresolved);
  const requiredScopes = collectScopes(op.security ?? spec.security);
  const servers = operationServers(pathItem, op, docServers);
  const operationUnresolved = unresolved.size > 0 ? [...unresolved] : undefined;

  return {
    toolName,
    method: method.toUpperCase() as HttpMethod,
    path,
    summary: op.summary,
    description: op.description,
    tags: op.tags ?? [],
    parameters,
    requestBody,
    outputSchema,
    deprecated: op.deprecated === true,
    servers,
    requiredScopes,
    unresolvedRefs: operationUnresolved,
  };
}

/** Merge path-level + operation-level parameters; op wins; resolves $refs (P9). */
function extractOpenApi3Parameters(
  pathItem: OpenApi3PathItem,
  op: OperationObject,
  r: DocResolver,
  unresolved: Set<string>,
): NormalizedParameter[] {
  const merged = new Map<string, ParameterObject>();
  for (const raw of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = resolveOrTrack(r, raw, unresolved);
    if (!p) continue;
    if (typeof (p as ParameterObject).name !== "string") continue;
    const param = p as ParameterObject;
    merged.set(`${param.in}:${param.name}`, param);
  }
  return [...merged.values()]
    .filter((p) => VALID_PARAM_LOCATIONS.has(p.in))
    .map((p) => ({
      name: p.name,
      in: p.in,
      required: p.in === "path" ? true : (p.required ?? false),
      description: p.description,
      schema: p.schema ?? firstContentSchema(p) ?? { type: "string" },
      ...(p.style ? { style: p.style } : {}),
      ...(p.explode !== undefined ? { explode: p.explode } : {}),
      ...(p.allowReserved !== undefined ? { allowReserved: p.allowReserved } : {}),
    }));
}

/** OAS 3.0 params may carry `content` instead of `schema` (rare) — take the
 *  first media type's schema rather than silently typing the param as string. */
function firstContentSchema(p: ParameterObject): SchemaObject | undefined {
  const content = p.content;
  if (!content) return undefined;
  for (const media of Object.values(content)) {
    if (media?.schema) return media.schema;
  }
  return undefined;
}

function extractRequestBody(
  op: OperationObject,
  r: DocResolver,
  unresolved: Set<string>,
): NormalizedRequestBody | undefined {
  if (!op.requestBody) return undefined;
  const body = resolveOrTrack(r, op.requestBody, unresolved);
  if (!body) return undefined;
  const rb = body as RequestBodyObject;
  const contents = Object.entries(rb.content ?? {}).map(([contentType, media]) => ({
    contentType,
    ...(media.schema ? { schema: media.schema } : {}),
  }));
  if (contents.length === 0) return undefined;
  return {
    required: rb.required === true,
    description: rb.description,
    contentType: contents[0]!.contentType,
    ...(contents.length > 1 ? { contents } : {}),
    ...(contents[0]!.schema ? { schema: contents[0]!.schema } : {}),
  };
}

/**
 * Output schema from success responses: exact 2xx codes (sorted), then 2XX
 * wildcard (Microsoft Graph declares every success this way). `default` is
 * deliberately EXCLUDED — it usually carries the error shape, and advertising
 * that as the output contract misleads LLM callers (G5). The server picks the
 * response media type, so prefer JSON among declared.
 */
function extractOutputSchema(
  op: OperationObject,
  r: DocResolver,
  unresolved: Set<string>,
): SchemaObject | undefined {
  const entries = Object.entries(op.responses ?? {});
  const preferred = [
    ...entries.filter(([s]) => /^2\d\d$/.test(s)).sort(([a], [b]) => a.localeCompare(b)),
    ...entries.filter(([s]) => /^2xx$/i.test(s)),
  ];
  for (const [, raw] of preferred) {
    const resp = resolveOrTrack(r, raw as ResponseObject | RefObject, unresolved) as
      | ResponseObject
      | null;
    const content = resp?.content;
    if (!content) continue;
    const pick =
      content["application/json"] ??
      Object.entries(content).find(([mt]) => mt.toLowerCase().includes("json"))?.[1] ??
      Object.entries(content)[0]?.[1];
    if (pick?.schema) {
      const pickedMediaType =
        content["application/json"]
          ? "application/json"
          : Object.entries(content).find(([mt]) => mt.toLowerCase().includes("json"))?.[0] ??
            Object.entries(content)[0]?.[0];
      // NDJSON streams are returned as an ARRAY of parsed lines by the caller,
      // so advertise the array shape, not the single-line schema.
      if (pickedMediaType !== undefined && isNdjsonMediaType(pickedMediaType)) {
        return { type: "array", items: pick.schema };
      }
      return pick.schema;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Swagger 2.0 adapter — converts straight to the normalized model.
// ---------------------------------------------------------------------------

function parseSwagger2(spec: Swagger2Spec): ParsedSpec {
  const r = new DocResolver(spec as unknown as Record<string, unknown>);
  const schemes = spec.schemes ?? ["https"];
  const baseUrl = spec.host
    ? `${schemes[0]}://${spec.host}${spec.basePath ?? ""}`
    : undefined;
  const servers: ServerInfo[] = baseUrl ? [{ url: baseUrl }] : [];

  const schemas: Record<string, SchemaObject> = {};
  for (const [name, schema] of Object.entries(spec.definitions ?? {})) {
    setOwn(schemas, name, schema);
  }

  const operations: ExtractedOperation[] = [];
  for (const [path, pathItem] of Object.entries(spec.paths ?? {})) {
    if (!pathItem) continue;
    for (const method of ["get", "put", "post", "patch", "delete", "head", "options"] as const) {
      const op = pathItem[method];
      if (!op) continue;
      operations.push(swagger2Operation(path, pathItem, method, op, spec, r, servers));
    }
  }

  return {
    operations,
    specFormat: "swagger2",
    baseUrl,
    servers,
    schemas,
    title: spec.info?.title,
    description: spec.info?.description,
    version: spec.info?.version,
  };
}

function swagger2Operation(
  path: string,
  pathItem: Swagger2PathItem,
  method: "get" | "put" | "post" | "patch" | "delete" | "head" | "options",
  op: Swagger2Operation,
  spec: Swagger2Spec,
  r: DocResolver,
  docServers: ServerInfo[],
): ExtractedOperation {
  const toolName = deriveToolName(op as OperationObject, method, path);
  // Per-op unresolved tracking (B3) — same discipline as the OAS3 adapter.
  const unresolved = new Set<string>();
  const bodyParams: Swagger2Parameter[] = [];
  const parameters: NormalizedParameter[] = [];
  for (const raw of [...(pathItem.parameters ?? []), ...(op.parameters ?? [])]) {
    const p = resolveOrTrack(r, raw as Swagger2Parameter | RefObject, unresolved);
    if (!p) continue;
    const param = p as Swagger2Parameter;
    if (param.in === "body" || param.in === "formData") {
      bodyParams.push(param);
    } else if (param.in === "query" || param.in === "path" || param.in === "header") {
      parameters.push(swagger2ParamToNormalized(param));
    }
  }

  const consumes = op.consumes ?? spec.consumes;
  const requestBody = buildSwagger2RequestBody(bodyParams, consumes);
  const requiredScopes = collectScopes(op.security ?? spec.security);
  const outputSchema = swagger2OutputSchema(op, r, unresolved);

  return {
    toolName,
    method: method.toUpperCase() as HttpMethod,
    path,
    summary: op.summary,
    description: op.description,
    tags: op.tags ?? [],
    parameters,
    requestBody,
    outputSchema,
    deprecated: op.deprecated === true,
    servers: docServers,
    requiredScopes,
    ...(unresolved.size > 0 ? { unresolvedRefs: [...unresolved] } : {}),
  };
}

function swagger2ParamToNormalized(p: Swagger2Parameter): NormalizedParameter {
  const schema: SchemaObject = {
    type: p.type === "file" ? "string" : p.type,
    ...(p.type === "file" ? { format: "binary" } : {}),
    ...(p.format && p.type !== "file" ? { format: p.format } : {}),
    ...(p.enum ? { enum: p.enum } : {}),
    ...(p.default !== undefined ? { default: p.default } : {}),
    ...(p.minimum !== undefined ? { minimum: p.minimum } : {}),
    ...(p.maximum !== undefined ? { maximum: p.maximum } : {}),
    ...(p.pattern ? { pattern: p.pattern } : {}),
    ...(p.items ? { items: p.items } : {}),
  };
  return {
    name: p.name,
    in: p.in as NormalizedParameter["in"],
    required: p.in === "path" ? true : (p.required ?? false),
    description: p.description,
    schema,
    ...swagger2CollectionStyle(p),
  };
}

/**
 * collectionFormat → OpenAPI 3 style/explode (OAI#1046). tsv has no 3.x
 * equivalent; csv join is the least-wrong serialization.
 */
function swagger2CollectionStyle(
  p: Swagger2Parameter,
): { style: string; explode: boolean } {
  switch (p.collectionFormat) {
    case "ssv":
      return { style: "spaceDelimited", explode: false };
    case "pipes":
      return { style: "pipeDelimited", explode: false };
    case "multi":
      return { style: "form", explode: true };
    case "tsv":
      return { style: "form", explode: false };
    default:
      return { style: "form", explode: false };
  }
}

function buildSwagger2RequestBody(
  bodyParams: Swagger2Parameter[],
  consumes: string[] | undefined,
): NormalizedRequestBody | undefined {
  if (bodyParams.length === 0) return undefined;
  const body = bodyParams.find((p) => p.in === "body");
  if (body) {
    return {
      required: body.required ?? false,
      description: body.description,
      contentType: consumes?.[0] ?? "application/json",
      ...(body.schema ? { schema: body.schema } : {}),
    };
  }
  // formData → object schema; multipart when a file part or consumes says so.
  const isMultipart =
    consumes?.includes("multipart/form-data") === true ||
    bodyParams.some((p) => p.type === "file");
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];
  for (const p of bodyParams) {
    properties[p.name] = {
      type: p.type === "file" ? "string" : p.type,
      ...(p.type === "file" ? { format: "binary" } : {}),
      ...(p.format && p.type !== "file" ? { format: p.format } : {}),
      ...(p.enum ? { enum: p.enum } : {}),
      ...(p.items ? { items: p.items } : {}),
    };
    if (p.required) required.push(p.name);
  }
  return {
    required: false,
    contentType: isMultipart ? "multipart/form-data" : "application/x-www-form-urlencoded",
    schema: {
      type: "object",
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

function swagger2OutputSchema(
  op: Swagger2Operation,
  r: DocResolver,
  unresolved: Set<string>,
): SchemaObject | undefined {
  const entries = Object.entries(op.responses ?? {});
  const preferred = [
    ...entries.filter(([s]) => /^2\d\d$/.test(s)).sort(([a], [b]) => a.localeCompare(b)),
  ];
  for (const [, raw] of preferred) {
    const resp = resolveOrTrack(r, raw as Swagger2Response | RefObject, unresolved) as
      | Swagger2Response
      | null;
    if (resp?.schema) return resp.schema;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Google Discovery adapter
// ---------------------------------------------------------------------------

function parseGoogleDiscovery(doc: GoogleDiscoveryDoc): ParsedSpec {
  // Modern docs carry servicePath (Gmail: rootUrl=https://gmail.googleapis.com/,
  // servicePath=""); basePath is legacy. Prefer servicePath, fall back to basePath.
  const baseUrl = doc.rootUrl.replace(/\/+$/, "") + (doc.servicePath ?? doc.basePath ?? "/");

  const schemas: Record<string, SchemaObject> = {};
  for (const [name, gs] of Object.entries(doc.schemas ?? {})) {
    setOwn(schemas, name, googleSchemaToSchema(gs));
  }

  const operations: ExtractedOperation[] = [];
  walkGoogleResources(doc.resources, [doc.name ?? "api"], operations, doc);
  injectGoogleGlobalParams(operations, doc.parameters ?? {});

  return {
    operations,
    specFormat: "google-discovery",
    baseUrl,
    servers: [{ url: baseUrl }],
    schemas,
    title: doc.title,
    description: doc.description,
    version: doc.version,
  };
}

function walkGoogleResources(
  resources: Record<string, GoogleResourceObject>,
  tags: string[],
  operations: ExtractedOperation[],
  doc: GoogleDiscoveryDoc,
): void {
  for (const [resourceName, resource] of Object.entries(resources)) {
    const currentTags = [...tags, resourceName];
    for (const method of Object.values(resource.methods ?? {})) {
      operations.push(googleMethodToOperation(method, currentTags, doc));
    }
    if (resource.resources) {
      walkGoogleResources(resource.resources, currentTags, operations, doc);
    }
  }
}

/** Global params (prettyPrint, alt, fields, key, quotaUser, uploadType...) are
 *  injected into every operation unless already defined there. */
function injectGoogleGlobalParams(
  operations: ExtractedOperation[],
  globalParams: Record<string, GoogleParameterObject>,
): void {
  if (Object.keys(globalParams).length === 0) return;
  for (const op of operations) {
    const existing = new Set(op.parameters.map((p) => p.name));
    for (const [paramName, gp] of Object.entries(globalParams)) {
      if (existing.has(paramName)) continue;
      if (!gp.location) continue;
      const normalized = googleParamToSchema(gp);
      normalized.name = paramName;
      op.parameters.push(normalized);
    }
  }
}

function googleMethodToOperation(
  method: GoogleMethodObject,
  tags: string[],
  doc: GoogleDiscoveryDoc,
): ExtractedOperation {
  const toolName = sanitizeToolName(method.id);
  const rawPath = method.flatPath ?? method.path;

  const parameters: NormalizedParameter[] = [];
  for (const [name, gp] of Object.entries(method.parameters ?? {})) {
    const normalized = googleParamToSchema(gp);
    normalized.name = name;
    parameters.push(normalized);
  }

  let requestBody: NormalizedRequestBody | undefined;
  if (method.request?.$ref) {
    requestBody = {
      required: true,
      contentType: "application/json",
      schema: { $ref: `#/components/schemas/${method.request.$ref}` },
    };
  }

  const outputSchema = method.response?.$ref
    ? { $ref: `#/components/schemas/${method.response.$ref}` }
    : undefined;

  const simplePath = method.mediaUpload?.protocols?.simple?.path;
  const resumablePath = method.mediaUpload?.protocols?.resumable?.path;
  const mediaUpload =
    method.supportsMediaUpload === true && (simplePath || resumablePath)
      ? {
          uploadType: "media" as const,
          ...(simplePath ? { simplePath } : {}),
          ...(resumablePath ? { resumablePath } : {}),
          ...(method.mediaUpload?.accept ? { accept: method.mediaUpload.accept } : {}),
        }
      : undefined;

  return {
    toolName,
    method: (method.httpMethod || "GET").toUpperCase() as HttpMethod,
    path: rawPath.startsWith("/") ? rawPath : `/${rawPath}`,
    summary: method.description?.split("\n")[0] ?? method.id,
    description: method.description,
    tags,
    parameters,
    requestBody,
    outputSchema,
    deprecated: false,
    servers: [{ url: doc.rootUrl.replace(/\/+$/, "") + (doc.servicePath ?? doc.basePath ?? "/") }],
    requiredScopes: method.scopes,
    ...(mediaUpload ? { mediaUpload } : {}),
  };
}

/** Convert a Google schema: per-property required → required[], $ref bare name
 *  → #/components/schemas/X, invalid types (e.g. "any") dropped at conversion. */
function googleSchemaToSchema(gs: GoogleSchemaObject): SchemaObject {
  const result: SchemaObject = {};
  if (gs.type && VALID_SCHEMA_TYPES.has(gs.type)) result.type = gs.type;
  if (gs.description) result.description = gs.description;
  if (gs.format) result.format = gs.format;
  if (gs.enum) result.enum = gs.enum;
  if (gs.default !== undefined) result.default = gs.default;
  if (gs.readOnly) result.readOnly = true;

  // Discovery marks requiredness per-property (boolean), not as a string[].
  const required: string[] = [];
  for (const [propName, prop] of Object.entries(gs.properties ?? {})) {
    if (prop.required) required.push(propName);
  }
  if (required.length > 0) result.required = required;

  if (gs.$ref) {
    const refName = gs.$ref.replace(/^#\//, "").replace(/^schemas\//, "components/schemas/");
    result.$ref = refName.startsWith("#")
      ? refName
      : `#/components/schemas/${refName.replace(/^components\/schemas\//, "")}`;
  }

  if (gs.properties) {
    result.properties = {};
    for (const [key, val] of Object.entries(gs.properties)) {
      setOwn(result.properties, key, googleSchemaToSchema(val));
    }
  }
  if (gs.items) result.items = googleSchemaToSchema(gs.items);
  if (gs.additionalProperties) {
    result.additionalProperties = googleSchemaToSchema(gs.additionalProperties);
  }
  return result;
}

function googleParamToSchema(gp: GoogleParameterObject): NormalizedParameter {
  const schema: SchemaObject = {
    // Filter at conversion (the "any" fix): a bare schema without `type`
    // means "anything allowed" — no recursive cleanup pass needed.
    ...(gp.type && VALID_SCHEMA_TYPES.has(gp.type) ? { type: gp.type } : {}),
    ...(gp.format ? { format: gp.format } : {}),
    ...(gp.enum ? { enum: gp.enum } : {}),
    ...(gp.default !== undefined ? { default: coerceDefault(gp.default, gp.type) } : {}),
  };
  const result: NormalizedParameter = {
    name: "",
    in: (gp.location as NormalizedParameter["in"]) ?? "query",
    required: gp.required ?? false,
    description: gp.description,
    schema,
  };
  if (gp.repeated) {
    result.schema = {
      type: "array",
      items: schema,
      description: gp.description,
    };
    result.description = gp.description;
  }
  return result;
}

/** Discovery serializes defaults as strings regardless of type (gnostic schema). */
function coerceDefault(raw: string, type: string | undefined): unknown {
  if (type === "integer" || type === "number") return Number(raw);
  if (type === "boolean") return raw === "true";
  return raw;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function resolveOrTrack<T>(
  r: DocResolver,
  value: T | RefObject,
  unresolved: Set<string>,
): T | null {
  if (isRef(value)) {
    const resolved = r.resolvePointer(value.$ref);
    if (resolved === null) unresolved.add(value.$ref);
    return resolved as T | null;
  }
  return value as T;
}

/** Resolve a $ref path item; a miss falls back to the raw item (no ops derived
 *  from it) and is recorded so the caller can report it. */
function resolvePathItemRef(
  raw: OpenApi3PathItem | RefObject,
  r: DocResolver,
  unresolved: Set<string>,
): OpenApi3PathItem {
  if (!isRef(raw)) return raw;
  const resolved = resolveOrTrack(r, raw, unresolved);
  return (resolved ?? raw) as OpenApi3PathItem;
}

function extractServers(
  servers:
    | Array<{
        url: string;
        description?: string;
        variables?: Record<
          string,
          { default?: unknown; enum?: string[]; description?: string }
        >;
      }>
    | undefined,
): ServerInfo[] {
  return (servers ?? []).flatMap((server) => {
    if (!server.url) return [];
    const variables = server.variables
      ? Object.fromEntries(
          Object.entries(server.variables).flatMap(([name, v]) => {
            if (!v || v.default === undefined || v.default === null) return [];
            return [
              [
                name,
                {
                  default: String(v.default),
                  ...(v.enum ? { enum: v.enum } : {}),
                  ...(v.description ? { description: v.description } : {}),
                },
              ],
            ];
          }),
        )
      : undefined;
    return [
      {
        url: server.url,
        ...(server.description ? { description: server.description } : {}),
        ...(variables && Object.keys(variables).length > 0 ? { variables } : {}),
      },
    ];
  });
}

function operationServers(
  pathItem: OpenApi3PathItem,
  op: OperationObject,
  docServers: ServerInfo[],
): ServerInfo[] {
  const operationLevel = extractServers(op.servers);
  if (operationLevel.length > 0) return operationLevel;
  const pathLevel = extractServers(pathItem.servers);
  if (pathLevel.length > 0) return pathLevel;
  return docServers;
}

/** Stable tool name from operationId, else method + path segments. */
function deriveToolName(op: OperationObject, method: string, path: string): string {
  if (op.operationId) return sanitizeToolName(op.operationId);
  const segments = path.replace(/[{}]/g, "").split("/").filter(Boolean);
  return sanitizeToolName(`${method}_${segments.join("_")}`);
}

function sanitizeToolName(name: string): string {
  return (
    name
      .replace(/[^a-zA-Z0-9_]/g, "_")
      .replace(/^_+|_+$/g, "")
      .replace(/_+/g, "_") || "unnamed"
  );
}

/** Flatten OAuth scopes from security requirements (all alternatives unioned). */
function collectScopes(security?: Array<Record<string, string[]>>): string[] | undefined {
  if (!security) return undefined;
  const scopes = new Set<string>();
  for (const req of security) {
    for (const schemeScopes of Object.values(req)) {
      for (const scope of schemeScopes ?? []) {
        if (typeof scope === "string" && scope.length > 0) scopes.add(scope);
      }
    }
  }
  return scopes.size > 0 ? [...scopes] : undefined;
}
