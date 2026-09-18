import assert from "node:assert/strict";

const TYPE_NODE_MAX = 100_000;
const TYPE_DEPTH_MAX = 128;
const TYPE_BRANCH_MAX = 1_000;
const TYPE_OUTPUT_LENGTH_MAX = 256 * 1024;
const TYPE_PROPERTY_MAX = 10_000;

type Schema = Record<string, unknown>;

interface RenderFrame {
  readonly schema: Schema;
  readonly depth: number;
  readonly exit: boolean;
}

export interface RenderedSchemaType {
  readonly type: string;
  readonly definitions: Readonly<Record<string, string>>;
}

export function renderSchemaType(
  root: Schema,
  definitions: Readonly<Record<string, Schema>>,
): RenderedSchemaType {
  assert(isRecord(root), "type root must be an object schema");
  assert(isRecord(definitions), "type definitions must be an object");
  const reachableNames = collectReachableNames(root, definitions);
  const aliases = createAliases(reachableNames);
  const renderedDefinitions: Record<string, string> = {};
  for (const name of reachableNames) {
    const schema = definitions[name];
    if (!schema) continue;
    renderedDefinitions[aliases.get(name)!] = renderType(schema, aliases);
  }
  const type = renderType(root, aliases);
  assert(typeof type === "string" && type.length > 0, "rendered root type must be non-empty");
  assert(Object.keys(renderedDefinitions).length <= TYPE_NODE_MAX, "rendered definition count must be bounded");
  return { type, definitions: renderedDefinitions };
}

function renderType(root: Schema, aliases: ReadonlyMap<string, string>): string {
  assert(isRecord(root), "rendered schema must be an object");
  assert(aliases instanceof Map, "definition aliases must be a map");
  const rendered = new WeakMap<object, string>();
  const pending: RenderFrame[] = [{ schema: root, depth: 0, exit: false }];
  let nodeCount = 0;
  let branchCount = 0;
  while (pending.length > 0) {
    const frame = pending.pop()!;
    if (rendered.has(frame.schema)) continue;
    if (frame.depth > TYPE_DEPTH_MAX) {
      rendered.set(frame.schema, "unknown");
      continue;
    }
    if (!frame.exit) {
      nodeCount += 1;
      if (nodeCount > TYPE_NODE_MAX) return "unknown";
      const children = schemaChildren(frame.schema);
      branchCount += children.length;
      if (branchCount > TYPE_BRANCH_MAX) return "unknown";
      pending.push({ ...frame, exit: true });
      for (let index = children.length - 1; index >= 0; index -= 1) {
        if (!rendered.has(children[index]!)) pending.push({ schema: children[index]!, depth: frame.depth + 1, exit: false });
      }
      continue;
    }
    const value = renderNode(frame.schema, rendered, aliases);
    rendered.set(frame.schema, value.length <= TYPE_OUTPUT_LENGTH_MAX ? value : "unknown");
  }
  return rendered.get(root) ?? "unknown";
}

function renderNode(schema: Schema, rendered: WeakMap<object, string>, aliases: ReadonlyMap<string, string>): string {
  assert(isRecord(schema), "rendered node must be an object");
  assert(rendered instanceof WeakMap && aliases instanceof Map, "render caches must be maps");
  if (typeof schema.$ref === "string") {
    const name = parseDefinitionReference(schema.$ref);
    return name ? aliases.get(name) ?? "unknown" : "unknown";
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const")) return renderLiteral(schema.const);
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return joinBounded(schema.enum.map(renderLiteral), " | ");
  }
  const anyOf = readRenderedChildren(schema.anyOf, rendered);
  if (anyOf.length > 0) return joinBounded(anyOf, " | ");
  const oneOf = readRenderedChildren(schema.oneOf, rendered);
  if (oneOf.length > 0) return joinBounded(oneOf, " | ");
  const allOf = readRenderedChildren(schema.allOf, rendered);
  if (allOf.length > 0) return joinBounded(allOf, " & ");
  const declaredTypes = Array.isArray(schema.type)
    ? schema.type.filter((value): value is string => typeof value === "string")
    : typeof schema.type === "string" ? [schema.type] : [];
  if (declaredTypes.length > 1) return joinBounded(declaredTypes.map((type) => renderDeclaredType(type, schema, rendered, aliases)), " | ");
  if (declaredTypes.length === 1) return renderDeclaredType(declaredTypes[0]!, schema, rendered, aliases);
  if (isRecord(schema.properties) || schema.additionalProperties !== undefined) return renderObject(schema, rendered, aliases);
  if (schema.items !== undefined || Array.isArray(schema.prefixItems)) return renderArray(schema, rendered);
  return "unknown";
}

function renderDeclaredType(type: string, schema: Schema, rendered: WeakMap<object, string>, aliases: ReadonlyMap<string, string>): string {
  assert(typeof type === "string" && type.length > 0, "declared type must be non-empty");
  assert(isRecord(schema), "declared type schema must be an object");
  if (type === "object") return renderObject(schema, rendered, aliases);
  if (type === "array") return renderArray(schema, rendered);
  if (type === "integer" || type === "number") return "number";
  if (type === "null") return "null";
  if (type === "string" || type === "boolean") return type;
  return "unknown";
}

function renderObject(schema: Schema, rendered: WeakMap<object, string>, aliases: ReadonlyMap<string, string>): string {
  assert(isRecord(schema), "object type schema must be an object");
  assert(rendered instanceof WeakMap && aliases instanceof Map, "object render caches must be maps");
  const properties = isRecord(schema.properties) ? Object.entries(schema.properties) : [];
  if (properties.length > TYPE_PROPERTY_MAX) return "unknown";
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((value): value is string => typeof value === "string") : []);
  const members: string[] = [];
  for (const [name, child] of properties) {
    const childType = isRecord(child) ? rendered.get(child) ?? "unknown" : "unknown";
    members.push(`${renderPropertyName(name)}${required.has(name) ? "" : "?"}: ${childType};`);
  }
  const objectType = `{ ${members.join(" ")} }`;
  const value = isRecord(schema.additionalProperties)
    ? `${objectType} & Record<string, ${rendered.get(schema.additionalProperties) ?? "unknown"}>`
    : schema.additionalProperties !== false && properties.length === 0
      ? "Record<string, unknown>"
      : objectType;
  return value.length <= TYPE_OUTPUT_LENGTH_MAX ? value : "unknown";
}

function renderArray(schema: Schema, rendered: WeakMap<object, string>): string {
  assert(isRecord(schema), "array type schema must be an object");
  assert(rendered instanceof WeakMap, "array render cache must be a weak map");
  const tupleItems = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items) ? schema.items : [];
  if (tupleItems.length > 0) {
    const items = tupleItems.map((child) => isRecord(child) ? rendered.get(child) ?? "unknown" : "unknown");
    return `[${items.join(", ")}]`;
  }
  return isRecord(schema.items) ? `Array<${rendered.get(schema.items) ?? "unknown"}>` : "unknown[]";
}

function schemaChildren(schema: Schema): Schema[] {
  assert(isRecord(schema), "schema children source must be an object");
  assert(TYPE_BRANCH_MAX > 0, "type branch limit must be positive");
  const children: Schema[] = [];
  for (const key of ["items", "additionalItems", "additionalProperties"] as const) {
    if (isRecord(schema[key])) children.push(schema[key]);
  }
  for (const key of ["allOf", "anyOf", "oneOf", "prefixItems", "items"] as const) {
    if (Array.isArray(schema[key])) for (const child of schema[key]) if (isRecord(child)) children.push(child);
  }
  if (isRecord(schema.properties)) for (const child of Object.values(schema.properties)) if (isRecord(child)) children.push(child);
  return children;
}

function readRenderedChildren(value: unknown, rendered: WeakMap<object, string>): string[] {
  assert(rendered instanceof WeakMap, "child render cache must be a weak map");
  assert(TYPE_BRANCH_MAX > 0, "type branch limit must be positive");
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((child) => rendered.get(child) ?? "unknown");
}

function collectReachableNames(root: Schema, definitions: Readonly<Record<string, Schema>>): string[] {
  assert(isRecord(root), "reference root must be an object");
  assert(isRecord(definitions), "reference definitions must be an object");
  const names: string[] = [];
  const seen = new Set<string>();
  const pending: unknown[] = [root];
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === null || typeof current !== "object") continue;
    nodeCount += 1;
    if (nodeCount > TYPE_NODE_MAX) return [];
    if (Array.isArray(current)) {
      for (const child of current) pending.push(child);
      continue;
    }
    const record = current as Record<string, unknown>;
    if (typeof record.$ref === "string") {
      const name = parseDefinitionReference(record.$ref);
      if (name && !seen.has(name) && definitions[name]) {
        seen.add(name);
        names.push(name);
        pending.push(definitions[name]);
      }
    }
    for (const [key, child] of Object.entries(record)) if (key !== "$defs") pending.push(child);
  }
  return names;
}

function createAliases(names: readonly string[]): ReadonlyMap<string, string> {
  assert(Array.isArray(names), "definition names must be an array");
  assert(names.length <= TYPE_NODE_MAX, "definition names must be bounded");
  const aliases = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    const base = sanitizeIdentifier(name);
    let alias = base;
    let suffix = 2;
    while (used.has(alias)) {
      alias = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(alias);
    aliases.set(name, alias);
  }
  return aliases;
}

function sanitizeIdentifier(value: string): string {
  assert(typeof value === "string", "type identifier source must be a string");
  assert(value.length <= TYPE_OUTPUT_LENGTH_MAX, "type identifier source must be bounded");
  const sanitized = value.replace(/[^A-Za-z0-9_$]/g, "_");
  return /^[A-Za-z_$]/.test(sanitized) ? sanitized || "Definition" : `_${sanitized || "Definition"}`;
}

function renderPropertyName(value: string): string {
  assert(typeof value === "string", "property name must be a string");
  assert(value.length <= TYPE_OUTPUT_LENGTH_MAX, "property name must be bounded");
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : JSON.stringify(value);
}

function renderLiteral(value: unknown): string {
  assert(typeof value !== "function", "type literal cannot be a function");
  assert(typeof value !== "symbol", "type literal cannot be a symbol");
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const rendered = JSON.stringify(value);
    return rendered && rendered.length <= TYPE_OUTPUT_LENGTH_MAX ? rendered : "unknown";
  }
  return "unknown";
}

function joinBounded(values: readonly string[], separator: string): string {
  assert(Array.isArray(values) && values.length <= TYPE_BRANCH_MAX, "type union branches must be bounded");
  assert(typeof separator === "string", "type separator must be a string");
  const joined = values.join(separator);
  return joined.length <= TYPE_OUTPUT_LENGTH_MAX ? joined : "unknown";
}

function parseDefinitionReference(reference: string): string | undefined {
  assert(typeof reference === "string", "type reference must be a string");
  assert(reference.length <= TYPE_OUTPUT_LENGTH_MAX, "type reference must be bounded");
  if (!reference.startsWith("#/$defs/")) return undefined;
  return reference.slice("#/$defs/".length).replaceAll("~1", "/").replaceAll("~0", "~");
}

function isRecord(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
