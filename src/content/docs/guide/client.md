---
title: "The client"
sourcePath: docs/guide/client.md
sourceHash: ef7e6a11dc65
---

Generated functions take a client as their first argument. `@tsurara/client` (TypeScript) is described here; the Python runtime `tsurara-client` has the same model ([its README](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/runtimes/python/README.md)).

```ts
import { createClient, retry } from '@tsurara/client';

export const api = createClient<{ requestId?: string }>({
  baseUrl: 'https://api.example.com',
  headers: async (info) => ({ 'x-request-id': info.context?.requestId }),
  auth: (scheme) => (scheme.scheme === 'bearerAuth' ? getToken() : undefined),
  middleware: [retry()],
  timeout: 10_000,
  onResult: (result, info) => metrics.count(info.operation.id, result.kind),
  onUndocumentedStatus: (info) => console.warn('undocumented status', info.operation.id, info.status),
});
```

## Results

A call never rejects. It returns a Result:

| `kind` | `ok` | When |
|---|---|---|
| `success` | `true` | A success status of the definition; `data` has its type |
| `http` | `false` | An error status, or a status the definition does not document (`documented: false`, `error: unknown`) |
| `network` | `false` | `fetch` failed (DNS, connection, CORS) |
| `timeout` | `false` | `timeout` passed |
| `aborted` | `false` | The caller's `signal` aborted |
| `parse` | `false` | The body does not match the definition (Content-Type, JSON) |
| `unexpected` | `false` | User code (middleware, hooks) threw, or the input cannot be sent |

```ts
const r = await getPet(api, { path: { petId: 1 } });
if (r.ok) render(r.data);
else if (isHttpError(r, 404)) showNotFound(r.error); // the documented 404 body
else report(r);
```

Checking only `r.status === 404` does not narrow `r.error`, because the member for undocumented statuses has `status: number`; `isHttpError` also checks `documented`.

Where exceptions are easier, `unwrap(r)` returns `data` or throws `ApiError` (with `kind`, `status`, `operationId` and the `result`). `ApiError<GetPetResult>` types `result` by the operation, for example as `TError` in TanStack Query.

## Middleware

`(req, next) => Promise<Response>`, outermost first. `req.operation` has the operation's `id`, `method`, path template and `tags`, for traces and logs. `retry()` retries network failures and 408, 429, 500, 502, 503, 504 for idempotent methods, honoring `Retry-After`.

## Authentication

Operations carry their security requirements. `auth(scheme, info)` returns the credential for a scheme; the client places it as the scheme says (header, query or cookie for API keys, `Authorization: Bearer` for bearer and OAuth tokens, `Authorization: Basic` for `user:password`). The generated `SecuritySchemeName` lists the names.

Redirects are followed within the origin of the request only. A redirect to another origin is not followed: the call returns it as an `http` failure with the 3xx status, so that API keys and other headers never reach another host. In browsers, `fetch` follows redirects itself (it hides where a redirect goes), under the browser's CORS rules.

## Per-app clients and binding

Make one client per app (or per server request with its own `context`); clients are cheap. `bindClient(api, { getPet, listPets })` returns the functions with the client bound: `api.getPet({ path: { petId: 1 } })`.

## Validation

Responses are not validated unless you ask. With `typescript.validators: zod`, tsurara also generates Zod 4 schemas, and the client validates JSON bodies with them:

```ts
import { createClient, validateResponses } from '@tsurara/client';
import { responseSchemas } from './generated/zod/operations.ts';

const api = createClient({ baseUrl, validate: validateResponses(responseSchemas) });
const r = await getPet(api, { path: { petId: 1 } });
if (r.kind === 'validation') console.error(r.issues, r.value);
```

The client depends on no validation library: `validate` takes any function, and `validateResponses` any [Standard Schema](https://standardschema.dev) schemas (Zod, Valibot, ArkType, or your own). `validate: false` turns it off for one call. The schemas check types and the `uuid`, `email` and `date-time` formats, not string and number constraints.

## Server-Sent Events

A `text/event-stream` response is typed when its media type describes the events with `itemSchema` (OpenAPI 3.2) or `x-itemSchema` (the same schema as an extension, for 3.0 and 3.1 documents):

```yaml
content:
  text/event-stream:
    x-itemSchema:
      type: object
      required: [event, data]
      properties:
        event: { type: string }
        data: { type: string }
        id: { type: string }
      oneOf:
        - properties:
            event: { const: note }
            data:
              type: string
              contentMediaType: application/json
              contentSchema: { $ref: "#/components/schemas/Note" }
        - properties:
            event: { const: closing }
```

The data of the result is then an async iterable of `StreamEvent` (`{ event: 'note'; data: Note; id?: string } | { event: 'closing'; data: string; id?: string }`), and the client has already parsed the JSON:

```ts
const result = await api.stream({ signal });
if (result.ok) {
  for await (const e of result.data) {
    if (e.event === 'note') show(e.data); // Note
  }
}
```

- The stream can be read once. Leaving the loop closes the connection; so does aborting `signal`, which makes the loop throw the abort reason. The client's `timeout` ends when the response starts, so it does not cut a stream.
- Events are parsed as browsers do: comments are skipped and an event without `data` is not handed over. `id` and `retry` are those of the event itself; reconnecting, with `Last-Event-ID` if the server supports it, is up to you.
- Invalid JSON in an event throws from the loop. Events the definition does not list arrive with `data` as a string.
- Without an item schema the data is a `ReadableStream<Uint8Array>`; `parseEventStream(result.data)` from `@tsurara/client` reads it as `{ event, data, id?, retry? }` with `data` as a string.

## JSON Lines

An `application/jsonl` (or `application/x-ndjson`, `application/json-seq`) response with `itemSchema` (OpenAPI 3.2) or `x-itemSchema` is an async iterable of the item type, `{Operation}Item`, parsed item by item:

```ts
const result = await api.exportItems();
if (result.ok) {
  for await (const item of result.data) save(item); // ExportItemsItem
}
```

As with events, the stream can be read once, leaving the loop closes the connection, and an item that is not valid JSON throws from the loop.

## Event channels

Messages a server pushes outside any operation, such as Mercure hub updates, are described with `x-event-channels` in the definition. Each channel gets `channels/{name}.ts` with the message type, a topic builder and a decoder:

```ts
import { validateChannels } from '@tsurara/client';
import { boardTopic, decodeBoard } from './generated/channels/board.ts';
import { channelSchemas } from './generated/zod/channels.ts'; // with `typescript.validators: zod`

const url = new URL(hubUrl);
url.searchParams.append('topic', topicPrefix + boardTopic({ boardId }));
const source = new EventSource(url, { withCredentials: true });
const validate = validateChannels(channelSchemas); // optional
source.onmessage = (e) => {
  const r = decodeBoard(e.data, { validate });
  if (!r.ok) return resync(); // r.kind is 'parse' or 'validation'
  switch (r.value.type) {
    case 'card.added':
      addCard(r.value.card);
      break;
    // ...
  }
};
```

The event kind is a property of the JSON payload, so messages arrive on `onmessage` without named SSE events.

## TanStack Query

With `typescript.query: tanstack` ([configuration](../configuration/)), every operation gets options for TanStack Query 5 under `query/`. Reads get a query key factory and query options; other operations get mutation options. Calls `unwrap`, so failures are thrown as `ApiError<{P}Result>`.

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getBoardQueryFilter, getBoardQueryKey, getBoardQueryOptions } from './generated/query/getBoard.ts';
import { moveCardMutationOptions } from './generated/query/moveCard.ts';

const board = useQuery(getBoardQueryOptions(api, { path: { boardId } })); // board.data: Board | undefined
const qc = useQueryClient();
const move = useMutation({
  ...moveCardMutationOptions(api),
  onMutate: async (input) => {
    const key = getBoardQueryKey({ path: { boardId } });
    await qc.cancelQueries({ queryKey: key });
    qc.setQueryData(key, (old) => old && applyMove(old, input)); // `old` is Board | undefined
  },
});
qc.invalidateQueries(getBoardQueryFilter()); // every getBoard query
```

Keys are `[operationId, data]` (after `{ scope }` for a client with a `queryScope`, below), so they can be built anywhere with the generated `…QueryKey` function, for example when a server-sent event patches the cache. The factories are typed with `@tanstack/query-core`, so they also work with the Vue, Solid and Svelte adapters.

The options are plain objects; spread them to add TanStack's own options, and the types follow as with options written by hand:

```ts
import { skipToken, useQueries, useQuery } from '@tanstack/react-query';

const name = useQuery({ ...getBoardQueryOptions(api, { path: { boardId } }), select: (b) => b.name }); // string | undefined
const seeded = useQuery({ ...getBoardQueryOptions(api, { path: { boardId } }), initialData: board }); // Board
const later = useQuery(getBoardQueryOptions(api, boardId === undefined ? skipToken : { path: { boardId } }));
const many = useQueries({ queries: ids.map((boardId) => getBoardQueryOptions(api, { path: { boardId } })) });
// In a router loader: the same options, the data typed as Board.
const loaded = await queryClient.ensureQueryData(getBoardQueryOptions(api, { path: { boardId } }));
```

In `useMutation({ ...moveCardMutationOptions(api), onMutate, onError })`, the value `onMutate` returns is the typed `context` of `onError`, for rolling back an optimistic update.

### Infinite queries

OpenAPI does not say how a list is paginated, so write it down, on the operation in the definition or in the configuration (which wins):

```yaml
# In the definition, on the operation:
x-tsurara-pagination: { param: query.cursor, next: /nextCursor }
# Or in tsurara.config.yaml:
typescript:
  query: tanstack
  infiniteQueries:
    listOrders: { param: query.page, initial: 1, next: /meta/next, previous: /meta/prev }
```

The read then also gets infinite query options, whose key never equals the plain query's key:

```ts
const pets = useInfiniteQuery(listPetsInfiniteQueryOptions(api, { query: { limit: 20 } }));
pets.data?.pages.flatMap((page) => page.items); // typed pages
void pets.fetchNextPage(); // sends cursor = the previous page's nextCursor; stops when it is absent or null

// Without `next` in the pagination, say where the next page is:
useInfiniteQuery({
  ...listEventsInfiniteQueryOptions(api),
  getNextPageParam: (last, pages) => (last.length === 0 ? undefined : pages.length * 50),
});
```

`invalidateQueries(listPetsQueryFilter())` matches the infinite query too.

### Scopes: tenants, several APIs, logout

The key does not contain the base URL or the credentials. When clients for different tenants or servers share one `QueryClient`, give each a `queryScope`, a JSON value that says who may share results (never a token). It goes first in the keys of the generated options:

```ts
import { createClient, queryScopeFilter } from '@tsurara/client';

const scope = { tenant: tenantId };
const api = createClient({ baseUrl, queryScope: scope });

const update = useMutation({
  ...updateCardMutationOptions(api),
  onSuccess: async (card) => {
    qc.setQueryData(getCardQueryKey({ path: { cardId: card.id } }, scope), card);
    await qc.invalidateQueries(listCardsQueryFilter(scope)); // every listCards query of the tenant
  },
});

// Logout or a tenant switch: drop everything the scope cached.
qc.removeQueries(queryScopeFilter(scope));
```

Key factories and filters take the scope as their last argument (leave it out for a client without one). To patch every cached query of an operation, use the generated `set{Function}QueriesData(queryClient, updater, scope?)`, which types the updater (TanStack's `setQueriesData` does not infer the data from a filter) and leaves the operation's infinite queries alone; `get{Function}QueriesData` reads them:

```ts
setGetCardQueriesData(queryClient, (old) => old && { ...old, done: true }, scope); // old: Card | undefined
```

### Errors and retries

The options throw `ApiError<{P}Result>`, which keeps the whole Result, so a component can tell failures apart with the same helpers as a call:

```ts
import { ApiError, isHttpError, queryRetry } from '@tsurara/client';
import { QueryCache, QueryClient } from '@tanstack/react-query';

const update = useMutation(updateCardMutationOptions(api));
if (update.error && isHttpError(update.error.result, 422)) {
  showFieldErrors(update.error.result.error.fields); // the documented 422 body
}
const card = useQuery(getCardQueryOptions(api, { path: { cardId } }));
if (card.error && isHttpError(card.error.result, 401)) signIn();
if (card.error?.kind === 'network') offerRetry();

export const queryClient = new QueryClient({
  // Retry like the retry() middleware: network failures and 408, 429, 500, 502, 503, 504, twice.
  defaultOptions: { queries: { retry: queryRetry() } },
  // Statuses the definition does not document point at drift between server and definition.
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof ApiError && e.result.kind === 'http' && !e.result.documented) report(e);
    },
  }),
});
```

Retry in one place. TanStack Query retries a failed query three times by default, documented 4xx errors included, and the `retry()` middleware retries inside each attempt, so with TanStack's default and the middleware a failing server is called up to 3 × 4 times. `queryRetry()` does not retry a failure the middleware already retried, so with `queryRetry()` and `retry()` together a request is sent at most as often as the middleware allows; still, configure one. For apps that read through TanStack Query, use `queryRetry()` as its `retry` and leave `retry()` out of the client: TanStack then knows about each attempt (`failureCount`, pausing while offline), and errors that cannot get better on their own (404, 422, a body that does not parse or validate) fail at once. Keep `retry()` for calls made without TanStack Query, with `retry: false` in the queries that use such a client. Mutations are not retried by TanStack by default, and `retry()` only retries idempotent methods. A cancelled query (the component unmounted, `cancelQueries`) ends as cancelled, not with an error.

## Per-call options

`signal`, `headers`, `timeout`, `baseUrl`, `context`, `validate`, and `contentType` (for operations with several request media types) can be given per call.

## A vendored runtime

Generated code needs the runtime package of its language. Where adding one is not possible (a restricted dependency policy, offline builds, an engine that ships dependencies as assets), `runtime: vendor` writes a copy of the runtime into the output instead:

```yaml
input: openapi.yaml
output: src/api
runtime: vendor
```

| Language | The copy | Notes |
|---|---|---|
| TypeScript | `_runtime/` | Generated files import it relatively; import `createClient` from `./api/_runtime/index.js` |
| Python | `_runtime/` | `from api._runtime import Client`. Add httpx to your dependencies |
| Rust | `runtime/` | Set `rust.runtimeCrate` to the module's path (`crate::api::runtime`), and add the crates `mod.rs` lists (serde, serde_json, indexmap; with operations also tokio, fastrand, httpdate and reqwest) |
| Go | `internal/tsurara/` | The import path comes from your `go.mod` |

The copy is regenerated with the code: it carries the generated-file marker, `tsurara check` reports edits to it, and it always matches the generator's version (there is no runtime version to check). `generate` prints the third-party dependencies to add.

Prefer the package when you can: it is shared by several targets and updated on its own, while each target with `runtime: vendor` gets its own copy. With `operations: false`, Rust copies only the types layer, and TypeScript copies nothing (its types import no runtime).
