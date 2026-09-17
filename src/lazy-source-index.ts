import assert from "node:assert/strict";
import { open, type FileHandle } from "node:fs/promises";

import { createJsonLazySourceIndex } from "./lazy-json-source-index.js";
import { parseSpecText } from "./parse-spec.js";
import {
  assignUniqueOperationName,
  createUniqueOperationNameState,
  deriveOperationKey,
  deriveOperationName,
} from "./operation-names.js";
import type { SpecFormat } from "./types.js";

const HTTP_METHOD_ORDER = ["get", "put", "post", "patch", "delete", "head", "options", "trace"] as const;
const HTTP_METHODS = new Set<string>(HTTP_METHOD_ORDER);
const METADATA_KEYS = ["openapi", "info", "servers", "security", "tags", "externalDocs"];
const PATH_ITEM_KEYS = ["$ref", "summary", "description", "servers", "parameters"];
const COMPONENT_REFERENCE_COUNT_MAX = 100_000;
const INDEX_ENTRY_COUNT_MAX = 1_000_000;
const SOURCE_BYTES_MAX = 200 * 1024 * 1024;
const SOURCE_LINE_BYTES_MAX = 16 * 1024 * 1024;
const SOURCE_FRAGMENT_BYTES_MAX = 32 * 1024 * 1024;
const OPERATION_NAME_LOOKUP_LENGTH_MAX = 16 * 1024 * 1024;

export interface LazyOperationLocator {
  readonly name: string;
  readonly path: string;
  readonly method: string;
  readonly operationKey: string;
}

export interface LazyOperationIndex {
  readonly size: number;
  names(): string[];
  get(name: string): LazyOperationLocator | undefined;
}

type SourceRange = { start: number; end: number; indent: number };

interface IndexedOperation {
  method: string;
  operationId?: string;
  range: SourceRange;
}

interface IndexedPath {
  range: SourceRange;
  operations: IndexedOperation[];
}

interface IndexedSource {
  filePath: string;
  size: number;
  topLevel: Map<string, SourceRange>;
  paths: Map<string, IndexedPath>;
  components: Map<string, SourceRange>;
}

interface ScanState {
  topName?: string;
  topRange?: SourceRange;
  pathName?: string;
  pathIndent?: number;
  pathChildIndent?: number;
  pathRange?: SourceRange;
  operation?: IndexedOperation;
  operationChildIndent?: number;
  componentKind?: string;
  componentKindIndent?: number;
  componentIndent?: number;
  componentRange?: SourceRange;
  blockScalarIndent?: number;
  ignoredPathExtensionIndent?: number;
  operationCount?: number;
  operationIdIndent?: number;
  documentMarkerSeen?: boolean;
  contentSeen?: boolean;
  supported: boolean;
}

interface ParsedLine {
  indent: number;
  key?: string;
  value?: string;
  blank: boolean;
  documentMarker?: "start" | "end" | "directive";
  valid: boolean;
}

export interface LazySourceIndex {
  readonly specFormat: SpecFormat;
  readonly baseUrl: string;
  createOperationIndex(): LazyOperationIndex;
  materialize(locator: LazyOperationLocator): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

export async function createLazySourceIndex(
  filePath: string,
  sourceSize: number,
): Promise<LazySourceIndex> {
  assert(typeof filePath === "string" && filePath.length > 0, "source path must be non-empty");
  assert(Number.isInteger(sourceSize) && sourceSize > 0, "source size must be positive");
  if (sourceSize > SOURCE_BYTES_MAX) throw new Error(`Lazy source index: source exceeds ${SOURCE_BYTES_MAX} bytes.`);
  if (await startsWithJsonObject(filePath, sourceSize)) {
    return createJsonLazySourceIndex(filePath, sourceSize);
  }
  const source = await indexYamlSource(filePath, sourceSize);
  if (!source || !(await isOpenApi3(source)) || source.paths.size === 0) {
    throw new Error("MultiSpecParser: lazy mode supports only indexable OpenAPI 3.x YAML URL sources.");
  }
  return OpenApiSourceIndex.create(source);
}

async function startsWithJsonObject(filePath: string, sourceSize: number): Promise<boolean> {
  assert(typeof filePath === "string" && filePath.length > 0, "source path must be non-empty");
  assert(Number.isInteger(sourceSize) && sourceSize > 0, "source size must be positive");
  const file = await open(filePath, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let position = 0;
  try {
    if (sourceSize >= 3) {
      const marker = Buffer.allocUnsafe(3);
      const { bytesRead } = await file.read(marker, 0, marker.byteLength, 0);
      if (bytesRead === 3 && marker[0] === 0xef && marker[1] === 0xbb && marker[2] === 0xbf) position = 3;
    }
    while (position < sourceSize) {
      const requested = Math.min(chunk.byteLength, sourceSize - position);
      const { bytesRead } = await file.read(chunk, 0, requested, position);
      if (bytesRead === 0) return false;
      let index = 0;
      while (index < bytesRead) {
        const byte = chunk[index]!;
        if (byte !== 9 && byte !== 10 && byte !== 13 && byte !== 32) return byte === 123;
        index += 1;
      }
      position += bytesRead;
    }
    return false;
  } finally {
    await file.close();
  }
}

class OpenApiSourceIndex implements LazySourceIndex {
  readonly specFormat = "openapi3" as const;
  readonly baseUrl: string;
  private readonly source: IndexedSource;
  private readonly file: FileHandle;
  private closed = false;

  private constructor(source: IndexedSource, file: FileHandle, baseUrl: string) {
    assert(source.paths.size > 0, "indexed source must contain paths");
    assert(file.fd >= 0, "indexed source file must be open");
    this.source = source;
    this.file = file;
    this.baseUrl = baseUrl;
  }

  static async create(source: IndexedSource): Promise<OpenApiSourceIndex> {
    assert(source.paths.size > 0, "indexed source must contain paths");
    assert(source.topLevel.has("openapi"), "indexed source must contain an OpenAPI version");
    const file = await open(source.filePath, "r");
    try {
      const baseUrl = await readBaseUrl(file, source);
      return new OpenApiSourceIndex(source, file, baseUrl);
    } catch (error: unknown) {
      await file.close();
      throw error;
    }
  }

  createOperationIndex(): LazyOperationIndex {
    assert(!this.closed, "lazy source must be open");
    assert(this.source.paths.size <= COMPONENT_REFERENCE_COUNT_MAX, "indexed source contains too many paths");
    const locators = new Map<string, LazyOperationLocator>();
    const uniqueNames = createUniqueOperationNameState();
    for (const [path, indexedPath] of this.source.paths) {
      for (const method of HTTP_METHOD_ORDER) {
        const operation = indexedPath.operations.find((candidate) => candidate.method === method);
        if (!operation) continue;
        const operationKey = deriveOperationKey(operation.method, path);
        const candidate = deriveOperationName(operation.operationId, operation.method, path);
        const name = assignUniqueOperationName(candidate, uniqueNames);
        locators.set(name, { name, path, method: operation.method.toUpperCase(), operationKey });
      }
    }
    assert(locators.size > 0, "indexed source must contain operations");
    return createMapOperationIndex(locators);
  }

  async materialize(locator: LazyOperationLocator): Promise<Record<string, unknown>> {
    assert(!this.closed, "lazy source must be open");
    assert(typeof locator.path === "string" && locator.path.startsWith("/"), "source locator path must start with /");
    const indexedPath = this.source.paths.get(locator.path);
    if (!indexedPath) throw new Error(`Lazy source index: unknown path "${locator.path}".`);
    const parsedPath = await parseFragment(this.file, indexedPath.range);
    const pathItem = parsedPath[locator.path];
    if (!isRecord(pathItem)) throw new Error(`Lazy source index: path "${locator.path}" is not an object.`);
    const method = locator.method.toLowerCase();
    if (!isRecord(pathItem[method])) throw new Error(`Lazy source index: operation "${locator.operationKey}" is missing.`);
    const selectedPath = selectPathItem(pathItem, method);
    const document = await this.readMetadata();
    document.paths = { [locator.path]: selectedPath };
    await this.addReferencedComponents(document, selectedPath);
    assert(isRecord(document.paths), "fragment document must contain paths");
    return document;
  }

  async close(): Promise<void> {
    assert(typeof this.closed === "boolean", "closed state must be boolean");
    assert(this.file.fd >= -1, "file descriptor state must be valid");
    if (this.closed) return;
    this.closed = true;
    await this.file.close();
  }

  private async readMetadata(): Promise<Record<string, unknown>> {
    assert(!this.closed, "lazy source must be open");
    assert(this.source.topLevel.has("info"), "indexed source must contain info");
    const document: Record<string, unknown> = {};
    for (const name of METADATA_KEYS) {
      const range = this.source.topLevel.get(name);
      if (!range) continue;
      const fragment = await parseFragment(this.file, range);
      if (Object.prototype.hasOwnProperty.call(fragment, name)) document[name] = fragment[name];
    }
    if (typeof document.openapi !== "string" || !isRecord(document.info)) {
      throw new Error("Lazy source index: required OpenAPI metadata is invalid.");
    }
    return document;
  }

  private async addReferencedComponents(
    document: Record<string, unknown>,
    root: Record<string, unknown>,
  ): Promise<void> {
    assert(isRecord(document), "fragment document must be an object");
    assert(isRecord(root), "reference root must be an object");
    const components = Object.create(null) as Record<string, Record<string, unknown>>;
    const pending = collectComponentRefs(root);
    let referenceCount = 0;
    while (pending.length > 0) {
      referenceCount += 1;
      if (referenceCount > COMPONENT_REFERENCE_COUNT_MAX) throw new Error("Lazy source index: component reference limit exceeded.");
      const reference = pending.pop()!;
      const range = this.source.components.get(componentKey(reference.kind, reference.name));
      if (!range) continue;
      const category = components[reference.kind] ??
        (components[reference.kind] = Object.create(null) as Record<string, unknown>);
      if (Object.prototype.hasOwnProperty.call(category, reference.name)) continue;
      const value = (await parseFragment(this.file, range))[reference.name];
      if (value === undefined) continue;
      category[reference.name] = value;
      if (value !== null && typeof value === "object") pending.push(...collectComponentRefs(value));
    }
    if (Object.keys(components).length > 0) document.components = components;
  }
}

function createMapOperationIndex(locators: Map<string, LazyOperationLocator>): LazyOperationIndex {
  assert(locators instanceof Map, "operation locators must be a map");
  assert(locators.size > 0, "operation locators must be non-empty");
  return {
    size: locators.size,
    names: () => [...locators.keys()],
    get(name: string): LazyOperationLocator | undefined {
      assert(typeof name === "string", "operation name must be a string");
      assert(name.length <= OPERATION_NAME_LOOKUP_LENGTH_MAX, "operation name exceeds the lookup length limit");
      return locators.get(name);
    },
  };
}

function selectPathItem(pathItem: Record<string, unknown>, method: string): Record<string, unknown> {
  assert(isRecord(pathItem), "path item must be an object");
  assert(HTTP_METHODS.has(method), "operation method must be supported");
  const selected: Record<string, unknown> = {};
  for (const key of PATH_ITEM_KEYS) {
    if (Object.prototype.hasOwnProperty.call(pathItem, key)) selected[key] = pathItem[key];
  }
  selected[method] = pathItem[method];
  assert(isRecord(selected[method]), "selected operation must be an object");
  return selected;
}

interface ComponentReference {
  kind: string;
  name: string;
}

function collectComponentRefs(root: object): ComponentReference[] {
  assert(root !== null && typeof root === "object", "reference root must be an object");
  assert(!Array.isArray(root) || root.length <= COMPONENT_REFERENCE_COUNT_MAX, "reference root array is too large");
  const pending: unknown[] = [root];
  const references: ComponentReference[] = [];
  let visitedCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    visitedCount += 1;
    if (visitedCount > COMPONENT_REFERENCE_COUNT_MAX) throw new Error("Lazy source index: object traversal limit exceeded.");
    if (Array.isArray(current)) {
      for (const item of current) pending.push(item);
      continue;
    }
    collectObjectRefs(current as Record<string, unknown>, pending, references);
  }
  assert(references.length <= COMPONENT_REFERENCE_COUNT_MAX, "too many component references collected");
  return references;
}

function collectObjectRefs(
  object: Record<string, unknown>,
  pending: unknown[],
  references: ComponentReference[],
): void {
  assert(isRecord(object), "reference value must be an object");
  assert(Array.isArray(pending) && Array.isArray(references), "reference collections must be arrays");
  for (const [key, child] of Object.entries(object)) {
    if (key === "$ref" && typeof child === "string") {
      const reference = parseComponentReference(child);
      if (reference) references.push(reference);
    } else {
      pending.push(child);
    }
  }
  if (pending.length > COMPONENT_REFERENCE_COUNT_MAX) throw new Error("Lazy source index: traversal queue limit exceeded.");
}

function parseComponentReference(value: string): ComponentReference | undefined {
  assert(typeof value === "string", "component reference must be a string");
  assert(value.length <= SOURCE_BYTES_MAX, "component reference exceeds the safety limit");
  if (!value.startsWith("#/components/")) return undefined;
  const parts = value.slice("#/components/".length).split("/");
  if (parts.length < 2) return undefined;
  return { kind: decodePointerPart(parts[0]!), name: decodePointerPart(parts[1]!) };
}

function decodePointerPart(value: string): string {
  assert(typeof value === "string", "JSON Pointer segment must be a string");
  assert(value.length <= SOURCE_BYTES_MAX, "JSON Pointer segment exceeds the safety limit");
  return value.replaceAll("~1", "/").replaceAll("~0", "~");
}

function componentKey(kind: string, name: string): string {
  assert(kind.length > 0, "component kind must be non-empty");
  assert(name.length > 0, "component name must be non-empty");
  return `${kind}\u0000${name}`;
}

async function indexYamlSource(
  filePath: string,
  sourceSize: number,
): Promise<IndexedSource | undefined> {
  assert(typeof filePath === "string" && filePath.length > 0, "source path must be non-empty");
  assert(Number.isInteger(sourceSize) && sourceSize > 0, "source size must be positive");
  const source: IndexedSource = {
    filePath,
    size: sourceSize,
    topLevel: new Map(),
    paths: new Map(),
    components: new Map(),
  };
  const state: ScanState = { supported: true };
  const file = await open(filePath, "r");
  const chunk = Buffer.allocUnsafe(64 * 1024);
  let pending = Buffer.alloc(0);
  let pendingStart = 0;
  try {
    let filePosition = 0;
    while (filePosition < sourceSize && state.supported) {
      const requested = Math.min(chunk.byteLength, sourceSize - filePosition);
      const { bytesRead } = await file.read(chunk, 0, requested, filePosition);
      if (bytesRead === 0) break;
      filePosition += bytesRead;
      const combined = pending.byteLength === 0
        ? Buffer.from(chunk.subarray(0, bytesRead))
        : Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      let lineOffset = 0;
      for (let newline = combined.indexOf(10, lineOffset); newline >= 0; newline = combined.indexOf(10, lineOffset)) {
        processLineBytes(source, state, combined.subarray(lineOffset, newline), pendingStart + lineOffset);
        lineOffset = newline + 1;
        if (!state.supported) break;
      }
      pending = Buffer.from(combined.subarray(lineOffset));
      pendingStart += lineOffset;
      if (pending.byteLength > SOURCE_LINE_BYTES_MAX) {
        throw new Error(`Lazy source index: line exceeds ${SOURCE_LINE_BYTES_MAX} bytes.`);
      }
    }
    if (state.supported && pending.byteLength > 0) processLineBytes(source, state, pending, pendingStart);
  } finally {
    await file.close();
  }
  closeAllRanges(state, sourceSize);
  if (!state.supported || source.paths.size === 0) return undefined;
  for (const indexedPath of source.paths.values()) {
    if (indexedPath.operations.length === 0) return undefined;
  }
  return source;
}

function processLineBytes(
  source: IndexedSource,
  state: ScanState,
  lineBytes: Buffer,
  position: number,
): void {
  assert(lineBytes.byteLength <= SOURCE_LINE_BYTES_MAX, "source line must be bounded");
  assert(position >= 0 && position <= source.size, "line position must be within source");
  const contentEnd = lineBytes.byteLength > 0 && lineBytes[lineBytes.byteLength - 1] === 13
    ? lineBytes.byteLength - 1
    : lineBytes.byteLength;
  let lineText = lineBytes.toString("utf8", 0, contentEnd);
  if (position === 0 && lineText.charCodeAt(0) === 0xfeff) lineText = lineText.slice(1);
  const line = readLine(lineText, 0, lineText.length);
  if (!line.valid) {
    state.supported = false;
    return;
  }
  processIndexedLine(source, state, line, position);
}

function processIndexedLine(
  source: IndexedSource,
  state: ScanState,
  line: ParsedLine,
  position: number,
): void {
  assert(source.size >= position, "line position must be within source");
  assert(line.indent >= 0, "line indentation must be non-negative");
  if (line.blank) return;
  if (state.blockScalarIndent !== undefined) {
    if (line.indent > state.blockScalarIndent) return;
    state.blockScalarIndent = undefined;
  }
  if (line.documentMarker !== undefined) {
    processDocumentMarker(state, line.documentMarker);
    return;
  }
  state.contentSeen = true;
  closeRangesAtIndent(state, line.indent, position);
  if (line.key === undefined) {
    if (line.indent === 0 || (state.operationIdIndent !== undefined && line.indent > state.operationIdIndent)) {
      state.supported = false;
    }
    return;
  }
  if (state.operationIdIndent !== undefined && line.indent <= state.operationIdIndent) {
    state.operationIdIndent = undefined;
  }
  if (line.indent === 0) startTopLevel(source, state, line, position);
  else if (state.topName === "paths") processPathLine(source, state, line, position);
  else if (state.topName === "components") processComponentLine(source, state, line, position);
  if (isBlockScalar(line.value)) state.blockScalarIndent = line.indent;
}

function processDocumentMarker(
  state: ScanState,
  marker: NonNullable<ParsedLine["documentMarker"]>,
): void {
  assert(state.supported === true || state.supported === false, "scanner support flag must be boolean");
  assert(marker === "start" || marker === "end" || marker === "directive", "document marker must be recognized");
  if (marker !== "start" || state.documentMarkerSeen || state.contentSeen) {
    state.supported = false;
    return;
  }
  state.documentMarkerSeen = true;
}

function startTopLevel(
  source: IndexedSource,
  state: ScanState,
  line: ParsedLine,
  position: number,
): void {
  assert(line.key !== undefined && line.key.length > 0, "top-level key must be non-empty");
  assert(position >= 0, "top-level position must be non-negative");
  const range = { start: position, end: source.size, indent: 0 };
  if (line.key === "paths" && source.topLevel.has(line.key)) {
    source.paths.clear();
    state.operationCount = 0;
  }
  if (line.key === "components" && source.topLevel.has(line.key)) source.components.clear();
  source.topLevel.set(line.key, range);
  state.topName = line.key;
  if ((line.key === "paths" || line.key === "components") && !isEmptyMappingValue(line.value)) state.supported = false;
  state.topRange = range;
  state.pathChildIndent = undefined;
  state.componentKind = undefined;
  state.componentKindIndent = undefined;
  state.ignoredPathExtensionIndent = undefined;
}

function processPathLine(
  source: IndexedSource,
  state: ScanState,
  line: ParsedLine,
  position: number,
): void {
  assert(line.key !== undefined, "path line must contain a key");
  assert(state.topName === "paths", "path line must be inside paths");
  if (state.ignoredPathExtensionIndent !== undefined) {
    if (line.indent > state.ignoredPathExtensionIndent) return;
    state.ignoredPathExtensionIndent = undefined;
  }
  if (state.pathName === undefined) {
    if (line.key.startsWith("x-")) {
      state.ignoredPathExtensionIndent = line.indent;
      return;
    }
    if (!line.key.startsWith("/")) {
      state.supported = false;
      return;
    }
    if (!isEmptyMappingValue(line.value)) {
      state.supported = false;
      return;
    }
    const range = { start: position, end: source.size, indent: line.indent };
    state.operationCount = (state.operationCount ?? 0) - (source.paths.get(line.key)?.operations.length ?? 0);
    source.paths.set(line.key, { range, operations: [] });
    if (source.paths.size > INDEX_ENTRY_COUNT_MAX) state.supported = false;
    state.pathName = line.key;
    state.pathIndent = line.indent;
    state.pathRange = range;
    state.pathChildIndent = undefined;
    return;
  }
  if (state.pathChildIndent === undefined) state.pathChildIndent = line.indent;
  if (line.indent !== state.pathChildIndent) {
    captureOperationId(state, line);
    return;
  }
  if (line.key === "$ref") {
    state.supported = false;
    return;
  }
  if (!HTTP_METHODS.has(line.key)) return;
  if (!isEmptyMappingValue(line.value)) {
    state.supported = false;
    return;
  }
  const operation = { method: line.key, range: { start: position, end: source.size, indent: line.indent } };
  const operations = source.paths.get(state.pathName)!.operations;
  const duplicateIndex = operations.findIndex((candidate) => candidate.method === line.key);
  if (duplicateIndex >= 0) operations[duplicateIndex] = operation;
  else {
    operations.push(operation);
    state.operationCount = (state.operationCount ?? 0) + 1;
  }
  if ((state.operationCount ?? 0) > INDEX_ENTRY_COUNT_MAX) state.supported = false;
  state.operation = operation;
  state.operationChildIndent = undefined;
  state.operationIdIndent = undefined;
}

function captureOperationId(state: ScanState, line: ParsedLine): void {
  assert(line.indent >= 0, "operation child indentation must be non-negative");
  assert(state.pathName !== undefined, "operation child must belong to a path");
  if (!state.operation || line.key === undefined) return;
  if (state.operationChildIndent === undefined) state.operationChildIndent = line.indent;
  if (line.indent === state.operationChildIndent && line.key === "operationId") {
    if (!line.value || !isIndexableOperationId(line.value)) {
      state.supported = false;
      return;
    }
    state.operation.operationId = decodeScalar(line.value);
    state.operationIdIndent = line.indent;
  }
}

function processComponentLine(
  source: IndexedSource,
  state: ScanState,
  line: ParsedLine,
  position: number,
): void {
  assert(line.key !== undefined, "component line must contain a key");
  assert(state.topName === "components", "component line must be inside components");
  if (state.componentKind === undefined) {
    if (!isEmptyMappingValue(line.value)) {
      state.supported = false;
      return;
    }
    state.componentKind = line.key;
    state.componentKindIndent = line.indent;
    state.componentIndent = undefined;
    return;
  }
  if (state.componentIndent === undefined) state.componentIndent = line.indent;
  if (line.indent !== state.componentIndent) return;
  const range = { start: position, end: source.size, indent: line.indent };
  source.components.set(componentKey(state.componentKind, line.key), range);
  if (source.components.size > INDEX_ENTRY_COUNT_MAX) state.supported = false;
  state.componentRange = range;
}

function closeRangesAtIndent(state: ScanState, indent: number, position: number): void {
  assert(indent >= 0, "closing indentation must be non-negative");
  assert(position >= 0, "closing position must be non-negative");
  if (state.operation && indent <= state.operation.range.indent) {
    state.operation.range.end = position;
    state.operation = undefined;
    state.operationChildIndent = undefined;
  }
  if (state.pathRange && state.pathIndent !== undefined && indent <= state.pathIndent) {
    state.pathRange.end = position;
    state.pathName = undefined;
    state.pathIndent = undefined;
    state.pathChildIndent = undefined;
    state.pathRange = undefined;
  }
  closeComponentRanges(state, indent, position);
  if (state.topRange && indent === 0) {
    state.topRange.end = position;
    state.topName = undefined;
    state.topRange = undefined;
  }
}

function closeComponentRanges(state: ScanState, indent: number, position: number): void {
  assert(indent >= 0, "component closing indentation must be non-negative");
  assert(position >= 0, "component closing position must be non-negative");
  if (state.componentRange && state.componentIndent !== undefined && indent <= state.componentIndent) {
    state.componentRange.end = position;
    state.componentRange = undefined;
  }
  if (state.componentKindIndent !== undefined && indent <= state.componentKindIndent) {
    state.componentKind = undefined;
    state.componentKindIndent = undefined;
    state.componentIndent = undefined;
  }
}

function closeAllRanges(state: ScanState, end: number): void {
  assert(end >= 0, "source end must be non-negative");
  assert(state.supported === true || state.supported === false, "scanner support flag must be boolean");
  if (state.operation) state.operation.range.end = end;
  if (state.pathRange) state.pathRange.end = end;
  if (state.componentRange) state.componentRange.end = end;
  if (state.topRange) state.topRange.end = end;
}

async function isOpenApi3(source: IndexedSource): Promise<boolean> {
  assert(source.topLevel instanceof Map, "top-level index must be a map");
  assert(source.size > 0, "indexed source must be non-empty");
  const openapi = source.topLevel.get("openapi");
  const info = source.topLevel.get("info");
  if (!openapi || !info) return false;
  const file = await open(source.filePath, "r");
  try {
    const value = (await parseFragment(file, openapi)).openapi;
    return typeof value === "string" && value.startsWith("3.");
  } finally {
    await file.close();
  }
}

async function readBaseUrl(file: FileHandle, source: IndexedSource): Promise<string> {
  assert(file.fd >= 0, "source file must be open");
  assert(source.size > 0, "indexed source must be non-empty");
  const range = source.topLevel.get("servers");
  if (!range) return "";
  const servers = (await parseFragment(file, range)).servers;
  if (!Array.isArray(servers) || servers.length === 0) return "";
  return isRecord(servers[0]) && typeof servers[0].url === "string" ? servers[0].url : "";
}

function readLine(text: string, start: number, end: number): ParsedLine {
  assert(start >= 0 && start <= end, "line start must precede line end");
  assert(end <= text.length, "line end must be within source text");
  let cursor = start;
  while (cursor < end && text.charCodeAt(cursor) === 32) cursor += 1;
  if (cursor < end && text.charCodeAt(cursor) === 9) {
    return { indent: cursor - start, blank: false, valid: false };
  }
  if (cursor === end || text.charCodeAt(cursor) === 35) {
    return { indent: cursor - start, blank: true, valid: true };
  }
  const indent = cursor - start;
  const documentMarker = indent === 0
    ? readDocumentMarker(text.slice(cursor, end))
    : undefined;
  if (documentMarker) return { indent, blank: false, documentMarker, valid: true };
  const colon = findKeyColon(text, cursor, end);
  if (colon < 0) return { indent, blank: false, valid: true };
  const key = decodeKey(text.slice(cursor, colon).trim());
  return {
    indent,
    key: key.length > 0 ? key : undefined,
    value: text.slice(colon + 1, end).trim(),
    blank: false,
    valid: key.length > 0,
  };
}

function readDocumentMarker(value: string): ParsedLine["documentMarker"] {
  assert(typeof value === "string", "document marker source must be a string");
  assert(value.length <= SOURCE_BYTES_MAX, "document marker source exceeds the safety limit");
  const content = value.split(/\s+#/, 1)[0]!.trim();
  if (content === "---") return "start";
  if (content === "...") return "end";
  if (content.startsWith("%")) return "directive";
  return undefined;
}

function findKeyColon(text: string, start: number, end: number): number {
  assert(start >= 0 && start <= end, "key start must precede key end");
  assert(end <= text.length, "key end must be within source text");
  let quote = "";
  let escaped = false;
  for (let index = start; index < end; index += 1) {
    const character = text[index]!;
    if (quote === '"' && escaped) {
      escaped = false;
    } else if (quote === '"' && character === "\\") {
      escaped = true;
    } else if (quote !== "" && character === quote) {
      quote = "";
    } else if (quote === "" && (character === '"' || character === "'")) {
      quote = character;
    } else if (quote === "" && character === ":" && isKeySeparator(text, index + 1, end)) {
      return index;
    }
  }
  return -1;
}

function isKeySeparator(text: string, index: number, end: number): boolean {
  assert(index >= 0 && index <= end, "separator index must be within line");
  assert(end <= text.length, "separator line end must be within source");
  if (index === end) return true;
  const code = text.charCodeAt(index);
  return code === 32 || code === 9 || code === 35;
}

function isIndexableOperationId(value: string): boolean {
  assert(typeof value === "string" && value.length > 0, "operation ID scalar must be non-empty");
  assert(value.length <= SOURCE_BYTES_MAX, "operation ID scalar exceeds the safety limit");
  const trimmed = stripScalarComment(value);
  if (trimmed.length === 0 || isBlockScalar(trimmed) || /^[&!*\[{]/.test(trimmed)) return false;
  if (/^(?:~|null|true|false|[-+]?\.(?:inf|nan))$/i.test(trimmed)) return false;
  if (/^[-+]?(?:0|[1-9][0-9_]*)(?:\.[0-9_]*)?(?:e[-+]?[0-9]+)?$/i.test(trimmed)) return false;
  if (/^[-+]?0(?:x[0-9a-f_]+|o[0-7_]+|b[01_]+)$/i.test(trimmed)) return false;
  if (trimmed.startsWith('"')) {
    try {
      return typeof JSON.parse(trimmed) === "string";
    } catch {
      return false;
    }
  }
  if (!trimmed.startsWith("'")) return true;
  let index = 1;
  while (index < trimmed.length) {
    if (trimmed[index] !== "'") {
      index += 1;
      continue;
    }
    if (trimmed[index + 1] === "'") {
      index += 2;
      continue;
    }
    return index === trimmed.length - 1;
  }
  return false;
}

function decodeScalar(value: string): string {
  assert(typeof value === "string" && value.length > 0, "scalar text must be non-empty");
  assert(value.length <= SOURCE_BYTES_MAX, "scalar text exceeds the safety limit");
  const trimmed = stripScalarComment(value);
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(trimmed);
      return typeof decoded === "string" ? decoded : trimmed;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) return trimmed.slice(1, -1).replaceAll("''", "'");
  return trimmed;
}

function stripScalarComment(value: string): string {
  assert(typeof value === "string", "scalar value must be a string");
  assert(value.length <= SOURCE_BYTES_MAX, "scalar value exceeds the safety limit");
  let quote = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (quote !== "" && character === quote) quote = "";
    else if (quote === "" && (character === '"' || character === "'")) quote = character;
    else if (quote === "" && character === "#" && (index === 0 || /\s/.test(value[index - 1]!))) {
      return value.slice(0, index).trim();
    }
  }
  return value.trim();
}

function decodeKey(value: string): string {
  assert(typeof value === "string", "mapping key must be a string");
  assert(value.length <= SOURCE_BYTES_MAX, "mapping key exceeds the safety limit");
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      const decoded: unknown = JSON.parse(value);
      return typeof decoded === "string" ? decoded : value;
    } catch {
      return value;
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

async function parseFragment(
  file: FileHandle,
  range: SourceRange,
): Promise<Record<string, unknown>> {
  assert(file.fd >= 0, "source file must be open");
  assert(range.start >= 0 && range.end > range.start, "source fragment range must be non-empty");
  const size = range.end - range.start;
  if (size > SOURCE_FRAGMENT_BYTES_MAX) {
    throw new Error(`Lazy source index: fragment exceeds ${SOURCE_FRAGMENT_BYTES_MAX} bytes.`);
  }
  const bytes = Buffer.allocUnsafe(size);
  let offset = 0;
  while (offset < size) {
    const result = await file.read(bytes, offset, size - offset, range.start + offset);
    if (result.bytesRead === 0) throw new Error("Lazy source index: source fragment ended unexpectedly.");
    offset += result.bytesRead;
  }
  const fragment = bytes.toString("utf8");
  const normalized = fragment.split("\n").map((line) => removeIndent(line, range.indent)).join("\n");
  const parsed = parseSpecText(normalized);
  assert(isRecord(parsed), "source fragment must parse to an object");
  assert(offset === size, "source fragment must be read completely");
  return parsed;
}

function removeIndent(line: string, indent: number): string {
  assert(typeof line === "string", "fragment line must be a string");
  assert(Number.isInteger(indent) && indent >= 0, "fragment indentation must be non-negative");
  let removed = 0;
  while (removed < line.length && removed < indent && line.charCodeAt(removed) === 32) removed += 1;
  return line.slice(removed);
}

function isEmptyMappingValue(value: string | undefined): boolean {
  assert(value === undefined || typeof value === "string", "mapping value must be a string or undefined");
  assert(value === undefined || value.length <= SOURCE_BYTES_MAX, "mapping value exceeds the safety limit");
  return value === undefined || value === "" || value.startsWith("#");
}

function isBlockScalar(value: string | undefined): boolean {
  assert(value === undefined || typeof value === "string", "mapping value must be a string or undefined");
  assert(value === undefined || value.length <= SOURCE_BYTES_MAX, "mapping value exceeds the safety limit");
  return value !== undefined && /^[>|](?:[1-9][+-]?|[+-][1-9]?|)(?:\s+#.*)?$/.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
