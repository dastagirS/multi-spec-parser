Based on `multi-spec-parser@0.3.0`, the main pain points were:

| Pain point | What the library could provide |
|---|---|
| **No first-class authentication model** | Normalize OpenAPI security schemes and expose an auth provider interface for OAuth, API keys, custom headers, refresh, precedence, and retry behavior. |
| **Limited request customization** | Request/response middleware, custom `fetch`, `AbortSignal`, proxy support, request IDs, and transport injection. |
| **No external `$ref` resolver hook** | Configurable resolver with caching, base-URL handling, allowlists, and clear unresolved-reference diagnostics. |
| **Runtime processors have sparse context** | Provide response headers, URL, status, content type, raw bytes, retry count, abort signal, and consumer-defined context. |
| **No streaming response API** | Support response streams or chunk callbacks instead of always buffering and JSON-parsing the entire response. |
| **Provider-specific protocols require reimplementation** | Add an extensible request strategy/plugin interface for alternate endpoints, multipart protocols, custom encodings, and nonstandard upload flows. |
| **Schema customization is limited** | Add pre-compilation schema and operation transforms, custom naming, metadata enrichment, and configurable schema projection policies. |
| **Tool naming collisions lack policy hooks** | Allow consumers to define deterministic naming, collision behavior, and namespace strategies. |
| **Normalized metadata is incomplete/unstable** | Expose stable public operation metadata for security, vendor extensions, callbacks, webhooks, links, and response variants. |
| **Caching is not sufficiently controllable** | Add explicit cache TTL, invalidation, size limits, cache inspection, and optional compiled-tool caching keyed by configuration. |
| **Error results are too generic** | Return structured error codes, causes, request metadata, retry history, timeout distinction, and response headers. |
| **Truncation is one-dimensional** | Support configurable truncation strategies: field removal, pagination hints, summaries, binary omission, or consumer-defined reducers. |
| **Spec loading has little control** | Allow custom fetchers, load timeouts, cancellation, integrity checks, ETags, redirects policy, and better source-load diagnostics. |

The largest architectural gap was the absence of a **consumer extension pipeline**:

```ts
new MultiSpecParser({
  transforms: {
    operation: ...,
    schema: ...,
    request: ...,
    response: ...,
  },
  transport: ...,
  auth: ...,
});
```

The existing `filterOps`, `extraParameters`, `processors`, and `onUnauthorized` hooks are useful, but they address isolated needs rather than providing a consistent extensibility model.

## Name-Keyed Processors Do Not Scale

The library passes useful per-invocation context to processors:

```ts
(result, { args, tool }) => ExecuteResult
```

The `tool` metadata allows a processor to inspect the operation's generated name, HTTP method, path, tags, scopes, and other operation data. However, processor registration is keyed only by generated tool name:

```ts
processors: {
  generated_tool_name: processor,
}
```

This creates an unnecessary coupling between consumer behavior and the parser's naming output. A consumer that wants the same behavior for several related operations must enumerate every generated name. That list can become stale when operation IDs change, when names are deduplicated, or when a new endpoint is added. It also prevents consumers from naturally applying behavior by stable properties such as HTTP method, path pattern, tags, response type, or vendor metadata.

The library should retain the name-keyed map for compatibility but also support global and predicate-based processors, for example:

```ts
processors: [
  {
    matches: (tool) => tool.operation.tags?.includes("attachments") === true,
    process: uploadToStorage,
  },
]
```

A complete model could support a global processor, ordered matching rules, and explicit per-tool overrides. Matching should receive the same `tool` metadata already available inside the processor, so consumers can select operations without guessing or maintaining generated tool-name lists. The library should also document processor ordering and whether multiple matching processors compose or replace one another.
