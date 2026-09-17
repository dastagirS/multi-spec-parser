import assert from "node:assert/strict";
import { open, type FileHandle } from "node:fs/promises";

import type {
  LazyOperationIndex,
  LazyOperationLocator,
  LazySourceIndex,
} from "./lazy-source-index.js";
import {
  assignUniqueOperationName,
  createUniqueOperationNameState,
  deriveOperationKey,
  deriveOperationName,
  sanitizeOperationName,
} from "./operation-names.js";

const HTTP_METHOD_ORDER = ["get", "put", "post", "patch", "delete", "head", "options", "trace"] as const;
const HTTP_METHODS = new Set<string>(HTTP_METHOD_ORDER);
const OPENAPI_METADATA_KEYS = ["openapi", "info", "servers", "security", "tags", "externalDocs"];
const SWAGGER_METADATA_KEYS = ["swagger", "info", "host", "basePath", "schemes", "consumes", "produces", "security"];
const GOOGLE_METADATA_KEYS = [
  "kind", "name", "version", "title", "description", "documentationLink", "rootUrl",
  "servicePath", "basePath", "baseUrl", "batchPath", "parameters", "auth",
];
const JSON_DEPTH_MAX = 512;
const JSON_TOKEN_COUNT_MAX = 20_000_000;
const JSON_KEY_BYTES_MAX = 1024 * 1024;
const JSON_CAPTURED_STRING_BYTES_MAX = 16 * 1024 * 1024;
const JSON_FRAGMENT_BYTES_MAX = 32 * 1024 * 1024;
const INDEX_ENTRY_COUNT_MAX = 1_000_000;
const REFERENCE_COUNT_MAX = 100_000;
const OPERATION_NAME_LOOKUP_LENGTH_MAX = 16 * 1024 * 1024;

type SourceRange = { start: number; end: number };
type JsonValueKind = "object" | "array" | "string" | "primitive";

interface IndexedOperation {
  method: string;
  operationId?: string;
  range: SourceRange;
}

interface IndexedPath {
  range: SourceRange;
  operations: IndexedOperation[];
}

interface IndexedGoogleMethod {
  memberName: string;
  range: SourceRange;
  id?: string;
  path?: string;
  flatPath?: string;
  httpMethod?: string;
}

interface IndexedGoogleResource {
  name: string;
  methods: IndexedGoogleMethod[];
  resources: IndexedGoogleResource[];
}

interface JsonSourceIndex {
  filePath: string;
  size: number;
  topLevel: Map<string, SourceRange>;
  paths: Map<string, IndexedPath>;
  components: Map<string, SourceRange>;
  definitions: Map<string, SourceRange>;
  parameters: Map<string, SourceRange>;
  responses: Map<string, SourceRange>;
  schemas: Map<string, SourceRange>;
  googleResources: IndexedGoogleResource[];
  markers: Map<string, string>;
}

type JsonRole =
  | { type: "root" }
  | { type: "top"; key: string; range: SourceRange }
  | { type: "paths"; range: SourceRange }
  | { type: "path"; path: string; indexed: IndexedPath }
  | { type: "operation"; operation: IndexedOperation }
  | { type: "operation-id"; operation: IndexedOperation }
  | { type: "components"; range: SourceRange }
  | { type: "component-kind"; kind: string }
  | { type: "component"; range: SourceRange }
  | { type: "definitions"; range: SourceRange }
  | { type: "definition"; range: SourceRange }
  | { type: "parameters"; range: SourceRange }
  | { type: "parameter"; range: SourceRange }
  | { type: "responses"; range: SourceRange }
  | { type: "response"; range: SourceRange }
  | { type: "schemas"; range: SourceRange }
  | { type: "schema"; range: SourceRange }
  | { type: "google-resources"; resources: IndexedGoogleResource[]; range?: SourceRange }
  | { type: "google-resource"; resource: IndexedGoogleResource }
  | { type: "google-methods"; methods: IndexedGoogleMethod[] }
  | { type: "google-method"; method: IndexedGoogleMethod }
  | { type: "google-method-field"; method: IndexedGoogleMethod; key: string }
  | { type: "other" };

interface JsonFrame {
  kind: "object" | "array";
  state: "key-or-end" | "key" | "colon" | "value-or-end" | "value" | "comma-or-end";
  key?: string;
  role: JsonRole;
}

export async function createJsonLazySourceIndex(
  filePath: string,
  sourceSize: number,
): Promise<LazySourceIndex> {
  assert(typeof filePath === "string" && filePath.length > 0, "JSON source path must be non-empty");
  assert(Number.isInteger(sourceSize) && sourceSize > 0, "JSON source size must be positive");
  const source = await scanJsonSource(filePath, sourceSize);
  const openapi = source.markers.get("openapi");
  const swagger = source.markers.get("swagger");
  const kind = source.markers.get("kind");
  if (openapi?.startsWith("3.")) return OpenApiJsonSourceIndex.create(source);
  if (swagger === "2.0") return SwaggerJsonSourceIndex.create(source);
  if (kind === "discovery#restDescription") return GoogleJsonSourceIndex.create(source);
  throw new Error("MultiSpecParser: lazy JSON mode supports only OpenAPI 3.x, Swagger 2.0, and Google Discovery sources.");
}

abstract class JsonSourceIndexBase implements LazySourceIndex {
  abstract readonly specFormat: "openapi3" | "swagger2" | "google-discovery";
  readonly baseUrl: string;
  protected readonly source: JsonSourceIndex;
  protected readonly file: FileHandle;
  protected closed = false;

  protected constructor(source: JsonSourceIndex, file: FileHandle, baseUrl: string) {
    assert(source.size > 0, "indexed JSON source must be non-empty");
    assert(file.fd >= 0, "indexed JSON source file must be open");
    this.source = source;
    this.file = file;
    this.baseUrl = baseUrl;
  }

  abstract createOperationIndex(): LazyOperationIndex;
  abstract materialize(locator: LazyOperationLocator): Promise<Record<string, unknown>>;

  async close(): Promise<void> {
    assert(typeof this.closed === "boolean", "closed state must be boolean");
    assert(this.file.fd >= -1, "file descriptor state must be valid");
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
  }

  protected async readMetadata(keys: readonly string[]): Promise<Record<string, unknown>> {
    assert(!this.closed, "JSON source must be open");
    assert(keys.length > 0, "metadata keys must be non-empty");
    const document: Record<string, unknown> = {};
    for (const key of keys) {
      const range = this.source.topLevel.get(key);
      if (range) document[key] = await readJsonValue(this.file, range);
    }
    return document;
  }
}

class OpenApiJsonSourceIndex extends JsonSourceIndexBase {
  readonly specFormat = "openapi3" as const;

  static async create(source: JsonSourceIndex): Promise<OpenApiJsonSourceIndex> {
    assert(source.paths.size > 0, "OpenAPI JSON source must contain paths");
    assert(source.topLevel.has("openapi"), "OpenAPI JSON source must contain a version");
    const file = await open(source.filePath, "r");
    try {
      const servers = source.topLevel.get("servers")
        ? await readJsonValue(file, source.topLevel.get("servers")!)
        : undefined;
      const baseUrl = Array.isArray(servers) && isRecord(servers[0]) && typeof servers[0].url === "string"
        ? servers[0].url
        : "";
      return new OpenApiJsonSourceIndex(source, file, baseUrl);
    } catch (error: unknown) {
      await file.close();
      throw error;
    }
  }

  createOperationIndex(): LazyOperationIndex {
    assert(!this.closed, "OpenAPI JSON source must be open");
    assert(this.source.paths.size <= INDEX_ENTRY_COUNT_MAX, "OpenAPI path count must be bounded");
    return createMapOperationIndex(createPathOperationLocators(this.source.paths, true));
  }

  async materialize(locator: LazyOperationLocator): Promise<Record<string, unknown>> {
    assert(!this.closed, "OpenAPI JSON source must be open");
    assert(locator.path.startsWith("/"), "OpenAPI operation path must start with /");
    const indexedPath = this.source.paths.get(locator.path);
    if (!indexedPath) throw new Error(`Lazy JSON index: unknown OpenAPI path "${locator.path}".`);
    const pathItem = await readJsonValue(this.file, indexedPath.range);
    if (!isRecord(pathItem)) throw new Error(`Lazy JSON index: OpenAPI path "${locator.path}" is invalid.`);
    const method = locator.method.toLowerCase();
    if (!isRecord(pathItem[method])) throw new Error(`Lazy JSON index: operation "${locator.operationKey}" is missing.`);
    const selected = selectPathItem(pathItem, method, ["$ref", "summary", "description", "servers", "parameters"]);
    const document = await this.readMetadata(OPENAPI_METADATA_KEYS);
    document.paths = { [locator.path]: selected };
    await addOpenApiComponents(this.file, this.source.components, document, selected);
    assert(isRecord(document.paths), "materialized OpenAPI document must contain paths");
    return document;
  }
}

class SwaggerJsonSourceIndex extends JsonSourceIndexBase {
  readonly specFormat = "swagger2" as const;

  static async create(source: JsonSourceIndex): Promise<SwaggerJsonSourceIndex> {
    assert(source.paths.size > 0, "Swagger JSON source must contain paths");
    assert(source.topLevel.has("swagger"), "Swagger JSON source must contain a version");
    const file = await open(source.filePath, "r");
    try {
      const metadata = await readSelectedTopLevel(file, source, ["host", "basePath", "schemes"]);
      const schemes = Array.isArray(metadata.schemes) ? metadata.schemes : ["https"];
      const baseUrl = typeof metadata.host === "string"
        ? `${typeof schemes[0] === "string" ? schemes[0] : "https"}://${metadata.host}${typeof metadata.basePath === "string" ? metadata.basePath : ""}`
        : "";
      return new SwaggerJsonSourceIndex(source, file, baseUrl);
    } catch (error: unknown) {
      await file.close();
      throw error;
    }
  }

  createOperationIndex(): LazyOperationIndex {
    assert(!this.closed, "Swagger JSON source must be open");
    assert(this.source.paths.size <= INDEX_ENTRY_COUNT_MAX, "Swagger path count must be bounded");
    return createMapOperationIndex(createPathOperationLocators(this.source.paths, false));
  }

  async materialize(locator: LazyOperationLocator): Promise<Record<string, unknown>> {
    assert(!this.closed, "Swagger JSON source must be open");
    assert(locator.path.startsWith("/"), "Swagger operation path must start with /");
    const indexedPath = this.source.paths.get(locator.path);
    if (!indexedPath) throw new Error(`Lazy JSON index: unknown Swagger path "${locator.path}".`);
    const pathItem = await readJsonValue(this.file, indexedPath.range);
    if (!isRecord(pathItem)) throw new Error(`Lazy JSON index: Swagger path "${locator.path}" is invalid.`);
    const method = locator.method.toLowerCase();
    if (!isRecord(pathItem[method])) throw new Error(`Lazy JSON index: operation "${locator.operationKey}" is missing.`);
    const selected = selectPathItem(pathItem, method, ["parameters"]);
    const document = await this.readMetadata(SWAGGER_METADATA_KEYS);
    document.paths = { [locator.path]: selected };
    await addSwaggerReferences(this.file, this.source, document, selected);
    assert(isRecord(document.paths), "materialized Swagger document must contain paths");
    return document;
  }
}

class GoogleJsonSourceIndex extends JsonSourceIndexBase {
  readonly specFormat = "google-discovery" as const;
  private readonly methods = new Map<string, { method: IndexedGoogleMethod; resources: string[] }>();

  static async create(source: JsonSourceIndex): Promise<GoogleJsonSourceIndex> {
    assert(source.googleResources.length > 0, "Google Discovery JSON source must contain resources");
    assert(source.topLevel.has("kind"), "Google Discovery JSON source must contain kind");
    const file = await open(source.filePath, "r");
    try {
      const metadata = await readSelectedTopLevel(file, source, ["rootUrl", "servicePath", "basePath"]);
      if (typeof metadata.rootUrl !== "string") throw new Error("Lazy JSON index: Google rootUrl is missing.");
      const root = metadata.rootUrl.replace(/\/+$/, "");
      const path = (typeof metadata.servicePath === "string"
        ? metadata.servicePath
        : typeof metadata.basePath === "string" ? metadata.basePath : "").replace(/^\/+/, "");
      return new GoogleJsonSourceIndex(source, file, path.length > 0 ? `${root}/${path}` : `${root}/`);
    } catch (error: unknown) {
      await file.close();
      throw error;
    }
  }

  createOperationIndex(): LazyOperationIndex {
    assert(!this.closed, "Google Discovery JSON source must be open");
    assert(this.source.googleResources.length <= INDEX_ENTRY_COUNT_MAX, "Google resource count must be bounded");
    const locators = new Map<string, LazyOperationLocator>();
    const uniqueNames = createUniqueOperationNameState();
    const pending: Array<{ resources: IndexedGoogleResource[]; ancestors: string[] }> = [
      { resources: this.source.googleResources, ancestors: [] },
    ];
    let visited = 0;
    let operationCount = 0;
    while (pending.length > 0) {
      const current = pending.pop()!;
      for (const resource of current.resources) {
        visited += 1;
        if (visited > INDEX_ENTRY_COUNT_MAX) throw new Error("Lazy JSON index: Google resource limit exceeded.");
        const ancestors = [...current.ancestors, resource.name];
        for (const method of resource.methods) {
          operationCount += 1;
          if (operationCount > INDEX_ENTRY_COUNT_MAX) throw new Error("Lazy JSON index: Google method limit exceeded.");
          if (method.id === undefined || method.path === undefined) {
            throw new Error("Lazy JSON index: Google method identity is incomplete.");
          }
          const path = method.flatPath ?? method.path;
          const normalizedPath = path.startsWith("/") ? path : `/${path}`;
          const normalizedMethod = (method.httpMethod || "GET").toUpperCase();
          const name = assignUniqueOperationName(sanitizeOperationName(method.id), uniqueNames);
          const locator = {
            name,
            path: normalizedPath,
            method: normalizedMethod,
            operationKey: deriveOperationKey(normalizedMethod, normalizedPath),
          };
          locators.set(name, locator);
          this.methods.set(name, { method, resources: ancestors });
        }
        if (resource.resources.length > 0) pending.push({ resources: resource.resources, ancestors });
      }
    }
    assert(locators.size > 0, "Google Discovery JSON source must contain methods");
    return createMapOperationIndex(locators);
  }

  async materialize(locator: LazyOperationLocator): Promise<Record<string, unknown>> {
    assert(!this.closed, "Google Discovery JSON source must be open");
    assert(locator.name.length > 0, "Google operation name must be non-empty");
    const indexed = this.methods.get(locator.name);
    if (!indexed) throw new Error(`Lazy JSON index: unknown Google operation "${locator.name}".`);
    const method = await readJsonValue(this.file, indexed.method.range);
    if (!isRecord(method)) throw new Error(`Lazy JSON index: Google operation "${locator.name}" is invalid.`);
    const document = await this.readMetadata(GOOGLE_METADATA_KEYS);
    document.resources = createGoogleResourceFragment(indexed.resources, indexed.method.memberName, method);
    await addGoogleSchemas(this.file, this.source.schemas, document, method);
    assert(isRecord(document.resources), "materialized Google document must contain resources");
    return document;
  }
}

function createPathOperationLocators(
  paths: Map<string, IndexedPath>,
  includeTrace: boolean,
): Map<string, LazyOperationLocator> {
  assert(paths instanceof Map && paths.size > 0, "indexed paths must be non-empty");
  assert(typeof includeTrace === "boolean", "trace selection must be boolean");
  const locators = new Map<string, LazyOperationLocator>();
  const uniqueNames = createUniqueOperationNameState();
  for (const [path, indexedPath] of paths) {
    for (const method of HTTP_METHOD_ORDER) {
      if (!includeTrace && method === "trace") continue;
      const operation = indexedPath.operations.find((candidate) => candidate.method === method);
      if (!operation) continue;
      const name = assignUniqueOperationName(
        deriveOperationName(operation.operationId, method, path),
        uniqueNames,
      );
      locators.set(name, {
        name,
        path,
        method: method.toUpperCase(),
        operationKey: deriveOperationKey(method, path),
      });
    }
  }
  if (locators.size === 0) throw new Error("Lazy JSON index: source contains no operations.");
  return locators;
}

function createMapOperationIndex(locators: Map<string, LazyOperationLocator>): LazyOperationIndex {
  assert(locators instanceof Map, "operation locators must be a map");
  assert(locators.size > 0, "operation locators must be non-empty");
  return {
    size: locators.size,
    names: () => [...locators.keys()],
    get(name: string): LazyOperationLocator | undefined {
      assert(typeof name === "string", "operation name must be a string");
      assert(name.length <= OPERATION_NAME_LOOKUP_LENGTH_MAX, "operation name exceeds the lookup limit");
      return locators.get(name);
    },
  };
}

async function scanJsonSource(filePath: string, sourceSize: number): Promise<JsonSourceIndex> {
  assert(filePath.length > 0, "JSON source path must be non-empty");
  assert(Number.isInteger(sourceSize) && sourceSize > 0, "JSON source size must be positive");
  const source: JsonSourceIndex = {
    filePath,
    size: sourceSize,
    topLevel: new Map(),
    paths: new Map(),
    components: new Map(),
    definitions: new Map(),
    parameters: new Map(),
    responses: new Map(),
    schemas: new Map(),
    googleResources: [],
    markers: new Map(),
  };
  const scanner = new JsonStructuralScanner(source);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const file = await open(filePath, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    let position = 0;
    while (position < sourceSize) {
      const requested = Math.min(chunk.byteLength, sourceSize - position);
      const { bytesRead } = await file.read(chunk, 0, requested, position);
      if (bytesRead === 0) break;
      decoder.decode(chunk.subarray(0, bytesRead), { stream: true });
      scanner.write(chunk.subarray(0, bytesRead), position);
      position += bytesRead;
    }
    decoder.decode();
    scanner.finish(sourceSize);
  } catch (error: unknown) {
    throw new Error(`MultiSpecParser: invalid JSON lazy source: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await file.close();
  }
  if (source.topLevel.size === 0) throw new Error("MultiSpecParser: JSON lazy source must be a non-empty object.");
  return source;
}

class JsonStructuralScanner {
  private readonly source: JsonSourceIndex;
  private readonly frames: JsonFrame[] = [];
  private mode: "default" | "string" | "primitive" = "default";
  private stringBytes = new Uint8Array(128);
  private stringSize = 0;
  private stringCapture = false;
  private stringEscape = false;
  private unicodeDigits = 0;
  private tokenStart = 0;
  private primitive = "";
  private scalarRole: JsonRole | undefined;
  private rootStarted = false;
  private rootComplete = false;
  private tokenCount = 0;

  constructor(source: JsonSourceIndex) {
    assert(source.size > 0, "scanner source must be non-empty");
    assert(source.topLevel.size === 0, "scanner source index must start empty");
    this.source = source;
  }

  write(bytes: Uint8Array, offset: number): void {
    assert(bytes.byteLength > 0, "JSON scanner chunk must be non-empty");
    assert(Number.isInteger(offset) && offset >= 0, "JSON scanner offset must be non-negative");
    const startIndex = offset === 0 && bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
    for (let index = startIndex; index < bytes.byteLength; index += 1) {
      const position = offset + index;
      const byte = bytes[index]!;
      if (this.mode === "string") {
        this.consumeStringByte(byte, position);
      } else if (this.mode === "primitive") {
        if (isJsonDelimiter(byte)) {
          this.finishPrimitive(position);
          this.consumeDefaultByte(byte, position);
        } else {
          if (this.primitive.length >= 128) throw new Error("JSON primitive exceeds the safety limit");
          this.primitive += String.fromCharCode(byte);
        }
      } else {
        this.consumeDefaultByte(byte, position);
      }
    }
  }

  finish(sourceSize: number): void {
    assert(Number.isInteger(sourceSize) && sourceSize > 0, "JSON source size must be positive");
    assert(sourceSize === this.source.size, "JSON scanner size must match source size");
    if (this.mode === "string") throw new Error("unterminated JSON string");
    if (this.mode === "primitive") this.finishPrimitive(sourceSize);
    if (this.frames.length !== 0 || !this.rootComplete) throw new Error("incomplete JSON document");
  }

  private consumeDefaultByte(byte: number, position: number): void {
    assert(byte >= 0 && byte <= 255, "JSON byte must be valid");
    assert(position >= 0, "JSON byte position must be non-negative");
    if (isJsonWhitespace(byte)) return;
    if (this.rootComplete) throw new Error("JSON document contains trailing content");
    if (byte === 34) {
      this.beginString(position);
      return;
    }
    if (byte === 123 || byte === 91) {
      this.beginContainer(byte === 123 ? "object" : "array", position);
      return;
    }
    if (byte === 125 || byte === 93) {
      this.endContainer(byte === 125 ? "object" : "array", position + 1);
      return;
    }
    if (byte === 58) {
      this.consumeColon();
      return;
    }
    if (byte === 44) {
      this.consumeComma();
      return;
    }
    if (byte === 45 || (byte >= 48 && byte <= 57) || byte === 116 || byte === 102 || byte === 110) {
      this.beginPrimitive(byte, position);
      return;
    }
    throw new Error(`unexpected JSON byte at ${position}`);
  }

  private beginString(position: number): void {
    assert(this.mode === "default", "JSON scanner must be ready for a string");
    assert(this.stringSize === 0, "JSON string buffer must start empty");
    const frame = this.frames[this.frames.length - 1];
    const isKey = frame?.kind === "object" && (frame.state === "key-or-end" || frame.state === "key");
    if (!isKey) this.scalarRole = this.beginValue("string", position);
    this.stringCapture = isKey || shouldCaptureScalar(this.scalarRole);
    this.stringEscape = false;
    this.unicodeDigits = 0;
    this.tokenStart = position;
    this.mode = "string";
  }

  private consumeStringByte(byte: number, position: number): void {
    assert(this.mode === "string", "JSON scanner must be inside a string");
    assert(position > this.tokenStart, "JSON string content must follow its opening quote");
    if (this.unicodeDigits > 0) {
      if (!isHexByte(byte)) throw new Error("invalid JSON unicode escape");
      this.unicodeDigits -= 1;
      this.appendStringByte(byte);
      return;
    }
    if (this.stringEscape) {
      if (byte === 117) this.unicodeDigits = 4;
      else if (![34, 47, 92, 98, 102, 110, 114, 116].includes(byte)) throw new Error("invalid JSON escape");
      this.stringEscape = false;
      this.appendStringByte(byte);
      return;
    }
    if (byte === 92) {
      this.stringEscape = true;
      this.appendStringByte(byte);
      return;
    }
    if (byte === 34) {
      const value = this.stringCapture ? decodeJsonString(this.stringBytes.subarray(0, this.stringSize)) : undefined;
      this.finishString(value, position + 1);
      this.mode = "default";
      this.stringSize = 0;
      this.scalarRole = undefined;
      return;
    }
    if (byte < 32) throw new Error("unescaped control byte in JSON string");
    this.appendStringByte(byte);
  }

  private appendStringByte(byte: number): void {
    assert(byte >= 0 && byte <= 255, "JSON string byte must be valid");
    assert(this.stringSize <= JSON_CAPTURED_STRING_BYTES_MAX, "JSON string size must be bounded");
    if (!this.stringCapture) return;
    const limit = this.isReadingKey() ? JSON_KEY_BYTES_MAX : JSON_CAPTURED_STRING_BYTES_MAX;
    if (this.stringSize >= limit) throw new Error(`JSON string exceeds ${limit} bytes`);
    if (this.stringSize === this.stringBytes.byteLength) {
      const next = new Uint8Array(Math.min(limit, this.stringBytes.byteLength * 2));
      next.set(this.stringBytes);
      this.stringBytes = next;
    }
    this.stringBytes[this.stringSize] = byte;
    this.stringSize += 1;
  }

  private finishString(value: string | undefined, end: number): void {
    assert(end > this.tokenStart, "JSON string range must be non-empty");
    assert(value === undefined || typeof value === "string", "captured JSON string must be text");
    this.countToken();
    const frame = this.frames[this.frames.length - 1];
    if (frame?.kind === "object" && (frame.state === "key-or-end" || frame.state === "key")) {
      if (value === undefined) throw new Error("JSON object key was not captured");
      frame.key = value;
      frame.state = "colon";
      return;
    }
    if (!this.scalarRole) throw new Error("JSON string is not in a value position");
    finishRole(this.source, this.scalarRole, end, value);
    this.completeValue();
  }

  private beginPrimitive(byte: number, position: number): void {
    assert(this.mode === "default", "JSON scanner must be ready for a primitive");
    assert(this.primitive.length === 0, "JSON primitive buffer must start empty");
    this.scalarRole = this.beginValue("primitive", position);
    this.primitive = String.fromCharCode(byte);
    this.tokenStart = position;
    this.mode = "primitive";
  }

  private finishPrimitive(end: number): void {
    assert(this.mode === "primitive", "JSON scanner must be inside a primitive");
    assert(this.primitive.length > 0, "JSON primitive must be non-empty");
    if (!isValidJsonPrimitive(this.primitive)) throw new Error(`invalid JSON primitive at ${this.tokenStart}`);
    if (!this.scalarRole) throw new Error("JSON primitive is not in a value position");
    finishRole(this.source, this.scalarRole, end, undefined);
    this.countToken();
    this.completeValue();
    this.mode = "default";
    this.primitive = "";
    this.scalarRole = undefined;
  }

  private beginContainer(kind: "object" | "array", start: number): void {
    assert(kind === "object" || kind === "array", "JSON container kind must be valid");
    assert(start >= 0, "JSON container start must be non-negative");
    const role = this.beginValue(kind, start);
    if (!this.rootStarted && this.frames.length === 0) {
      if (kind !== "object") throw new Error("JSON source root must be an object");
      this.rootStarted = true;
    }
    this.frames.push({
      kind,
      state: kind === "object" ? "key-or-end" : "value-or-end",
      role,
    });
    if (this.frames.length > JSON_DEPTH_MAX) throw new Error(`JSON nesting exceeds ${JSON_DEPTH_MAX}`);
    this.countToken();
  }

  private endContainer(kind: "object" | "array", end: number): void {
    assert(kind === "object" || kind === "array", "JSON container kind must be valid");
    assert(end > 0, "JSON container end must be positive");
    const frame = this.frames[this.frames.length - 1];
    if (!frame || frame.kind !== kind) throw new Error("mismatched JSON container close");
    const valid = kind === "object"
      ? frame.state === "key-or-end" || frame.state === "comma-or-end"
      : frame.state === "value-or-end" || frame.state === "comma-or-end";
    if (!valid) throw new Error("JSON container ended while expecting a value");
    finishRole(this.source, frame.role, end, undefined);
    this.frames.pop();
    this.countToken();
    if (this.frames.length === 0) this.rootComplete = true;
    else this.completeValue();
  }

  private beginValue(kind: JsonValueKind, start: number): JsonRole {
    assert(start >= 0, "JSON value start must be non-negative");
    assert(kind === "object" || kind === "array" || kind === "string" || kind === "primitive", "JSON value kind must be valid");
    if (this.frames.length === 0) {
      if (this.rootStarted) throw new Error("JSON source has multiple root values");
      return { type: "root" };
    }
    const parent = this.frames[this.frames.length - 1]!;
    if (parent.kind === "object") {
      if (parent.state !== "value" || parent.key === undefined) throw new Error("JSON object value is out of place");
      return createRole(this.source, parent.role, parent.key, kind, start);
    }
    if (parent.state !== "value-or-end" && parent.state !== "value") throw new Error("JSON array value is out of place");
    return { type: "other" };
  }

  private completeValue(): void {
    assert(this.rootStarted || this.frames.length > 0, "JSON value completion requires a root");
    assert(!this.rootComplete, "JSON value cannot complete after the root");
    const parent = this.frames[this.frames.length - 1];
    if (!parent) {
      this.rootComplete = true;
      this.rootStarted = true;
      return;
    }
    parent.state = "comma-or-end";
    parent.key = undefined;
  }

  private consumeColon(): void {
    assert(this.frames.length > 0, "JSON colon requires an object");
    assert(!this.rootComplete, "JSON colon cannot follow the root");
    const frame = this.frames[this.frames.length - 1]!;
    if (frame.kind !== "object" || frame.state !== "colon") throw new Error("unexpected JSON colon");
    frame.state = "value";
  }

  private consumeComma(): void {
    assert(this.frames.length > 0, "JSON comma requires a container");
    assert(!this.rootComplete, "JSON comma cannot follow the root");
    const frame = this.frames[this.frames.length - 1]!;
    if (frame.state !== "comma-or-end") throw new Error("unexpected JSON comma");
    frame.state = frame.kind === "object" ? "key" : "value";
  }

  private isReadingKey(): boolean {
    assert(this.mode === "string", "key check requires string mode");
    assert(this.frames.length > 0, "key check requires a container");
    const frame = this.frames[this.frames.length - 1]!;
    return frame.kind === "object" && (frame.state === "key-or-end" || frame.state === "key");
  }

  private countToken(): void {
    assert(this.tokenCount <= JSON_TOKEN_COUNT_MAX, "JSON token count must be bounded");
    assert(JSON_TOKEN_COUNT_MAX > 0, "JSON token limit must be positive");
    this.tokenCount += 1;
    if (this.tokenCount > JSON_TOKEN_COUNT_MAX) throw new Error(`JSON token count exceeds ${JSON_TOKEN_COUNT_MAX}`);
  }
}

function createRole(
  source: JsonSourceIndex,
  parent: JsonRole,
  key: string,
  kind: JsonValueKind,
  start: number,
): JsonRole {
  assert(typeof key === "string", "JSON member key must be a string");
  assert(start >= 0, "JSON member start must be non-negative");
  const range = { start, end: source.size };
  switch (parent.type) {
    case "root": {
      if (!source.topLevel.has(key) && source.topLevel.size >= INDEX_ENTRY_COUNT_MAX) {
        throw new Error("Lazy JSON index: top-level member limit exceeded.");
      }
      source.topLevel.set(key, range);
      if (key === "openapi" || key === "swagger" || key === "kind") source.markers.delete(key);
      if (key === "paths" && kind === "object") {
        source.paths.clear();
        return { type: "paths", range };
      }
      if (key === "components" && kind === "object") {
        source.components.clear();
        return { type: "components", range };
      }
      if (key === "definitions" && kind === "object") {
        source.definitions.clear();
        return { type: "definitions", range };
      }
      if (key === "parameters" && kind === "object") {
        source.parameters.clear();
        return { type: "parameters", range };
      }
      if (key === "responses" && kind === "object") {
        source.responses.clear();
        return { type: "responses", range };
      }
      if (key === "schemas" && kind === "object") {
        source.schemas.clear();
        return { type: "schemas", range };
      }
      if (key === "resources" && kind === "object") {
        source.googleResources.length = 0;
        return { type: "google-resources", resources: source.googleResources, range };
      }
      return { type: "top", key, range };
    }
    case "paths": {
      if (kind !== "object") return { type: "other" };
      const indexed = { range, operations: [] };
      source.paths.set(key, indexed);
      if (source.paths.size > INDEX_ENTRY_COUNT_MAX) throw new Error("Lazy JSON index: path limit exceeded.");
      return { type: "path", path: key, indexed };
    }
    case "path": {
      if (key === "$ref") throw new Error("Lazy JSON index: referenced path items are not supported.");
      if (kind !== "object" || !HTTP_METHODS.has(key)) return { type: "other" };
      const operation = { method: key, range };
      const duplicateIndex = parent.indexed.operations.findIndex((candidate) => candidate.method === key);
      if (duplicateIndex >= 0) parent.indexed.operations[duplicateIndex] = operation;
      else parent.indexed.operations.push(operation);
      return { type: "operation", operation };
    }
    case "operation":
      if (key !== "operationId") return { type: "other" };
      if (kind !== "string") throw new Error("Lazy JSON index: operationId must be a string.");
      return { type: "operation-id", operation: parent.operation };
    case "components":
      if (kind !== "object") return { type: "other" };
      for (const componentKey of source.components.keys()) {
        if (componentKey.startsWith(`${key}\u0000`)) source.components.delete(componentKey);
      }
      return { type: "component-kind", kind: key };
    case "component-kind": {
      source.components.set(`${parent.kind}\u0000${key}`, range);
      if (source.components.size > INDEX_ENTRY_COUNT_MAX) throw new Error("Lazy JSON index: component limit exceeded.");
      return { type: "component", range };
    }
    case "definitions":
      source.definitions.set(key, range);
      return { type: "definition", range };
    case "parameters":
      source.parameters.set(key, range);
      return { type: "parameter", range };
    case "responses":
      source.responses.set(key, range);
      return { type: "response", range };
    case "schemas":
      source.schemas.set(key, range);
      return { type: "schema", range };
    case "google-resources": {
      if (kind !== "object") return { type: "other" };
      const resource = { name: key, methods: [], resources: [] };
      const duplicateIndex = parent.resources.findIndex((candidate) => candidate.name === key);
      if (duplicateIndex >= 0) parent.resources[duplicateIndex] = resource;
      else parent.resources.push(resource);
      if (parent.resources.length > INDEX_ENTRY_COUNT_MAX) throw new Error("Lazy JSON index: Google resource limit exceeded.");
      return { type: "google-resource", resource };
    }
    case "google-resource":
      if (key === "methods" && kind === "object") {
        parent.resource.methods.length = 0;
        return { type: "google-methods", methods: parent.resource.methods };
      }
      if (key === "resources" && kind === "object") {
        parent.resource.resources.length = 0;
        return { type: "google-resources", resources: parent.resource.resources };
      }
      return { type: "other" };
    case "google-methods": {
      if (kind !== "object") return { type: "other" };
      const method = { memberName: key, range };
      const duplicateIndex = parent.methods.findIndex((candidate) => candidate.memberName === key);
      if (duplicateIndex >= 0) parent.methods[duplicateIndex] = method;
      else parent.methods.push(method);
      if (parent.methods.length > INDEX_ENTRY_COUNT_MAX) throw new Error("Lazy JSON index: Google method limit exceeded.");
      return { type: "google-method", method };
    }
    case "google-method":
      if (!["id", "path", "flatPath", "httpMethod"].includes(key)) return { type: "other" };
      if (kind !== "string") throw new Error(`Lazy JSON index: Google method ${key} must be a string.`);
      return { type: "google-method-field", method: parent.method, key };
    default:
      return { type: "other" };
  }
}

function shouldCaptureScalar(role: JsonRole | undefined): boolean {
  assert(role === undefined || typeof role.type === "string", "JSON scalar role must be valid");
  assert(JSON_CAPTURED_STRING_BYTES_MAX > 0, "captured string limit must be positive");
  return role?.type === "operation-id" || role?.type === "google-method-field" ||
    (role?.type === "top" && (role.key === "openapi" || role.key === "swagger" || role.key === "kind"));
}

function finishRole(
  source: JsonSourceIndex,
  role: JsonRole,
  end: number,
  scalar: string | undefined,
): void {
  assert(end > 0 && end <= source.size, "JSON value end must be within the source");
  assert(scalar === undefined || typeof scalar === "string", "JSON scalar must be text or undefined");
  switch (role.type) {
    case "top":
    case "paths":
    case "components":
    case "definitions":
    case "parameters":
    case "responses":
    case "schemas":
    case "component":
    case "definition":
    case "parameter":
    case "response":
    case "schema":
      role.range.end = end;
      if (role.type === "top" && scalar !== undefined && ["openapi", "swagger", "kind"].includes(role.key)) {
        source.markers.set(role.key, scalar);
      }
      break;
    case "path":
      role.indexed.range.end = end;
      break;
    case "operation":
      role.operation.range.end = end;
      break;
    case "operation-id":
      if (scalar !== undefined) role.operation.operationId = scalar;
      break;
    case "google-resources":
      if (role.range) role.range.end = end;
      break;
    case "google-method":
      role.method.range.end = end;
      break;
    case "google-method-field":
      if (scalar !== undefined) {
        if (role.key === "id") role.method.id = scalar;
        else if (role.key === "path") role.method.path = scalar;
        else if (role.key === "flatPath") role.method.flatPath = scalar;
        else if (role.key === "httpMethod") role.method.httpMethod = scalar;
      }
      break;
  }
}

async function readJsonValue(file: FileHandle, range: SourceRange): Promise<unknown> {
  assert(file.fd >= 0, "JSON source file must be open");
  assert(range.start >= 0 && range.end > range.start, "JSON range must be non-empty");
  const size = range.end - range.start;
  if (size > JSON_FRAGMENT_BYTES_MAX) throw new Error(`Lazy JSON index: fragment exceeds ${JSON_FRAGMENT_BYTES_MAX} bytes.`);
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await file.read(bytes, offset, size - offset, range.start + offset);
    if (bytesRead === 0) throw new Error("Lazy JSON index: fragment ended unexpectedly.");
    offset += bytesRead;
  }
  const value: unknown = JSON.parse(bytes.toString("utf8"));
  assert(offset === size, "JSON fragment must be read completely");
  return value;
}

async function readSelectedTopLevel(
  file: FileHandle,
  source: JsonSourceIndex,
  keys: readonly string[],
): Promise<Record<string, unknown>> {
  assert(file.fd >= 0, "JSON source file must be open");
  assert(keys.length > 0, "top-level key selection must be non-empty");
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    const range = source.topLevel.get(key);
    if (range) values[key] = await readJsonValue(file, range);
  }
  return values;
}

function selectPathItem(
  pathItem: Record<string, unknown>,
  method: string,
  retainedKeys: readonly string[],
): Record<string, unknown> {
  assert(isRecord(pathItem), "path item must be an object");
  assert(HTTP_METHODS.has(method), "operation method must be supported");
  const selected: Record<string, unknown> = {};
  for (const key of retainedKeys) {
    if (Object.prototype.hasOwnProperty.call(pathItem, key)) selected[key] = pathItem[key];
  }
  selected[method] = pathItem[method];
  assert(isRecord(selected[method]), "selected operation must be an object");
  return selected;
}

async function addOpenApiComponents(
  file: FileHandle,
  ranges: Map<string, SourceRange>,
  document: Record<string, unknown>,
  root: Record<string, unknown>,
): Promise<void> {
  assert(file.fd >= 0, "OpenAPI source file must be open");
  assert(isRecord(root), "OpenAPI reference root must be an object");
  const components: Record<string, Record<string, unknown>> = Object.create(null) as Record<string, Record<string, unknown>>;
  const pending = collectRefs(root);
  let count = 0;
  while (pending.length > 0) {
    count += 1;
    if (count > REFERENCE_COUNT_MAX) throw new Error("Lazy JSON index: OpenAPI reference limit exceeded.");
    const reference = parseOpenApiReference(pending.pop()!);
    if (!reference) continue;
    const range = ranges.get(`${reference.kind}\u0000${reference.name}`);
    if (!range) continue;
    const category = components[reference.kind] ??
      (components[reference.kind] = Object.create(null) as Record<string, unknown>);
    if (Object.prototype.hasOwnProperty.call(category, reference.name)) continue;
    const value = await readJsonValue(file, range);
    category[reference.name] = value;
    if (value !== null && typeof value === "object") pending.push(...collectRefs(value));
  }
  if (Object.keys(components).length > 0) document.components = components;
}

async function addSwaggerReferences(
  file: FileHandle,
  source: JsonSourceIndex,
  document: Record<string, unknown>,
  root: Record<string, unknown>,
): Promise<void> {
  assert(file.fd >= 0, "Swagger source file must be open");
  assert(isRecord(root), "Swagger reference root must be an object");
  const collections = {
    definitions: Object.create(null) as Record<string, unknown>,
    parameters: Object.create(null) as Record<string, unknown>,
    responses: Object.create(null) as Record<string, unknown>,
  };
  const pending = collectRefs(root);
  let count = 0;
  while (pending.length > 0) {
    count += 1;
    if (count > REFERENCE_COUNT_MAX) throw new Error("Lazy JSON index: Swagger reference limit exceeded.");
    const reference = parseSwaggerReference(pending.pop()!);
    if (!reference) continue;
    const ranges = reference.kind === "definitions"
      ? source.definitions
      : reference.kind === "parameters" ? source.parameters : source.responses;
    const collection = collections[reference.kind];
    if (Object.prototype.hasOwnProperty.call(collection, reference.name)) continue;
    const range = ranges.get(reference.name);
    if (!range) continue;
    const value = await readJsonValue(file, range);
    collection[reference.name] = value;
    if (value !== null && typeof value === "object") pending.push(...collectRefs(value));
  }
  for (const [key, collection] of Object.entries(collections)) {
    if (Object.keys(collection).length > 0) document[key] = collection;
  }
}

async function addGoogleSchemas(
  file: FileHandle,
  ranges: Map<string, SourceRange>,
  document: Record<string, unknown>,
  method: Record<string, unknown>,
): Promise<void> {
  assert(file.fd >= 0, "Google source file must be open");
  assert(isRecord(method), "Google method must be an object");
  const schemas: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  const pending = collectRefs(method);
  let count = 0;
  while (pending.length > 0) {
    count += 1;
    if (count > REFERENCE_COUNT_MAX) throw new Error("Lazy JSON index: Google schema reference limit exceeded.");
    const name = parseGoogleReference(pending.pop()!);
    if (!name || Object.prototype.hasOwnProperty.call(schemas, name)) continue;
    const range = ranges.get(name);
    if (!range) continue;
    const value = await readJsonValue(file, range);
    schemas[name] = value;
    if (value !== null && typeof value === "object") pending.push(...collectRefs(value));
  }
  if (Object.keys(schemas).length > 0) document.schemas = schemas;
}

function collectRefs(root: object): string[] {
  assert(root !== null && typeof root === "object", "reference root must be an object");
  assert(!Array.isArray(root) || root.length <= REFERENCE_COUNT_MAX, "reference root array must be bounded");
  const pending: unknown[] = [root];
  const references: string[] = [];
  let visited = 0;
  while (pending.length > 0) {
    const value = pending.pop()!;
    if (value === null || typeof value !== "object") continue;
    visited += 1;
    if (visited > REFERENCE_COUNT_MAX) throw new Error("Lazy JSON index: reference traversal limit exceeded.");
    if (Array.isArray(value)) {
      for (const child of value) pending.push(child);
      continue;
    }
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (key === "$ref" && typeof child === "string") references.push(child);
      else pending.push(child);
    }
    if (pending.length > REFERENCE_COUNT_MAX || references.length > REFERENCE_COUNT_MAX) {
      throw new Error("Lazy JSON index: reference queue limit exceeded.");
    }
  }
  return references;
}

function parseOpenApiReference(value: string): { kind: string; name: string } | undefined {
  assert(typeof value === "string", "OpenAPI reference must be a string");
  assert(value.length <= JSON_CAPTURED_STRING_BYTES_MAX, "OpenAPI reference must be bounded");
  if (!value.startsWith("#/components/")) return undefined;
  const parts = value.slice("#/components/".length).split("/");
  if (parts.length < 2) return undefined;
  return { kind: decodePointer(parts[0]!), name: decodePointer(parts[1]!) };
}

function parseSwaggerReference(value: string): { kind: "definitions" | "parameters" | "responses"; name: string } | undefined {
  assert(typeof value === "string", "Swagger reference must be a string");
  assert(value.length <= JSON_CAPTURED_STRING_BYTES_MAX, "Swagger reference must be bounded");
  if (!value.startsWith("#/")) return undefined;
  const parts = value.slice(2).split("/");
  if (parts.length < 2 || !["definitions", "parameters", "responses"].includes(parts[0]!)) return undefined;
  return {
    kind: parts[0] as "definitions" | "parameters" | "responses",
    name: decodePointer(parts[1]!),
  };
}

function parseGoogleReference(value: string): string | undefined {
  assert(typeof value === "string", "Google schema reference must be a string");
  assert(value.length <= JSON_CAPTURED_STRING_BYTES_MAX, "Google schema reference must be bounded");
  if (value.startsWith("#/schemas/")) return decodePointer(value.slice("#/schemas/".length));
  if (value.startsWith("schemas/")) return decodePointer(value.slice("schemas/".length));
  if (value.startsWith("#/components/schemas/")) return decodePointer(value.slice("#/components/schemas/".length));
  return value.includes("/") || value.startsWith("#") ? undefined : value;
}

function decodePointer(value: string): string {
  assert(typeof value === "string", "JSON Pointer part must be a string");
  assert(value.length <= JSON_CAPTURED_STRING_BYTES_MAX, "JSON Pointer part must be bounded");
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function createGoogleResourceFragment(
  resources: readonly string[],
  methodName: string,
  method: Record<string, unknown>,
): Record<string, unknown> {
  assert(resources.length > 0 && resources.length <= JSON_DEPTH_MAX, "Google resource path must be bounded and non-empty");
  assert(methodName.length > 0 && isRecord(method), "Google method fragment must be valid");
  let resource: Record<string, unknown> = { methods: { [methodName]: method } };
  for (let index = resources.length - 1; index >= 0; index -= 1) {
    const wrapped = { [resources[index]!]: resource };
    if (index === 0) return wrapped;
    resource = { resources: wrapped };
  }
  throw new Error("Lazy JSON index: Google resource fragment could not be created.");
}

function decodeJsonString(bytes: Uint8Array): string {
  assert(bytes.byteLength <= JSON_CAPTURED_STRING_BYTES_MAX, "captured JSON string must be bounded");
  assert(bytes.byteLength >= 0, "captured JSON string size must be non-negative");
  return JSON.parse(`"${Buffer.from(bytes).toString("utf8")}"`) as string;
}

function isValidJsonPrimitive(value: string): boolean {
  assert(typeof value === "string" && value.length > 0, "JSON primitive must be non-empty");
  assert(value.length <= 128, "JSON primitive must be bounded");
  return value === "true" || value === "false" || value === "null" ||
    /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/.test(value);
}

function isJsonDelimiter(byte: number): boolean {
  assert(byte >= 0 && byte <= 255, "JSON delimiter byte must be valid");
  assert(Number.isInteger(byte), "JSON delimiter byte must be an integer");
  return isJsonWhitespace(byte) || byte === 44 || byte === 93 || byte === 125;
}

function isJsonWhitespace(byte: number): boolean {
  assert(byte >= 0 && byte <= 255, "JSON whitespace byte must be valid");
  assert(Number.isInteger(byte), "JSON whitespace byte must be an integer");
  return byte === 9 || byte === 10 || byte === 13 || byte === 32;
}

function isHexByte(byte: number): boolean {
  assert(byte >= 0 && byte <= 255, "hex byte must be valid");
  assert(Number.isInteger(byte), "hex byte must be an integer");
  return (byte >= 48 && byte <= 57) || (byte >= 65 && byte <= 70) || (byte >= 97 && byte <= 102);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
