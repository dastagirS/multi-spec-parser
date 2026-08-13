import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

/**
 * YAML values accepted by the API-description profile. The native parser
 * deliberately returns JSON-compatible graph data and rejects YAML graph
 * features such as aliases, tags, directives, and multiple documents.
 */
export type YamlValue = null | boolean | number | string | YamlValue[] | YamlObject;

export interface YamlObject {
  [key: string]: YamlValue;
}

export type YamlParserOptions = {
  maxDepth?: number;
  maxNodes?: number;
};

type NativeYamlAddon = {
  parseYaml(text: string): YamlValue;
  parseYaml(text: string, options: YamlParserOptions): YamlValue;
};

let nativeAddon: NativeYamlAddon | undefined;

function assertCondition(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
  if (condition !== true) throw new Error(message);
}

function nativeAddonPaths(): string[] {
  const platformArchitecture = `${process.platform}-${process.arch}`;
  const candidates = [
    new URL(`../../native/prebuilds/${platformArchitecture}/parser.node`, import.meta.url),
    new URL(`../../native/build/Release/parser.node`, import.meta.url),
    new URL(`../native/prebuilds/${platformArchitecture}/parser.node`, import.meta.url),
    new URL(`../native/build/Release/parser.node`, import.meta.url),
  ].map((candidate) => fileURLToPath(candidate));
  const result = candidates.filter((candidate, index) => existsSync(candidate) && candidates.indexOf(candidate) === index);
  assertCondition(result.every((candidate) => candidate.endsWith("parser.node")), "Invalid native addon path");
  return result;
}

function loadNativeAddon(): NativeYamlAddon {
  const require = createRequire(import.meta.url);
  const candidates = nativeAddonPaths();
  const failures: string[] = [];
  for (const candidate of candidates) {
    try {
      const addon = require(candidate) as NativeYamlAddon;
      assertCondition(typeof addon.parseYaml === "function", `Native addon has no parseYaml export: ${candidate}`);
      return addon;
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const detail = failures.length > 0 ? `\n${failures.join("\n")}` : "";
  throw new Error(
    `Native YAML parser is unavailable for ${process.platform}-${process.arch}. ` +
      "Run npm install to use a prebuilt addon or compile the bundled C source." + detail,
  );
}

/** Parse the supported API-description YAML profile using the Node-API addon. */
function getNativeAddon(): NativeYamlAddon {
  if (nativeAddon === undefined) nativeAddon = loadNativeAddon();
  assertCondition(typeof nativeAddon.parseYaml === "function", "Native addon lost parseYaml export");
  return nativeAddon;
}

export function parseYaml(text: string, options?: YamlParserOptions): YamlValue {
  assertCondition(typeof text === "string", "YAML input must be a string");
  assertCondition(options === undefined || (options !== null && typeof options === "object"), "YAML options must be an object");
  const addon = getNativeAddon();
  const result = options === undefined ? addon.parseYaml(text) : addon.parseYaml(text, options);
  assertCondition(result !== undefined, "Native YAML parser returned undefined");
  return result;
}
