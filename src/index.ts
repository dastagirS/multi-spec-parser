/**
 * multi-spec-parser — parse OpenAPI 3.0/3.1, Swagger 2.0, and Google Discovery
 * specs into one normalized model, then compile memory-safe LLM tool schemas.
 *
 * Public surface is a single class (MultiSpecParser); internal functions are
 * unreachable through the exports map.
 */
export { MultiSpecParser } from "./multi-spec-parser.js";
export type {
  MultiSpecParserConfig,
  MultiSpecParserOptions,
  SpecSource,
} from "./multi-spec-parser.js";
export type { CompiledTool, CompileResult, CompileOptions } from "./factory.js";
export type {
  BuiltRequest,
  ExecuteOptions,
  ExecuteResult,
  RequestBuildOptions,
} from "./request-builder.js";
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
