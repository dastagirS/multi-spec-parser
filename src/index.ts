/**
 * Parse OpenAPI 3.x, Swagger 2.0, and Google Discovery descriptions into
 * normalized operation-level JSON Schemas.
 */
export { MultiSpecParser } from "./multi-spec-parser.js";
export type {
  MultiSpecParserConfig,
  MultiSpecParserOptions,
  ParseOptions,
  SpecSource,
} from "./multi-spec-parser.js";
export type { CompiledOperation } from "./operation-compiler.js";
export type {
  DefaultPolicy,
  StandardJSONSchemaV1,
  StandardJsonSchemaOptions,
  StandardJsonSchemaTarget,
  StandardSchema,
  StandardSchemaAdapterOptions,
  StandardSchemaIssue,
  StandardSchemaLike,
  StandardSchemaOptions,
  StandardSchemaResult,
  StandardSchemaV1,
} from "./standard-schema.js";
export type {
  ExtractedOperation,
  GoogleDiscoveryDoc,
  GoogleMethodObject,
  GoogleParameterObject,
  GoogleResourceObject,
  GoogleSchemaObject,
  HttpMethod,
  MediaBinding,
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
  NormalizedSecurityRequirement,
  NormalizedSecurityScheme,
  Swagger2Operation,
  Swagger2Parameter,
  Swagger2PathItem,
  Swagger2Response,
  Swagger2Spec,
} from "./types.js";
