---
title: "クライアント"
sourcePath: docs/guide/client.md
sourceHash: 8df1bf09c92e
---

生成された関数は、第1引数にクライアントを受け取ります。このページではTypeScriptの `@tsurara/client` を説明します。Pythonのランタイム `tsurara-client` も同じ仕組みです（[そのREADME](https://github.com/tsurara-openapi/tsurara/blob/170cabec56cf573944620f7d2ef05eb2b845d2bb/runtimes/python/README.md)）。

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

呼び出しがrejectされることはありません。呼び出しはResultを返します。

| `kind` | `ok` | 条件 |
|---|---|---|
| `success` | `true` | 定義にある成功のステータス。`data` はその型を持ちます |
| `http` | `false` | エラーのステータス、または定義にないステータス（`documented: false`、`error: unknown`） |
| `network` | `false` | `fetch` が失敗した（DNS、接続、CORS）、または本文を読んでいる間に接続が失敗した |
| `timeout` | `false` | `timeout` を過ぎた |
| `aborted` | `false` | 呼び出し側の `signal` で中断された |
| `parse` | `false` | 本文が定義と合わない（Content-Type、JSON） |
| `unexpected` | `false` | 利用者のコード（ミドルウェア、フック）が例外を投げた、または入力を送信できない |

```ts
const r = await getPet(api, { path: { petId: 1 } });
if (r.ok) render(r.data);
else if (isHttpError(r, 404)) showNotFound(r.error); // 定義にある404の本文
else report(r);
```

`network`、`timeout`、`aborted` が本文の読み込みを終わらせたときは、Resultが `response` を持ち続けるので、ステータスとヘッダーはわかります（`r.response?.status`）。`response` がなければ、応答が届く前の失敗です。

テキストの本文（`text/*` など）は、Content-Typeの `charset` で読みます。`charset` がなければUTF-8です。プラットフォームの `TextDecoder` が知らない `charset` は `parse` の失敗になります。テキストのメディアタイプでもスキーマがバイナリ（`type: string, format: binary`）なら、届いたままのバイトを持つ `Blob` として読みます。

定義に内容がないエラーの応答は `error: undefined` になり、本文は捨てます。`typescript.bodilessResponses: read` にすると、Content-Type付きで届いた本文を（その型に応じてJSON、テキスト、`Blob` として）読み、`error` は `unknown` になります。定義が書き漏らしたメッセージを失わずに済みます。

`r.status === 404` だけを確かめても `r.error` の型は絞り込まれません。定義にないステータスのメンバーが `status: number` を持つからです。`isHttpError` は `documented` も確かめます。

例外のほうが扱いやすい場面では、`unwrap(r)` が `data` を返すか、`ApiError`（`kind`、`status`、`operationId`、`result` を持ちます）を投げます。`ApiError<GetPetResult>` は `result` を操作に応じて型付けするので、たとえばTanStack Queryの `TError` に使えます。

## ミドルウェア {#middleware}

`(req, next) => Promise<Response>` の形で、外側のものから順に並べます。`req.operation` には操作の `id`、`method`、パスのテンプレート、`tags` が入っていて、トレースやログに使えます。`retry()` は、べき等なメソッドについて、通信の失敗と408、429、500、502、503、504をリトライします。`Retry-After` に従います。

## 認証 {#authentication}

操作はセキュリティ要件を持っています。`auth(scheme, info)` はスキームに対応する認証情報を返し、クライアントはそれをスキームの指定どおりに置きます。APIキーならヘッダー、クエリ、Cookieのいずれか、BearerトークンとOAuthトークンなら `Authorization: Bearer`、`user:password` なら `Authorization: Basic` です。生成される `SecuritySchemeName` にスキームの名前が並びます。

リダイレクトは、リクエストと同じオリジンの中でだけたどります。別のオリジンへのリダイレクトはたどらず、3xxのステータスを持つ `http` の失敗として返します。これでAPIキーなどのヘッダーがほかのホストに届くことはありません。ブラウザでは `fetch` 自身がリダイレクトをたどり（行き先は隠されます）、ブラウザのCORSの規則に従います。

## アプリごとのクライアントとバインド {#per-app-clients-and-binding}

クライアントはアプリごとに1つ作ります（サーバーでは、独自の `context` を持つリクエストごとに作ります）。クライアントを作るコストは小さいです。`bindClient(api, { getPet, listPets })` は、クライアントを束縛した関数を返します：`api.getPet({ path: { petId: 1 } })`。

## 検証 {#validation}

指定しなければレスポンスは検証されません。`typescript.validators: zod` にすると、tsuraraはZod 4のスキーマも生成し、クライアントはそれでJSONの本文を検証します。

```ts
import { createClient, validateResponses } from '@tsurara/client';
import { responseSchemas } from './generated/zod/operations.ts';

const api = createClient({ baseUrl, validate: validateResponses(responseSchemas) });
const r = await getPet(api, { path: { petId: 1 } });
if (r.kind === 'validation') console.error(r.issues, r.value);
```

クライアントはどの検証ライブラリにも依存しません。`validate` には任意の関数を、`validateResponses` には任意の[Standard Schema](https://standardschema.dev)のスキーマ（Zod、Valibot、ArkType、自作のもの）を渡せます。`validate: false` にすると、その呼び出しだけ検証を止めます。スキーマが検査するのは型と、`uuid`、`email`、`date-time` のフォーマットです。文字列と数値の制約は検査しません。

## Server-Sent Events {#server-sent-events}

`text/event-stream` のレスポンスは、そのメディアタイプが `itemSchema`（OpenAPI 3.2）か `x-itemSchema`（3.0と3.1の文書向けに、同じスキーマを拡張として書いたもの）でイベントを記述していれば型が付きます。

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

このとき結果のデータは `StreamEvent`（`{ event: 'note'; data: Note; id?: string } | { event: 'closing'; data: string; id?: string }`）の非同期イテラブルになり、JSONはクライアントが解析済みです。

```ts
const result = await api.stream({ signal });
if (result.ok) {
  for await (const e of result.data) {
    if (e.event === 'note') show(e.data); // Note
  }
}
```

- ストリームは1回だけ読めます。ループを抜けると接続が閉じます。`signal` で中断しても閉じ、ループは中断の理由を投げます。クライアントの `timeout` はレスポンスが始まった時点で終わるので、ストリームを途中で切ることはありません。
- イベントはブラウザと同じ方法で解析されます。コメントは読み飛ばし、`data` のないイベントは渡しません。`id` と `retry` はそのイベント自身の値です。再接続（サーバーが対応していれば `Last-Event-ID` を付けて）は利用者が行います。
- イベントのJSONが不正なら、ループが例外を投げます。定義に挙がっていないイベントは、`data` が文字列のまま届きます。
- 項目のスキーマがなければ、データは `ReadableStream<Uint8Array>` です。`@tsurara/client` の `parseEventStream(result.data)` で、`data` が文字列の `{ event, data, id?, retry? }` として読めます。

## JSON Lines {#json-lines}

`itemSchema`（OpenAPI 3.2）か `x-itemSchema` のある `application/jsonl`（または `application/x-ndjson`、`application/json-seq`）のレスポンスは、項目の型 `{Operation}Item` の非同期イテラブルになり、項目ごとに解析されます。

```ts
const result = await api.exportItems();
if (result.ok) {
  for await (const item of result.data) save(item); // ExportItemsItem
}
```

イベントと同じく、ストリームは1回だけ読め、ループを抜けると接続が閉じ、JSONとして不正な項目があるとループが例外を投げます。

## イベントチャネル {#event-channels}

Mercureのハブの更新のように、サーバーがどの操作にも属さずに送るメッセージは、定義の `x-event-channels` に書きます。各チャネルには、メッセージの型、トピックを組み立てる関数、デコーダーを持つ `channels/{name}.ts` が生成されます。

```ts
import { validateChannels } from '@tsurara/client';
import { boardTopic, decodeBoard } from './generated/channels/board.ts';
import { channelSchemas } from './generated/zod/channels.ts'; // `typescript.validators: zod` のとき

const url = new URL(hubUrl);
url.searchParams.append('topic', topicPrefix + boardTopic({ boardId }));
const source = new EventSource(url, { withCredentials: true });
const validate = validateChannels(channelSchemas); // 省略可能
source.onmessage = (e) => {
  const r = decodeBoard(e.data, { validate });
  if (!r.ok) return resync(); // r.kind は 'parse' か 'validation'
  switch (r.value.type) {
    case 'card.added':
      addCard(r.value.card);
      break;
    // ...
  }
};
```

イベントの種類はJSONのペイロードのプロパティなので、メッセージは名前付きのSSEイベントを使わずに `onmessage` に届きます。

## TanStack Query {#tanstack-query}

`typescript.query: tanstack`（[設定](../configuration/)）にすると、すべての操作について、TanStack Query 5のオプションが `query/` に生成されます。読み取りの操作にはクエリキーのファクトリとクエリオプションが、それ以外の操作にはミューテーションのオプションが付きます。これらは `unwrap` を呼ぶので、失敗は `ApiError<{P}Result>` として投げられます。

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
    qc.setQueryData(key, (old) => old && applyMove(old, input)); // `old` は Board | undefined
  },
});
qc.invalidateQueries(getBoardQueryFilter()); // すべての getBoard クエリ
```

キーは `[operationId, data]` です（`queryScope` を持つクライアントでは先頭に `{ scope }` が付きます。後述）。生成される `…QueryKey` 関数を使えば、たとえばServer-Sent Eventでキャッシュを書き換えるときのように、どこでもキーを組み立てられます。ファクトリは `@tanstack/query-core` で型付けされているので、Vue、Solid、Svelteのアダプターでも使えます。

オプションはただのオブジェクトです。展開してTanStack自身のオプションを足せば、手で書いたオプションと同じように型が付きます。

```ts
import { skipToken, useQueries, useQuery } from '@tanstack/react-query';

const name = useQuery({ ...getBoardQueryOptions(api, { path: { boardId } }), select: (b) => b.name }); // string | undefined
const seeded = useQuery({ ...getBoardQueryOptions(api, { path: { boardId } }), initialData: board }); // Board
const later = useQuery(getBoardQueryOptions(api, boardId === undefined ? skipToken : { path: { boardId } }));
const many = useQueries({ queries: ids.map((boardId) => getBoardQueryOptions(api, { path: { boardId } })) });
// ルーターのローダーでも同じオプションを使え、データは Board として型付けされます。
const loaded = await queryClient.ensureQueryData(getBoardQueryOptions(api, { path: { boardId } }));
```

`useMutation({ ...moveCardMutationOptions(api), onMutate, onError })` では、`onMutate` が返した値が `onError` の型付きの `context` になります。楽観的更新を巻き戻すときに使います。

### 無限クエリ {#infinite-queries}

OpenAPIには一覧のページングの方法を書く場所がありません。定義の操作か設定に書いてください（設定が優先されます）。

```yaml
# 定義の操作に書く場合
x-tsurara-pagination: { param: query.cursor, next: /nextCursor }
# tsurara.config.yaml に書く場合
typescript:
  query: tanstack
  infiniteQueries:
    listOrders: { param: query.page, initial: 1, next: /meta/next, previous: /meta/prev }
```

すると読み取りの操作に無限クエリのオプションも付きます。そのキーは通常のクエリのキーと一致しません。

```ts
const pets = useInfiniteQuery(listPetsInfiniteQueryOptions(api, { query: { limit: 20 } }));
pets.data?.pages.flatMap((page) => page.items); // 型付きのページ
void pets.fetchNextPage(); // cursor に前のページの nextCursor を送る。それがないか null なら止まる

// ページングの設定に `next` がなければ、次のページの位置を指定する
useInfiniteQuery({
  ...listEventsInfiniteQueryOptions(api),
  getNextPageParam: (last, pages) => (last.length === 0 ? undefined : pages.length * 50),
});
```

`invalidateQueries(listPetsQueryFilter())` は無限クエリにも一致します。

### スコープ：テナント、複数のAPI、ログアウト {#scopes-tenants-several-apis-logout}

キーにはベースURLも認証情報も含まれません。テナントやサーバーの異なるクライアントが1つの `QueryClient` を共有するときは、それぞれに `queryScope` を与えます。これは結果を共有してよい範囲を表すJSONの値です（トークンを入れてはいけません）。生成されたオプションのキーでは、これが先頭に来ます。

```ts
import { createClient, queryScopeFilter } from '@tsurara/client';

const scope = { tenant: tenantId };
const api = createClient({ baseUrl, queryScope: scope });

const update = useMutation({
  ...updateCardMutationOptions(api),
  onSuccess: async (card) => {
    qc.setQueryData(getCardQueryKey({ path: { cardId: card.id } }, scope), card);
    await qc.invalidateQueries(listCardsQueryFilter(scope)); // そのテナントのすべての listCards クエリ
  },
});

// ログアウトやテナントの切り替え：そのスコープでキャッシュしたものをすべて捨てる
qc.removeQueries(queryScopeFilter(scope));
```

キーのファクトリとフィルターは、最後の引数にスコープを受け取ります（スコープのないクライアントなら省きます）。ある操作のキャッシュ済みクエリをすべて書き換えるには、生成される `set{Function}QueriesData(queryClient, updater, scope?)` を使います。これはupdaterに型を付け（TanStackの `setQueriesData` はフィルターからデータの型を推論しません）、その操作の無限クエリには触れません。読み出すには `get{Function}QueriesData` を使います。

```ts
setGetCardQueriesData(queryClient, (old) => old && { ...old, done: true }, scope); // old: Card | undefined
```

### エラーとリトライ {#errors-and-retries}

オプションが投げる `ApiError<{P}Result>` はResult全体を保持しているので、コンポーネントでも呼び出しと同じヘルパーで失敗を区別できます。

```ts
import { ApiError, isHttpError, queryRetry } from '@tsurara/client';
import { QueryCache, QueryClient } from '@tanstack/react-query';

const update = useMutation(updateCardMutationOptions(api));
if (update.error && isHttpError(update.error.result, 422)) {
  showFieldErrors(update.error.result.error.fields); // 定義にある422の本文
}
const card = useQuery(getCardQueryOptions(api, { path: { cardId } }));
if (card.error && isHttpError(card.error.result, 401)) signIn();
if (card.error?.kind === 'network') offerRetry();

export const queryClient = new QueryClient({
  // retry() ミドルウェアと同じ条件でリトライする：通信の失敗と408、429、500、502、503、504を2回まで
  defaultOptions: { queries: { retry: queryRetry() } },
  // 定義にないステータスは、サーバーと定義のずれを示している
  queryCache: new QueryCache({
    onError: (e) => {
      if (e instanceof ApiError && e.result.kind === 'http' && !e.result.documented) report(e);
    },
  }),
});
```

リトライは1か所で行ってください。TanStack Queryはデフォルトで、失敗したクエリを定義にある4xxのエラーも含めて3回リトライします。`retry()` ミドルウェアはその各試行の中でリトライするので、TanStackのデフォルトとミドルウェアを併用すると、失敗し続けるサーバーは最大3×4回呼ばれます。`queryRetry()` はミドルウェアがすでにリトライした失敗をリトライしないので、`queryRetry()` と `retry()` を併用すれば、リクエストの回数はミドルウェアが許す回数までに収まります。それでも、設定するのはどちらか一方にしてください。TanStack Queryを通して読み取るアプリでは、`queryRetry()` をその `retry` に使い、クライアントには `retry()` を入れないでください。するとTanStackが各試行を把握でき（`failureCount`、オフライン中の一時停止）、自然には直らないエラー（404、422、解析や検証に失敗した本文）はすぐに失敗します。`retry()` はTanStack Queryを使わない呼び出しのために残し、そのクライアントを使うクエリでは `retry: false` にします。ミューテーションはTanStackのデフォルトではリトライされず、`retry()` もべき等なメソッドしかリトライしません。キャンセルされたクエリ（コンポーネントのアンマウント、`cancelQueries`）は、エラーではなくキャンセルとして終わります。

## 呼び出しごとのオプション {#per-call-options}

`signal`、`headers`、`timeout`、`baseUrl`、`context`、`validate`、`fetchOptions`、`contentType`（リクエストのメディアタイプが複数ある操作向け）は、呼び出しごとに指定できます。

`fetchOptions` は `fetch` そのもののオプションで、`cache`、`credentials`、`keepalive`、Next.jsの `next` などです。クライアントにも指定でき、呼び出しのものがクライアントのものの上に重なります。メソッド、ヘッダー、本文、シグナル、リダイレクトの扱いはクライアントが決めます。ミドルウェアからは `req.fetchOptions` として見え、置き換えることもできます。

```ts
await getPet(api, {
  path: { petId: 1 },
  fetchOptions: { cache: 'force-cache', next: { revalidate: 60, tags: ['pet'] } },
});
```

## 生の応答 {#the-raw-response}

`api.requestRaw(def, data)` は、生成された関数と同じように（クライアントのヘッダー、認証、ミドルウェアを通して）呼び出しを送りますが、本文を読まないまま応答を返します。応答をそのまま流す場合（大きなダウンロード）や、定義に書かれていない方法で読む場合に使います。操作は生成された `{operation}Def` で指定します。

```ts
import { exportOrdersDef, type ExportOrdersData } from './api/operations/exportOrders.js';

const r = await api.requestRaw(exportOrdersDef, { query: { status: 'shipped' } } satisfies ExportOrdersData);
if (r.kind === 'response' && r.ok) return new Response(r.response.body, { headers: r.response.headers });
```

Resultは `{ kind: 'response', ok, status, documented, response }` か、トランスポートの失敗です。`ok` と `documented` は通常の呼び出しと同じように決まります。`timeout` は応答が届くまでの呼び出しに効き、`signal` は本文の読み込みも取り消せます。`onResult` と `onUndocumentedStatus` は呼ばれません。

## マルチパートとクエリの値 {#multipart-and-query-values}

マルチパートのパートは定義の `encoding` に従います。`encoding` にContent-Typeがないオブジェクトは、JSONのテキストを値とするフィールドとして送ります。Content-Typeがあれば、その型のパートとして送ります。`FormData` ではこれをファイル（ファイル名付き）としてしか送れません。値が `null` のクエリパラメーターと、`in: querystring` のオブジェクトのメンバーは、値がない場合と同じく送りません。

## ランタイムを同梱する {#a-vendored-runtime}

生成コードには、その言語のランタイムのパッケージが必要です。パッケージを追加できない場合（依存関係の方針が厳しい、オフラインでビルドする、依存関係をアセットとして同梱するエンジンを使うなど）は、`runtime: vendor` にすると、ランタイムのコピーを出力に書き込みます。

```yaml
input: openapi.yaml
output: src/api
runtime: vendor
```

| 言語 | コピー先 | 補足 |
|---|---|---|
| TypeScript | `_runtime/` | 生成ファイルは相対パスでimportします。`createClient` は `./api/_runtime/index.js` からimportします |
| Python | `_runtime/` | `from api._runtime import Client`。依存関係にhttpxを追加してください |
| Rust | `runtime/` | `rust.runtimeCrate` にモジュールのパス（`crate::api::runtime`）を指定し、`mod.rs` に挙がっているクレート（serde、serde_json、indexmap。操作があればtokio、fastrand、httpdate、encoding_rs、reqwestも）を追加してください |
| Go | `internal/tsurara/` | importパスは `go.mod` から決まります |

コピーはコードと一緒に再生成されます。生成ファイルの目印が付いていて、`tsurara check` はコピーへの編集を報告します。コピーは常に生成器のバージョンと一致します（確かめるべきランタイムのバージョンがありません）。`generate` は追加すべきサードパーティの依存関係を表示します。

できるならパッケージを使ってください。パッケージは複数のターゲットで共有でき、単独で更新できます。`runtime: vendor` のターゲットはそれぞれが自分のコピーを持ちます。`operations: false` では、Rustは型の層だけをコピーし、TypeScriptは何もコピーしません（型がランタイムをimportしないため）。
