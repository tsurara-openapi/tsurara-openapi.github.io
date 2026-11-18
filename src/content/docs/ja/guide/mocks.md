---
title: "モック"
sourcePath: docs/guide/mocks.md
sourceHash: 83f0e4ae9519
---

`typescript.mocks` はサンプルデータとリクエストハンドラーを生成します。UIの開発、Storybook、テストをサーバーなしで動かせます。値は定義（例、デフォルト値、enum、フォーマット、制約）から作られ、何度実行しても同じです。

```yaml
typescript:
  mocks: msw     # MSW のリクエストハンドラー。@tsurara/client/testing の mockFetch 向けなら `fetch`
```

すべて `mocks/` に出力され、ほかのファイルはこれをimportしません。そのため本番のコードが `msw` を読み込むことはありません。

## ファクトリ {#factories}

`mocks/schemas/{Name}.ts` には、スキーマごとに `mock{Name}()` があります。オブジェクトのファクトリは上書きする値を受け取ります。

```ts
import { mockPet } from './generated/mocks/schemas/Pet.ts';

const pet = mockPet({ name: 'Tama' }); // サンプル値を持ち、`name` だけを置き換えた Pet
```

ほかのスキーマの中で使われるスキーマは、それ自身のファクトリで作ります（`owner: mockOwner()`）。値の定義は1か所だけです。サンプルが型に正確には従えない場合（マッピングとメンバーが食い違う判別子、`allOf`、外部の型）は、その型に型アサーションします。

## ハンドラー {#handlers}

`mocks/operations/{function}.ts` には操作ごとのハンドラーがあります。引数なしなら、定義にある最初の成功レスポンスとサンプル値で応答します。引数には定義にあるレスポンスか、リクエストを受け取ってそれを返す関数を渡します。

```ts
import { setupServer } from 'msw/node';
import { handlers } from './generated/mocks/index.ts';
import { getPetByIdHandler } from './generated/mocks/operations/getPetById.ts';

const server = setupServer(...handlers);
server.use(getPetByIdHandler({ status: 404, body: { message: 'gone' } }));
server.use(getPetByIdHandler(({ params }) => ({ status: 200, body: mockPet({ id: Number(params.petId) }) })));
```

`{Op}MockResponse` には定義にあるステータスと本文の型が並んでいるので、定義にないステータスや型の違う本文は型エラーになります。パスはMSWのパスになります（`*/pets/:petId`。`options.baseUrl` が `*` を置き換えます）。セグメントの途中にあるパラメーター（`/files/{name}.{ext}`）は、名前付きのパラメーターなしの正規表現で照合します。本文はそのメディアタイプに応じて、JSON、テキスト、またはバイト列（バイナリとストリームのレスポンス）で書き込みます。

## MSWを使わない場合 {#without-msw}

`mocks: fetch` では、同じ関数が `@tsurara/client/testing` の `mockFetch` 向けのルートを返し、`mocks/index.ts` が `routes` をexportします。

```ts
import { createClient } from '@tsurara/client';
import { mockFetch } from '@tsurara/client/testing';
import { routes } from './generated/mocks/index.ts';

const mock = mockFetch(routes, { basePath: '/v1' });
const api = createClient({ baseUrl: 'https://api.test/v1', fetch: mock.fetch });
```

ほかのランタイムにも同じモックのトランスポートがあります（`tsurara_client.testing`、Rustの `testing` フィーチャー、Goのパッケージ `tsuraratest`）。`python.mocks`、`rust.mocks`、`go.mocks: true` で、それぞれのファクトリとルートを生成します（[Python](../../languages/python/#mocks)、[Rust](../../languages/rust/#mocks)、[Go](../../languages/go/#mocks)）。
