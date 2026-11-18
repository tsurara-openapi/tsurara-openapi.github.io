---
title: "ReactとTanStack Query"
sourcePath: docs/guide/react.md
sourceHash: 7b89cc19a5fb
---

[`examples/react-tanstack`](https://github.com/tsurara-openapi/tsurara/tree/c5cc557cdb42c8f28966541163492b2cf79bd296/examples/react-tanstack)を順に見ていきます。カードのAPIを使う小さなNext.jsのアプリ（App Router）で、ページ単位で読み込む検索結果の一覧、詳細ページ、編集フォーム、2つのテナント、MSWを使うテスト、サーバーレンダリングがあります。APIとやりとりする部分はすべて生成コードと `@tsurara/client` で、アプリはクエリキーも `queryFn` も型アサーションも書いていません。

## 始める {#start}

```sh
tsurara init --preset react-query   # tsurara.config.yaml を書き込み、インストールすべきパッケージを表示する
npm install @tsurara/client @tanstack/react-query zod
npm install --save-dev msw
tsurara generate
```

このプリセットは、クエリオプション（`query: tanstack`）、Zodのレスポンススキーマ（`validators: zod`）、MSWのハンドラー（`mocks: msw`）を有効にし、importを拡張子なしにします。拡張子なしのimportはViteとNext.jsが解決できます（Turbopackは `.js` のimportを `.ts` ファイルに対応づけません）。すべてのキーは[設定](../configuration/)にあります。

## クライアントとQueryClient {#the-client-and-the-queryclient}

`src/api.ts` はセッションごとにクライアントを作ります。セッションのトークンを `auth` に、テナントを `queryScope` に渡します。`queryScope` は、そのクライアントのすべてのクエリキーの先頭に入ります（[スコープ](../client/#scopes-tenants-several-apis-logout)）。`QueryClient` は `queryRetry()` でリトライし、定義にないステータスを報告します（[エラーとリトライ](../client/#errors-and-retries)）。

```ts
export const createApi = (session: Session): Client =>
  createClient({ baseUrl, queryScope: { tenant: session.tenant }, auth: () => session.token });

export const makeQueryClient = (report = …): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: queryRetry(), staleTime: 30_000 } },
    queryCache: new QueryCache({ onError: (e) => { if (e instanceof ApiError && e.result.kind === 'http' && !e.result.documented) report(e); } }),
  });
```

`src/query-client.ts` は、サーバーレンダリングについてのTanStackの推奨に従っています。サーバーではリクエストごとに新しい `QueryClient` を作り、リクエストやテナントの間でキャッシュを共有しません。ブラウザではページが開いている間、1つの `QueryClient` を使います。

## 一覧：検索と無限スクロール {#the-list-search-and-infinite-scrolling}

定義の操作にページングの方法 `x-tsurara-pagination: { param: query.cursor, next: /nextCursor }` が書かれているので、`listCards` には無限クエリのオプションが付きます（[無限クエリ](../client/#infinite-queries)）。一覧（`src/components/CardList.tsx`）は1回の呼び出しで書け、カードにマウスを乗せると詳細を先読みします。

```tsx
const cards = useInfiniteQuery(listCardsInfiniteQueryOptions(api, search === '' ? {} : { query: { q: search } }));
// …
onMouseEnter={() => void queryClient.prefetchQuery(getCardQueryOptions(api, { path: { cardId: card.id } }))}
```

エラーはResultの情報で分岐します。サインアウトしたセッションには `isHttpError(cards.error.result, 401)` を、リトライボタンには `cards.error?.kind === 'network'` を使います。

## 編集：楽観的更新、422、キャッシュ {#editing-optimistic-updates-422-and-the-cache}

`src/cards.ts` は生成されたミューテーションのオプションを展開し、アプリのキャッシュの方針を足しています。変更はすぐに表示し、拒否された変更は巻き戻し、成功したらそのカードのエントリを置き換えてテナントのすべての一覧を再取得します。

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

// 定義にある422の本文。型が付いている
export const fieldErrors = (error: ApiError<UpdateCardResult> | null) =>
  error && isHttpError(error.result, 422) ? error.result.error.fields : undefined;
```

## テナント {#tenants}

`src/session.tsx` は、前のテナントがキャッシュしたものを `queryClient.removeQueries(queryScopeFilter(scope))` で捨ててから、次のセッションのクライアントを作ってテナントを切り替えます。ほかのテナントのエントリは残ります。

## サーバーレンダリング {#server-rendering}

ページ（`app/page.tsx`、`app/cards/[cardId]/page.tsx`）は、同じオプションでサーバー側で先読みし、キャッシュをブラウザに渡します。

```tsx
export default async function Home() {
  return (
    <HydrationBoundary state={await prefetchCardList(await requestSession())}>
      <CardList />
    </HydrationBoundary>
  );
}
```

キーにはJSONの値しか入らないので、サーバーで `dehydrate` したあとも、ブラウザで同じハッシュになります。表示内容がサインインしているユーザーで変わるので、ページは動的です（`export const dynamic = 'force-dynamic'`）。

## テスト {#tests}

`test/` はVitestとMSWで動き、生成されたハンドラー（`listCardsHandler`、`getCardHandler`、`updateCardHandler`）にテストごとのレスポンスを与えて使います。

- `cards.test.ts`：ページを順に読み、一覧の終わりで止まること。楽観的更新がサーバーに届き、そのまま残ること。422での巻き戻しと型付きの項目エラー。編集後に一覧が再取得されること。テナントが分離されていること。リトライの回数（503は合計3回、定義にある404は1回）。
- `components.test.tsx`（happy-dom）：一覧が求めに応じて次のページを読み込むこと。拒否された編集で項目のエラーが表示され、タイトルが元に戻ること。
- `ssr.test.tsx`：サーバーがリクエストごとに `QueryClient` を作ること。異なるテナントの2つのレンダリングを同時に行っても、それぞれに自分のカードしか含まれないこと。

MSW 3では、ハンドラーのないリクエストについてのオプション名は `onUnhandledFrame` です（`server.listen({ onUnhandledFrame: 'error' })`）。ブラウザに似たテスト環境では、ページにAPIのオリジンを設定してください（`environmentOptions.happyDOM.url`）。そうしないと、`Authorization` ヘッダーを付けたリクエストの前にCORSのプリフライトが送られ、それに応答するハンドラーがありません。
