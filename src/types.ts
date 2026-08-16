/**
 * Normalized model shared by every source format (OpenAPI 3.x, Swagger 2.0,
 * Google Discovery). Adapters convert their native shape into this model so
 * downstream code never knows which format the spec came from.
 */

export type SpecFormat = "openapi3" | "swagger2" | "google-discovery";

export type HttpMethod =
  | "GET"
  | "PUT"
  | "POST"
  | "PATCH"
  | "DELETE"
  | "HEAD"
  | "OPTIONS"
  | "TRACE";

export type ParamLocation = "query" | "path" | "header" | "cookie";

export interface NormalizedSecurityScheme {
  name: string;
  scopes: string[];
}

/** One security alternative: schemes in this entry are AND-ed together. */
export interface NormalizedSecurityRequirement {
  schemes: NormalizedSecurityScheme[];
}

/**
 * A JSON-Schema-ish schema object. `type` may be an array (OpenAPI 3.1 /
 * JSON Schema 2020-12); `exclusiveMinimum/Maximum` may be numeric (3.1) or
 * boolean-modifier style (3.0) — both pass through untouched because Ajv
 * draft-07 accepts type arrays and numeric exclusiveMinimum natively.
 */
export interface SchemaObject {
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  enum?: unknown[];
  items?: SchemaObject;
  properties?: Record<string, SchemaObject>;
  additionalProperties?: boolean | SchemaObject;
  required?: string[];
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  not?: SchemaObject;
  nullable?: boolean;
  readOnly?: boolean;
  writeOnly?: boolean;
  deprecated?: boolean;
  $ref?: string;
  $schema?: string;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number | boolean;
  exclusiveMaximum?: number | boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  contentEncoding?: string;
  contentMediaType?: string;
  discriminator?: Record<string, unknown>;
  [extension: string]: unknown;
}

export interface NormalizedParameter {
  /** Original parameter name used on the wire. */
  name: string;
  /** Model-facing input name; assigned during tool compilation when needed. */
  inputName?: string;
  in: ParamLocation;
  required: boolean;
  description?: string;
  schema: SchemaObject;
  /** OpenAPI 3 serialization style; default depends on `in` (form for query). */
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

export interface MediaBinding {
  contentType: string;
  schema?: SchemaObject;
}

export interface NormalizedRequestBody {
  required: boolean;
  description?: string;
  /** First-declared content type — spec authors order content deliberately. */
  contentType: string;
  /** Every declared media type in spec order (for contentType override). */
  contents?: MediaBinding[];
  schema?: SchemaObject;
}

export interface ServerVariable {
  default: string;
  enum?: string[];
  description?: string;
}

export interface ServerInfo {
  url: string;
  description?: string;
  variables?: Record<string, ServerVariable>;
}

export interface ExtractedOperation {
  /** Stable operation identity derived from method + path, independent of display naming. */
  operationKey: string;
  /** LLM-facing tool name derived from operationId or method+path. */
  toolName: string;
  method: HttpMethod;
  /** Path template, e.g. /users/{userId}/messages. */
  path: string;
  summary?: string;
  description?: string;
  tags: string[];
  parameters: NormalizedParameter[];
  requestBody?: NormalizedRequestBody;
  /** Schema of the success response body (output contract for the LLM). */
  outputSchema?: SchemaObject;
  deprecated: boolean;
  /** Servers for this operation (op-level, else path-level, else document). */
  servers?: ServerInfo[];
  /** Security alternatives; entries are OR-ed, schemes within one entry are AND-ed. */
  security?: NormalizedSecurityRequirement[];
  /** Backward-compatible flattened OAuth scope view. Prefer `security`. */
  requiredScopes?: string[];
  /** Model-facing names reserved for generated request inputs. */
  generatedInputNames?: {
    server?: string;
    body?: string;
    bodyBase64?: string;
    contentType?: string;
  };
  /** External $refs left unresolved (e.g. Booking's ../accommodations/...). */
  unresolvedRefs?: string[];
}

export interface ParsedSpec {
  operations: ExtractedOperation[];
  specFormat: SpecFormat;
  /** First server / rootUrl-derived base URL. */
  baseUrl?: string;
  servers: ServerInfo[];
  /** Component schemas keyed by name (refs still in native form). */
  schemas: Record<string, SchemaObject>;
  title?: string;
  description?: string;
  version?: string;
}

// ---------------------------------------------------------------------------
// Source-format types (native shapes, used only by the adapters)
// ---------------------------------------------------------------------------

export interface OpenApi3Spec {
  openapi: string;
  info?: { title?: string; version?: string; description?: string };
  servers?: Array<{ url: string; description?: string; variables?: Record<string, ServerVariable> }>;
  paths?: Record<string, OpenApi3PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    parameters?: Record<string, unknown>;
    requestBodies?: Record<string, unknown>;
    responses?: Record<string, unknown>;
  };
  security?: Array<Record<string, string[]>>;
}

export interface OpenApi3PathItem {
  parameters?: Array<ParameterObject | RefObject>;
  servers?: Array<{ url: string; description?: string }>;
  get?: OperationObject;
  put?: OperationObject;
  post?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  head?: OperationObject;
  options?: OperationObject;
  trace?: OperationObject;
}

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: Array<ParameterObject | RefObject>;
  requestBody?: RequestBodyObject | RefObject;
  responses?: Record<string, ResponseObject | RefObject>;
  deprecated?: boolean;
  security?: Array<Record<string, string[]>>;
  servers?: Array<{ url: string; description?: string }>;
}

export interface ParameterObject {
  name: string;
  in: ParamLocation;
  required?: boolean;
  description?: string;
  schema?: SchemaObject;
  /** OAS 3.0 allows `content` instead of `schema` (rare) — first media schema wins. */
  content?: Record<string, { schema?: SchemaObject }>;
  style?: string;
  explode?: boolean;
  allowReserved?: boolean;
}

export interface RequestBodyObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
  required?: boolean;
}

export interface ResponseObject {
  description?: string;
  content?: Record<string, { schema?: SchemaObject }>;
}

export interface RefObject {
  $ref: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Swagger 2.0 (OpenAPI v2) — converted straight to the normalized model.
// ---------------------------------------------------------------------------

export interface Swagger2Spec {
  swagger: "2.0";
  info?: { title?: string; version?: string; description?: string };
  host?: string;
  basePath?: string;
  schemes?: string[];
  consumes?: string[];
  produces?: string[];
  paths?: Record<string, Swagger2PathItem>;
  definitions?: Record<string, SchemaObject>;
  parameters?: Record<string, Swagger2Parameter>;
  responses?: Record<string, Swagger2Response>;
  securityDefinitions?: Record<string, unknown>;
  security?: Array<Record<string, string[]>>;
}

export interface Swagger2PathItem {
  parameters?: Array<Swagger2Parameter | RefObject>;
  get?: Swagger2Operation;
  put?: Swagger2Operation;
  post?: Swagger2Operation;
  patch?: Swagger2Operation;
  delete?: Swagger2Operation;
  head?: Swagger2Operation;
  options?: Swagger2Operation;
}

export interface Swagger2Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  consumes?: string[];
  produces?: string[];
  parameters?: Array<Swagger2Parameter | RefObject>;
  responses?: Record<string, Swagger2Response | RefObject>;
  security?: Array<Record<string, string[]>>;
  deprecated?: boolean;
}

/**
 * Swagger 2.0 parameter: the schema lives directly on the parameter
 * (type/format/items/...), `in:"body"` carries a full schema, and
 * `in:"formData"` describes urlencoded/multipart bodies.
 */
export interface Swagger2Parameter {
  name: string;
  in: "query" | "path" | "header" | "body" | "formData";
  required?: boolean;
  description?: string;
  type?: string;
  format?: string;
  items?: SchemaObject;
  enum?: unknown[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  collectionFormat?: "csv" | "ssv" | "tsv" | "pipes" | "multi";
  schema?: SchemaObject;
  allowEmptyValue?: boolean;
}

export interface Swagger2Response {
  description?: string;
  schema?: SchemaObject;
}

// ---------------------------------------------------------------------------
// Google Discovery (kind: "discovery#restDescription")
// ---------------------------------------------------------------------------

export interface GoogleDiscoveryDoc {
  kind: "discovery#restDescription";
  name: string;
  version: string;
  title: string;
  description?: string;
  documentationLink?: string;
  rootUrl: string;
  servicePath?: string;
  basePath?: string;
  baseUrl?: string;
  batchPath?: string;
  resources: Record<string, GoogleResourceObject>;
  schemas?: Record<string, GoogleSchemaObject>;
  parameters?: Record<string, GoogleParameterObject>;
  auth?: { oauth2?: { scopes?: Record<string, { description?: string }> } };
}

export interface GoogleResourceObject {
  methods?: Record<string, GoogleMethodObject>;
  resources?: Record<string, GoogleResourceObject>;
}

export interface GoogleMethodObject {
  id: string;
  path: string;
  httpMethod: string;
  description?: string;
  parameters?: Record<string, GoogleParameterObject>;
  parameterOrder?: string[];
  request?: { $ref: string; parameterName?: string };
  response?: { $ref: string };
  scopes?: string[];
  supportsMediaUpload?: boolean;
  supportsMediaDownload?: boolean;
  useMediaDownloadService?: boolean;
  mediaUpload?: {
    accept?: string[];
    maxSize?: string;
    protocols?: {
      simple?: { multipart?: boolean; path?: string };
      resumable?: { multipart?: boolean; path?: string };
    };
  };
  flatPath?: string;
  etagRequired?: boolean;
}

export interface GoogleParameterObject {
  type: string;
  location: "path" | "query" | "header";
  description?: string;
  required?: boolean;
  default?: string;
  repeated?: boolean;
  enum?: string[];
  enumDescriptions?: string[];
  format?: string;
  pattern?: string;
  minimum?: string;
  maximum?: string;
}

export interface GoogleSchemaObject {
  type?: string;
  description?: string;
  properties?: Record<string, GoogleSchemaObject>;
  items?: GoogleSchemaObject;
  additionalProperties?: GoogleSchemaObject;
  $ref?: string;
  required?: boolean;
  enum?: string[];
  enumDescriptions?: string[];
  format?: string;
  default?: unknown;
  id?: string;
  readOnly?: boolean;
}
