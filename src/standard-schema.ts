/**
 * Item 6: Standard Schema (https://standardschema.dev) adapter — the open
 * `~standard` protocol consumed by Mastra, Zod, Valibot, ArkType, etc.
 *
 * Deliberately NOT a framework adapter: this package never depends on Mastra
 * or any other framework. Consumers hand the result to whichever framework
 * they use; the validate function is a real JSON-Schema validator (Ajv), so
 * the protocol contract is honored, not stubbed.
 */
import { Ajv } from "ajv";
import type { CompiledTool } from "./factory.js";

export interface StandardSchemaLike<T = unknown> {
  "~standard": {
    version: 1;
    vendor: "multi-spec-parser";
    validate: (value: unknown) => { value: T } | { issues: Array<{ message: string }> };
    types?: undefined;
  };
}

const ajv = new Ajv({ strict: false, allErrors: true });
// Whole wrapper memoized per tool: stable object identity for framework
// adapters, and the Ajv validator is compiled exactly once per tool.
const wrappers = new WeakMap<CompiledTool, StandardSchemaLike>();

/** Wrap a compiled tool's input schema as a Standard Schema. Memoized per
 *  tool object (compiled tools are shared across calls) — repeated wrapping
 *  returns the same wrapper and never recompiles the validator. */
export function toStandardSchema(tool: CompiledTool): StandardSchemaLike {
  let wrapper = wrappers.get(tool);
  if (!wrapper) {
    const validate = ajv.compile(tool.inputSchema as object);
    wrapper = {
      "~standard": {
        version: 1,
        vendor: "multi-spec-parser",
        validate: (value) => {
          if (validate(value)) return { value };
          const issues =
            validate.errors?.map((e) => ({ message: e.message ?? "invalid" })) ??
            [{ message: "invalid" }];
          return { issues };
        },
      },
    };
    wrappers.set(tool, wrapper);
  }
  return wrapper;
}
