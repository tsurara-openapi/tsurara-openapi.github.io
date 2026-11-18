---
title: "客户端"
sourcePath: docs/guide/client.md
sourceHash: ae5607fe4635
---

生成的函数以客户端作为第一个参数。本页介绍 TypeScript 的 `@tsurara/client`；Python 运行时 `tsurara-client` 采用相同的模型（[其 README](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/runtimes/python/README.md)）。

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

## Result {#results}

调用永远不会 reject，而是返回一个 Result：

| `kind` | `ok` | 何时 |
|---|---|---|
| `success` | `true` | 定义中的成功状态码；`data` 具有对应的类型 |
| `http` | `false` | 错误状态码，或定义中未声明的状态码（`documented: false`、`error: unknown`） |
| `network` | `false` | `fetch` 失败（DNS、连接、CORS） |
| `timeout` | `false` | 超过了 `timeout` |
| `aborted` | `false` | 调用方的 `signal` 中止了请求 |
| `parse` | `false` | 响应体与定义不符（Content-Type、JSON） |
| `unexpected` | `false` | 用户代码（中间件、钩子）抛出了异常，或输入无法发送 |

```ts
const r = await getPet(api, { path: { petId: 1 } });
if (r.ok) render(r.data);
else if (isHttpError(r, 404)) showNotFound(r.error); // 定义中声明的 404 响应体
else report(r);
```

只检查 `r.status === 404` 并不能收窄 `r.error` 的类型，因为未声明状态码的成员带有 `status: number`；`isHttpError` 还会检查 `documented`。

在更适合使用异常的地方，`unwrap(r)` 会返回 `data` 或抛出 `ApiError`（带有 `kind`、`status`、`operationId` 和 `result`）。`ApiError<GetPetResult>` 会按操作为 `result` 提供类型，例如可用作 TanStack Query 的 `TError`。

## 中间件 {#middleware}

形式为 `(req, next) => Promise<Response>`，最外层的排在最前面。`req.operation` 包含操作的 `id`、`method`、路径模板和 `tags`，可用于追踪和日志。`retry()` 对幂等方法重试网络失败以及 408、429、500、502、503、504，并遵循 `Retry-After`。

## 认证 {#authentication}

操作带有自己的安全要求。`auth(scheme, info)` 返回某个方案的凭据；客户端按方案的规定放置它（API key 放在 header、query 或 cookie 中，bearer 和 OAuth 令牌放在 `Authorization: Bearer` 中，`user:password` 放在 `Authorization: Basic` 中）。生成的 `SecuritySchemeName` 列出了这些名称。

只在请求的源（origin）内跟随重定向。不会跟随到其他源的重定向：调用会把它作为带 3xx 状态码的 `http` 失败返回，这样 API key 和其他请求头永远不会发送到其他主机。在浏览器中，`fetch` 自己跟随重定向（它会隐藏重定向的目标），并遵循浏览器的 CORS 规则。

## 每个应用一个客户端与绑定 {#per-app-clients-and-binding}

每个应用创建一个客户端（在服务端，每个请求用它自己的 `context` 创建一个）；客户端的创建成本很低。`bindClient(api, { getPet, listPets })` 返回绑定了客户端的函数：`api.getPet({ path: { petId: 1 } })`。

## 校验 {#validation}

除非你要求，否则不会校验响应。设置 `typescript.validators: zod` 后，tsurara 还会生成 Zod 4 schema，客户端用它们校验 JSON 响应体：

```ts
import { createClient, validateResponses } from '@tsurara/client';
import { responseSchemas } from './generated/zod/operations.ts';

const api = createClient({ baseUrl, validate: validateResponses(responseSchemas) });
const r = await getPet(api, { path: { petId: 1 } });
if (r.kind === 'validation') console.error(r.issues, r.value);
```

客户端不依赖任何校验库：`validate` 接受任意函数，`validateResponses` 接受任意 [Standard Schema](https://standardschema.dev) schema（Zod、Valibot、ArkType 或你自己的实现）。`validate: false` 可以对单次调用关闭校验。这些 schema 检查类型以及 `uuid`、`email` 和 `date-time` 格式，不检查字符串和数字约束。

## Server-Sent Events {#server-sent-events}

当 `text/event-stream` 响应的媒体类型用 `itemSchema`（OpenAPI 3.2）或 `x-itemSchema`（同样的 schema 以扩展形式写出，用于 3.0 和 3.1 文档）描述事件时，该响应就有类型：

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

此时结果的数据是 `StreamEvent`（`{ event: 'note'; data: Note; id?: string } | { event: 'closing'; data: string; id?: string }`）的异步可迭代对象，客户端已经解析好了 JSON：

```ts
const result = await api.stream({ signal });
if (result.ok) {
  for await (const e of result.data) {
    if (e.event === 'note') show(e.data); // Note
  }
}
```

- 流只能读取一次。退出循环会关闭连接；中止 `signal` 也会关闭连接，并使循环抛出中止的原因。客户端的 `timeout` 在响应开始时结束，因此不会切断流。
- 事件的解析方式与浏览器相同：跳过注释，没有 `data` 的事件不会交给你。`id` 和 `retry` 是事件本身的值；重新连接（如果服务器支持，可带上 `Last-Event-ID`）需要你自己处理。
- 事件中的 JSON 无效时，循环会抛出异常。定义中未列出的事件到达时，`data` 是字符串。
- 没有条目 schema 时，数据是 `ReadableStream<Uint8Array>`；`@tsurara/client` 中的 `parseEventStream(result.data)` 会把它读作 `{ event, data, id?, retry? }`，其中 `data` 为字符串。

## JSON Lines {#json-lines}

带有 `itemSchema`（OpenAPI 3.2）或 `x-itemSchema` 的 `application/jsonl`（或 `application/x-ndjson`、`application/json-seq`）响应，是条目类型 `{Operation}Item` 的异步可迭代对象，逐条解析：

```ts
const result = await api.exportItems();
if (result.ok) {
  for await (const item of result.data) save(item); // ExportItemsItem
}
```

与事件一样，流只能读取一次，退出循环会关闭连接，不是有效 JSON 的条目会使循环抛出异常。

## 事件 channel {#event-channels}

服务器在任何操作之外推送的消息（例如 Mercure hub 的更新），用定义中的 `x-event-channels` 描述。每个 channel 都会生成 `channels/{name}.ts`，其中包含消息类型、主题构建函数和解码器：

```ts
import { validateChannels } from '@tsurara/client';
import { boardTopic, decodeBoard } from './generated/channels/board.ts';
import { channelSchemas } from './generated/zod/channels.ts'; // 需要 `typescript.validators: zod`

const url = new URL(hubUrl);
url.searchParams.append('topic', topicPrefix + boardTopic({ boardId }));
const source = new EventSource(url, { withCredentials: true });
const validate = validateChannels(channelSchemas); // 可选
source.onmessage = (e) => {
  const r = decodeBoard(e.data, { validate });
  if (!r.ok) return resync(); // r.kind 为 'parse' 或 'validation'
  switch (r.value.type) {
    case 'card.added':
      addCard(r.value.card);
      break;
    // ...
  }
};
```

事件的种类是 JSON 载荷中的一个属性，因此消息无需具名 SSE 事件即可到达 `onmessage`。

## TanStack Query {#tanstack-query}

设置 `typescript.query: tanstack`（[配置](../configuration/)）后，每个操作都会在 `query/` 下获得 TanStack Query 5 的选项。读取操作获得查询键工厂函数和查询选项；其他操作获得 mutation 选项。它们会调用 `unwrap`，因此失败会以 `ApiError<{P}Result>` 抛出。

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
    qc.setQueryData(key, (old) => old && applyMove(old, input)); // `old` 为 Board | undefined
  },
});
qc.invalidateQueries(getBoardQueryFilter()); // 所有 getBoard 查询
```

键为 `[operationId, data]`（对于带有 `queryScope` 的客户端，前面还有 `{ scope }`，见下文），因此可以在任何地方用生成的 `…QueryKey` 函数构建键，例如在 Server-Sent Event 更新缓存时。工厂函数基于 `@tanstack/query-core` 定义类型，因此也适用于 Vue、Solid 和 Svelte 的适配器。

这些选项是普通对象；展开后可以加入 TanStack 自身的选项，类型会像手写选项一样随之推导：

```ts
import { skipToken, useQueries, useQuery } from '@tanstack/react-query';

const name = useQuery({ ...getBoardQueryOptions(api, { path: { boardId } }), select: (b) => b.name }); // string | undefined
const seeded = useQuery({ ...getBoardQueryOptions(api, { path: { boardId } }), initialData: board }); // Board
const later = useQuery(getBoardQueryOptions(api, boardId === undefined ? skipToken : { path: { boardId } }));
const many = useQueries({ queries: ids.map((boardId) => getBoardQueryOptions(api, { path: { boardId } })) });
// 在路由 loader 中：使用同样的选项，数据类型为 Board。
const loaded = await queryClient.ensureQueryData(getBoardQueryOptions(api, { path: { boardId } }));
```

在 `useMutation({ ...moveCardMutationOptions(api), onMutate, onError })` 中，`onMutate` 返回的值就是 `onError` 中带类型的 `context`，可用于回滚乐观更新。

### 无限查询 {#infinite-queries}

OpenAPI 没有说明列表如何分页，所以需要你写下来：写在定义中的操作上，或写在配置中（配置优先）：

```yaml
# 写在定义中的操作上：
x-tsurara-pagination: { param: query.cursor, next: /nextCursor }
# 或写在 tsurara.config.yaml 中：
typescript:
  query: tanstack
  infiniteQueries:
    listOrders: { param: query.page, initial: 1, next: /meta/next, previous: /meta/prev }
```

这样读取操作还会获得无限查询选项，其键永远不会与普通查询的键相同：

```ts
const pets = useInfiniteQuery(listPetsInfiniteQueryOptions(api, { query: { limit: 20 } }));
pets.data?.pages.flatMap((page) => page.items); // 带类型的页
void pets.fetchNextPage(); // 发送 cursor = 上一页的 nextCursor；它不存在或为 null 时停止

// 分页设置中没有 `next` 时，需指定下一页的位置：
useInfiniteQuery({
  ...listEventsInfiniteQueryOptions(api),
  getNextPageParam: (last, pages) => (last.length === 0 ? undefined : pages.length * 50),
});
```

`invalidateQueries(listPetsQueryFilter())` 也会匹配无限查询。

### 作用域：租户、多个 API、登出 {#scopes-tenants-several-apis-logout}

键中不包含 base URL 和凭据。当不同租户或服务器的客户端共享同一个 `QueryClient` 时，为每个客户端设置 `queryScope`，它是一个说明谁可以共享结果的 JSON 值（绝不能是令牌）。它位于生成选项的键的最前面：

```ts
import { createClient, queryScopeFilter } from '@tsurara/client';

const scope = { tenant: tenantId };
const api = createClient({ baseUrl, queryScope: scope });

const update = useMutation({
  ...updateCardMutationOptions(api),
  onSuccess: async (card) => {
    qc.setQueryData(getCardQueryKey({ path: { cardId: card.id } }, scope), card);
    await qc.invalidateQueries(listCardsQueryFilter(scope)); // 该租户的所有 listCards 查询
  },
});

// 登出或切换租户：丢弃该作用域缓存的所有内容。
qc.removeQueries(queryScopeFilter(scope));
```

键工厂函数和过滤器把作用域作为最后一个参数（对于没有作用域的客户端则省略）。要更新某个操作的所有已缓存查询，请使用生成的 `set{Function}QueriesData(queryClient, updater, scope?)`，它为 updater 提供类型（TanStack 的 `setQueriesData` 无法从过滤器推断数据类型），并且不会改动该操作的无限查询；`get{Function}QueriesData` 用于读取它们：

```ts
setGetCardQueriesData(queryClient, (old) => old && { ...old, done: true }, scope); // old: Card | undefined
```

### 错误与重试 {#errors-and-retries}

这些选项抛出的 `ApiError<{P}Result>` 保留了完整的 Result，因此组件可以用与调用相同的辅助函数区分失败：

```ts
import { ApiError, isHttpError, queryRetry } from '@tsurara/client';
import { QueryCache, QueryClient } from '@tanstack/react-query';

const update = useMutation(updateCardMutationOptions(api));
if (update.error && isHttpError(update.error.result, 422)) {
  showFieldErrors(update.error.result.error.fields); // 定义中声明的 422 响应体
}
const card = useQuery(getCardQueryOptions(api, { path: { cardId } }));
if (card.error && isHttpError(card.error.result, 401)) signIn();
if (card.error?.kind === 'network') offerRetry();

export const queryClient = new QueryClient({
  // 与 retry() 中间件相同的重试条件：网络失败以及 408、429、500、502、503、504，最多两次。
  defaultOptions: { queries: { retry: queryRetry() } },
  // 定义中未声明的状态码说明服务器与定义之间存在偏差。
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof ApiError && e.result.kind === 'http' && !e.result.documented) report(e);
    },
  }),
});
```

只在一个地方重试。TanStack Query 默认会将失败的查询重试三次，包括定义中声明的 4xx 错误，而 `retry()` 中间件会在每次尝试内部重试，因此同时使用 TanStack 的默认设置和该中间件时，一个持续失败的服务器最多会被调用 3 × 4 次。`queryRetry()` 不会重试中间件已经重试过的失败，因此同时使用 `queryRetry()` 和 `retry()` 时，请求的发送次数不会超过中间件允许的次数；即便如此，也请只配置其中一个。对于通过 TanStack Query 读取数据的应用，请把 `queryRetry()` 用作它的 `retry`，并且不要在客户端中加入 `retry()`：这样 TanStack 能掌握每次尝试（`failureCount`、离线时暂停），而无法自行好转的错误（404、422、无法解析或校验的响应体）会立即失败。`retry()` 留给不经过 TanStack Query 的调用，并在使用这种客户端的查询中设置 `retry: false`。TanStack 默认不重试 mutation，而 `retry()` 只重试幂等方法。被取消的查询（组件卸载、`cancelQueries`）以取消结束，而不是以错误结束。

## 单次调用的选项 {#per-call-options}

`signal`、`headers`、`timeout`、`baseUrl`、`context`、`validate` 和 `contentType`（用于有多种请求媒体类型的操作）可以按调用指定。

## 内置运行时 {#a-vendored-runtime}

生成的代码需要其语言的运行时包。在无法添加依赖的场合（严格的依赖策略、离线构建、把依赖作为资源打包的引擎），`runtime: vendor` 会改为把运行时的副本写入输出目录：

```yaml
input: openapi.yaml
output: src/api
runtime: vendor
```

| 语言 | 副本 | 说明 |
|---|---|---|
| TypeScript | `_runtime/` | 生成的文件以相对路径导入它；从 `./api/_runtime/index.js` 导入 `createClient` |
| Python | `_runtime/` | `from api._runtime import Client`。请把 httpx 加入你的依赖 |
| Rust | `runtime/` | 将 `rust.runtimeCrate` 设为该模块的路径（`crate::api::runtime`），并添加 `mod.rs` 中列出的 crate（serde、serde_json、indexmap；有操作时还需要 tokio、fastrand、httpdate 和 reqwest） |
| Go | `internal/tsurara/` | 导入路径来自你的 `go.mod` |

副本会与代码一起重新生成：它带有生成文件标记，`tsurara check` 会报告对它的修改，并且它始终与生成器的版本一致（不存在需要检查的运行时版本）。`generate` 会打印需要添加的第三方依赖。

能用包时请优先使用包：包可以被多个目标共享并单独更新，而每个使用 `runtime: vendor` 的目标都会有自己的副本。在 `operations: false` 时，Rust 只复制类型层，TypeScript 什么都不复制（其类型不导入运行时）。
