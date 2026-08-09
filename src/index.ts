/**
 * multi-spec-parser — parse OpenAPI 3.0/3.1, Swagger 2.0, and Google Discovery
 * specs into one normalized model, then compile memory-safe LLM tool schemas.
 */

export { parseSpec, parseSpecText, fetchSpecText, detectSpecFormat } from "./parse-spec.js";
export { compileSpecToTools, compileSpecSource, clearSpecCache } from "./factory.js";
export { buildRequest, executeRequest, queryParamEntries } from "./request-builder.js";
export { normalizeDefs, normalizeSchemaRefs, collectReachableDefs } from "./schema-closure.js";
export { DocResolver, isRef } from "./ref-resolver.js";

export type { CompiledTool, CompileResult } from "./factory.js";
export type { BuiltRequest, RequestBuildOptions, ExecuteOptions, ExecuteResult } from "./request-builder.js";
export type {
  ExtractedOperation,
  GoogleDiscoveryDoc,
  GoogleMethodObject,
  GoogleParameterObject,
  GoogleResourceObject,
  GoogleSchemaObject,
  HttpMethod,
  MediaBinding,
  MediaUploadInfo,
  NormalizedParameter,
  NormalizedRequestBody,
  OpenApi3PathItem,
  OpenApi3Spec,
  OperationObject,
  ParamLocation,
  ParameterObject,
  ParsedSpec,
  RefObject,
  RequestBodyObject,
  ResponseObject,
  SchemaObject,
  ServerInfo,
  ServerVariable,
  SpecFormat,
  Swagger2Operation,
  Swagger2Parameter,
  Swagger2PathItem,
  Swagger2Response,
  Swagger2Spec,
} from "./types.js";
