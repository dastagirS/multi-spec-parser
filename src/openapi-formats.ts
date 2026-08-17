import assert from "node:assert/strict";
import type { Ajv } from "ajv";

const INT32_MIN = -2_147_483_648;
const INT32_MAX = 2_147_483_647;
const ASCII_UPPERCASE_MIN = "A".charCodeAt(0);
const ASCII_UPPERCASE_MAX = "Z".charCodeAt(0);
const ASCII_LOWERCASE_MIN = "a".charCodeAt(0);
const ASCII_LOWERCASE_MAX = "z".charCodeAt(0);
const ASCII_DIGIT_MIN = "0".charCodeAt(0);
const ASCII_DIGIT_MAX = "9".charCodeAt(0);
const BASE64_PLUS = "+".charCodeAt(0);
const BASE64_SLASH = "/".charCodeAt(0);
/** ajv-formats is CommonJS; NodeNext exposes its callable default in
 *  different shapes for static and dynamic imports, so accept both forms. */
export function resolveAjvFormatsPlugin(module: unknown): (instance: Ajv) => void {
  assert(module !== null && (typeof module === "object" || typeof module === "function"), "Ajv formats module is required");
  if (typeof module === "function") return module as (instance: Ajv) => void;
  const firstDefault = Reflect.get(module, "default");
  if (typeof firstDefault === "function") return firstDefault as (instance: Ajv) => void;
  assert(firstDefault !== null && typeof firstDefault === "object", "Ajv formats module has no callable default export");
  const nestedDefault = Reflect.get(firstDefault, "default");
  assert(typeof nestedDefault === "function", "Ajv formats module default export is not callable");
  return nestedDefault as (instance: Ajv) => void;
}

/** Register OpenAPI formats that Ajv does not provide itself. Standard JSON
 *  Schema formats are installed separately through ajv-formats. */
export function registerOpenApiFormats(instance: Ajv): void {
  assert(instance !== null && typeof instance === "object", "Ajv instance is required");
  assert(typeof instance.addFormat === "function", "Ajv instance must support formats");
  instance.addFormat("int32", { type: "number", validate: isInt32 });
  instance.addFormat("int64", { type: "number", validate: isSafeInt64 });
  instance.addFormat("byte", { type: "string", validate: isBase64 });
  instance.addFormat("float", true);
  instance.addFormat("double", true);
  instance.addFormat("binary", true);
  instance.addFormat("password", true);
}

function isInt32(value: number): boolean {
  assert(typeof value === "number", "int32 value must be a number");
  assert(Number.isFinite(value), "int32 value must be finite");
  return Number.isInteger(value) && value >= INT32_MIN && value <= INT32_MAX;
}

function isSafeInt64(value: number): boolean {
  assert(typeof value === "number", "int64 value must be a number");
  assert(Number.isFinite(value), "int64 value must be finite");
  return Number.isSafeInteger(value);
}

function isBase64(value: string): boolean {
  assert(typeof value === "string", "byte value must be a string");
  assert(value.length <= Number.MAX_SAFE_INTEGER, "byte value length must be safe");
  if (value.length % 4 !== 0) return false;
  const paddingStart = value.indexOf("=");
  const contentLength = paddingStart === -1 ? value.length : paddingStart;
  const paddingLength = value.length - contentLength;
  if (paddingLength > 2) return false;
  if (paddingLength === 1 && contentLength % 4 !== 3) return false;
  if (paddingLength === 2 && contentLength % 4 !== 2) return false;
  for (let index = 0; index < contentLength; index += 1) {
    const code = value.charCodeAt(index);
    const alphabetic =
      (code >= ASCII_UPPERCASE_MIN && code <= ASCII_UPPERCASE_MAX) ||
      (code >= ASCII_LOWERCASE_MIN && code <= ASCII_LOWERCASE_MAX);
    const numeric = code >= ASCII_DIGIT_MIN && code <= ASCII_DIGIT_MAX;
    if (!alphabetic && !numeric && code !== BASE64_PLUS && code !== BASE64_SLASH) return false;
  }
  for (let index = contentLength; index < value.length; index += 1) {
    if (value[index] !== "=") return false;
  }
  return true;
}
