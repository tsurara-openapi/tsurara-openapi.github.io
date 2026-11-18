---
title: "型"
sourcePath: docs/guide/types.md
sourceHash: ab8eb494164b
---

スキーマがTypeScriptの型になる規則です。規則は固定されていて、表の各行がテストになっています（design.md 6.4）。Pythonの表は[docs/languages/python.md](../../languages/python/)にあります。

| スキーマ | TypeScript |
|---|---|
| `type: string`、`integer`、`number`、`boolean`、`null` | `string`、`number`、`number`、`boolean`、`null` |
| `format: date-time`、`uuid`、`int64` など | 基本の型（`string`、`number`）。フォーマットはJSDocに書かれます。`typeMappings` では、JSONの解析結果と同じ値を表す別の型（ブランド付きの文字列など）を指定できます |
| `enum` | リテラルのunion（`'a' \| 'b'`）。`enumStyle: const` にすると、値のオブジェクトも出力します |
| `const` | リテラル型 |
| `nullable: true`（3.0）、`type: [string, "null"]`（3.1） | `string \| null` |
| `properties` のある `type: object` | オブジェクト型。`required` にないプロパティは省略可能になります（`a?: T`） |
| プロパティとともに書かれた `additionalProperties: { ... }` | インデックスシグネチャ。値の型は、そのスキーマとすべてのプロパティの型のunionです（TypeScriptがそれを要求するため） |
| プロパティのない `type: object` | `{ [key: string]: unknown }` |
| プロパティがなく `additionalProperties: false` | `{ [key: string]: never }` |
| `type: array`、`items` | `T[]` |
| `prefixItems` | タプル。`minItems` までの要素は必須、それ以降は省略可能で、`items` が残りの要素の型になります |
| `oneOf`、`anyOf` | union |
| `allOf` | インラインのオブジェクトは1つのオブジェクト型にまとめます。名前付きのメンバーは参照のまま残し、オブジェクトリテラル1つまでと交差させます（`Base & { extra?: string }`） |
| `discriminator` | 各メンバーにタグ（`{ petType: 'cat' }`）を交差させるので、`switch (pet.petType)` で型が絞り込まれます。そのプロパティを同じ `const` として必須にしているメンバーには交差させません |
| `itemSchema`（3.2）または `x-itemSchema` のある `text/event-stream` のレスポンス | `AsyncIterable<StreamEvent>`。`StreamEvent` は `{ event: 'note'; data: Note; id?: string; retry?: number } \| ...` です（[Server-Sent Events](../client/#server-sent-events)） |
| `itemSchema` または `x-itemSchema` のある `application/jsonl`、`application/x-ndjson`、`application/json-seq` のレスポンス | `AsyncIterable<ListItem>`。`ListItem` は項目のスキーマの型で、クライアントが項目ごとに解析します |
| その他のストリーム（項目のスキーマがない `text/event-stream` やJSON Linesなど） | `ReadableStream<Uint8Array>` |
| `readOnly` / `writeOnly` | `splitVisibility`（デフォルト）では、レスポンスに `Pet`（writeOnlyのプロパティを除く）、リクエストに `PetWritable`（readOnlyのプロパティを除く）を使います |
| `$ref` | 名前付きの型。循環は必ず名前付きの型を経由します |
| `{}`、`true` | `unknown` |
| `false` | `never` |
| バイナリの本文（`application/octet-stream`、画像など）、または `format: binary` のマルチパートのパート | `Blob \| File` |
| JSONの値の中の `format: binary` | `string`（JSONの文字列はバイト列を持てないため、警告を出します） |
| `x-tsurara-type` | `typescript` のエントリ |

## 正確、近似、拒否 {#exact-approximated-rejected}

型ですべての制約を表せるわけではありません。tsuraraはキーワードごとに扱い方をあらかじめ決めています。表せないキーワードが1つあっても、型全体が `unknown` になることはありません。

| 扱い | キーワード | 得られるもの |
|---|---|---|
| 正確 | `type`、`enum`、`const`、`required`、nullable、`properties`、オブジェクトの `allOf`、`prefixItems` | 型だけで規則を表せます |
| 広い型 | `oneOf` の排他性、文字列と数値の制約（`minLength`、`pattern`、`minimum` など）、`uniqueItems`、`patternProperties` のパターン、長いタプルになる `prefixItems` | 定義が許さない値の一部も型が受け入れます。制約はJSDocに書かれます。警告は出ません |
| キーワードを省く | `not`、`if`/`then`/`else`、`dependentSchemas`、解決できない参照 | ほかのキーワードから型を作り、警告を出します。`tsurara generate --strict` にすると警告がエラーになります |
| 拒否 | JSONの解析結果を変える型マッピング（`Date`、`bigint`） | 設定のエラー |

## 操作の型 {#operation-types}

各操作のファイルには、呼び出し関数、そのOperationDef、関数名にちなんだ型があります。

| 型 | |
|---|---|
| `GetPetData` | 入力：`path`、`query`、`headers`、`cookies`、`body` |
| `GetPetResponses` / `GetPetErrors` | 定義にあるステータスごとの本文の型 |
| `GetPetResult` | 関数が返すもの：成功のメンバー、定義にあるエラー、定義にないステータスのメンバー、通信の失敗 |
| `GetPetResponseHeaders` | 定義にレスポンスヘッダーがあるときの、型付きのレスポンスヘッダー |

スキーマがすでにこれらの名前を使っているときは、操作の型の名前をずらし（`GetPetOperationResult`）、警告を出します。関数の名前は変わりません。

## クライアントなしで型だけを使う {#types-without-the-client}

`operations: false` にすると宣言だけを出力します。サーバー側のDTO、メッセージキューのペイロード、別のHTTPライブラリで送るリクエストなどに使えます。

```yaml
input: openapi.yaml
output: src/types
operations: false
```

出力にはスキーマ、webhook、イベントチャネルが含まれ、`operations/`、OperationDef、呼び出し関数は含まれません。各言語で必要になるのはランタイムの型の層だけで、HTTPクライアントは要りません。

| 言語 | 型が必要とするもの |
|---|---|
| TypeScript | なし。`schemas/` はどのモジュールもimportせず、`index.ts` にランタイムのバージョンも記録されません。イベントチャネル（`channels/`、`zod/channels.ts`）は `@tsurara/client` から `decodeMessage` と `ChannelSchemas` をimportしますが、これらは何も送信しません |
| Python | extrasなしの `tsurara-client`。`import tsurara_client` とTypeDefのコーデックはhttpxなしで動きます。呼び出し関数には `tsurara-client[http]` が必要です |
| Rust | `tsurara-client = { version = "0.1", default-features = false }`。tokioもreqwestも使いません |
| Go | ランタイムのモジュール。生成された型はそのunionのヘルパーだけを使い、`net/http` をimportしません |

型だけで値をデコードする方法は、各言語のページにあります。
