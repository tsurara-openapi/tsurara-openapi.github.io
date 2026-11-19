---
title: "React 与 TanStack Query"
sourcePath: docs/guide/react.md
sourceHash: 09418daf7502
---

本页逐步讲解 [`examples/react-tanstack`](https://github.com/tsurara-openapi/tsurara/tree/170cabec56cf573944620f7d2ef05eb2b845d2bb/examples/react-tanstack)：一个基于卡片 API 的小型 Next.js 应用（App Router），包含按页读取的搜索列表、详情页、编辑表单、两个租户、使用 MSW 的测试以及服务端渲染。所有与 API 通信的部分都是生成的代码和 `@tsurara/client`；应用本身没有编写任何查询键、`queryFn` 或类型断言。

## 开始 {#start}

```sh
tsurara init --preset react-query   # 写入 tsurara.config.yaml，并打印需要安装的包
npm install @tsurara/client @tanstack/react-query zod
npm install --save-dev msw
tsurara generate
```

该预设会启用查询选项（`query: tanstack`）、Zod 响应 schema（`validators: zod`）和 MSW 处理器（`mocks: msw`），并使用不带扩展名的导入，Vite 和 Next.js 都能解析（Turbopack 不会把 `.js` 导入映射到 `.ts` 文件）。所有的键见[配置](../configuration/)。

## 客户端与 QueryClient {#the-client-and-the-queryclient}

`src/api.ts` 为每个会话创建一个客户端：会话的令牌放在 `auth` 中，租户作为 `queryScope`，它位于该客户端所有查询键的最前面（[作用域](../client/#scopes-tenants-several-apis-logout)）。`QueryClient` 使用 `queryRetry()` 重试，并报告定义中未声明的状态码（[错误与重试](../client/#errors-and-retries)）：

```ts
export const createApi = (session: Session): Client =>
  createClient({ baseUrl, queryScope: { tenant: session.tenant }, auth: () => session.token });

export const makeQueryClient = (report = …): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: queryRetry(), staleTime: 30_000 } },
    queryCache: new QueryCache({ onError: (e) => { if (e instanceof ApiError && e.result.kind === 'http' && !e.result.documented) report(e); } }),
  });
```

`src/query-client.ts` 遵循 TanStack 关于服务端渲染的建议：在服务端为每个请求创建新的 `QueryClient`，使请求之间、租户之间永远不共享缓存；在浏览器中，页面存续期间只使用一个。

## 列表：搜索与无限滚动 {#the-list-search-and-infinite-scrolling}

定义在操作上写明了分页方式 `x-tsurara-pagination: { param: query.cursor, next: /nextCursor }`，因此 `listCards` 会获得无限查询选项（[无限查询](../client/#infinite-queries)）。列表（`src/components/CardList.tsx`）只需一次调用，鼠标悬停在卡片上时会预取其详情：

```tsx
const cards = useInfiniteQuery(listCardsInfiniteQueryOptions(api, search === '' ? {} : { query: { q: search } }));
// …
onMouseEnter={() => void queryClient.prefetchQuery(getCardQueryOptions(api, { path: { cardId: card.id } }))}
```

错误根据 Result 中的信息分支处理：已登出的会话用 `isHttpError(cards.error.result, 401)`，重试按钮用 `cards.error?.kind === 'network'`。

## 编辑：乐观更新、422 与缓存 {#editing-optimistic-updates-422-and-the-cache}

`src/cards.ts` 展开生成的 mutation 选项，并加入应用自己的缓存策略：修改立即显示，被拒绝的修改会回滚，成功后替换该卡片的缓存条目并重新获取该租户的所有列表：

```ts
export const updateCardOptions = (api: Client, queryClient: QueryClient, scope: QueryScope) => ({
  ...updateCardMutationOptions(api),
  onMutate: async (input: UpdateCardData) => {
    const key = getCardQueryKey({ path: input.path }, scope);
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData(key); // Card | undefined
    if (previous) queryClient.setQueryData(key, { ...previous, ...input.body });
    return { previous };
  },
  onError: (_e, input, context) => { if (context?.previous) queryClient.setQueryData(…, context.previous); },
  onSuccess: async (card: Card) => {
    queryClient.setQueryData(getCardQueryKey({ path: { cardId: card.id } }, scope), card);
    await queryClient.invalidateQueries(listCardsQueryFilter(scope));
  },
});

// 定义中声明的 422 响应体，带类型：
export const fieldErrors = (error: ApiError<UpdateCardResult> | null) =>
  error && isHttpError(error.result, 422) ? error.result.error.fields : undefined;
```

## 租户 {#tenants}

`src/session.tsx` 切换租户时，先用 `queryClient.removeQueries(queryScopeFilter(scope))` 丢弃上一个租户缓存的内容，再为下一个会话创建客户端。其他租户的条目会保留。

## 服务端渲染 {#server-rendering}

页面（`app/page.tsx`、`app/cards/[cardId]/page.tsx`）在服务端用相同的选项预取数据，并把缓存交给浏览器：

```tsx
export default async function Home() {
  return (
    <HydrationBoundary state={await prefetchCardList(await requestSession())}>
      <CardList />
    </HydrationBoundary>
  );
}
```

键中只包含 JSON 值，因此在服务端 `dehydrate` 之后，在浏览器中的哈希值保持一致。页面是动态的（`export const dynamic = 'force-dynamic'`），因为显示的内容取决于登录的用户。

## 测试 {#tests}

`test/` 使用 Vitest 和 MSW 运行，使用生成的处理器（`listCardsHandler`、`getCardHandler`、`updateCardHandler`），并为每个测试指定响应：

- `cards.test.ts`：按顺序读取各页以及列表的末尾；乐观更新被服务器接收并保留；422 时的回滚以及带类型的字段错误；编辑后重新获取列表；租户之间相互隔离；以及重试次数（503 共三次，定义中声明的 404 一次）。
- `components.test.tsx`（happy-dom）：列表按需加载下一页；被拒绝的编辑会显示字段错误，标题会回滚。
- `ssr.test.tsx`：服务端为每个请求创建一个 `QueryClient`；两个针对不同租户的并发渲染各自只包含自己的卡片。

MSW 3 中，没有处理器的请求所对应的选项名为 `onUnhandledFrame`（`server.listen({ onUnhandledFrame: 'error' })`）。在类浏览器的测试环境中，请为页面设置 API 的源（`environmentOptions.happyDOM.url`），否则带 `Authorization` 请求头的请求之前会先发出一个 CORS 预检请求，而没有处理器会响应它。
