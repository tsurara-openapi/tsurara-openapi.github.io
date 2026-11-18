---
title: "設定"
sourcePath: docs/guide/configuration.md
sourceHash: c1fc416b2bd0
---

tsuraraは、カレントディレクトリか最も近い親ディレクトリにある `tsurara.config.yaml`（または `.yml`、`.json`、`.toml`）を読みます。`--config` でファイルを指定することもできます。npmパッケージ `tsurara` には、すべてのキーを記述した `schema/tsurara.config.schema.json` が入っていて、エディタの補完に使えます。

```yaml
# yaml-language-server: $schema=./node_modules/tsurara/schema/tsurara.config.schema.json
```

## ターゲット {#a-target}

`targets` がなければ、トップレベル全体が1つのターゲットです。

```yaml
input: ./openapi.yaml            # このファイルからの相対パス、またはURL
output: ./src/generated          # このファイルからの相対パス
language: typescript             # typescript（デフォルト）またはpython
```

| キー | デフォルト | |
|---|---|---|
| `name` | `default` | ターゲットの名前で、`tsurara generate --target` で使います。ターゲットが複数あるときは必須です |
| `input` | 必須 | 定義。このファイルからの相対パスかURLです。オブジェクトで `url` と `headers` を書くこともでき、`headers` はそのURLのオリジンにだけ送られます（`Authorization: "Bearer ${TOKEN}"`） |
| `output` | 必須 | 出力先のディレクトリ。tsuraraは変更のあったファイルだけを書き込み、生成ファイルの目印で始まる古いファイルを削除します |
| `language` | `typescript` | `typescript`、`python`、`rust`（実験的）、`go`（実験的）、またはバックエンドのプログラム：`{ command: [program, args...], options: {...} }` |
| `filter` | | `tags` と `operationIds` を書くと、その操作だけを生成します。`excludeTags` と `excludeOperationIds` を書くと、それ以外を生成します。含めた操作の中からも除かれます。どれかを書くと、残った操作が使うスキーマだけが出力され、webhookは出力されません |
| `naming.overrides` | | JSON Pointerごとの希望する名前で、すべての言語に効きます：`"#/components/schemas/Error": ApiError`。各言語の命名規則はそのまま適用されます |
| `splitVisibility` | `true` | `readOnly`/`writeOnly` のあるスキーマに `XWritable` 型（TypeScript）を出力します。レスポンスには元の型を、リクエストには書き込み用の型を使います |
| `wildcardAsJson` | `false` | ワイルドカードのメディアタイプ（`*/*`、`application/*`）をJSONとして扱います。JSONしか返さないAPI向けです。デフォルトでは実際のContent-Typeに従って解析します |
| `operations` | `true` | 操作を生成します。`false` にするとスキーマ、webhook、チャネルの型だけを出力し、出力はランタイムの型の層だけを必要とします（HTTPクライアントは不要です。[クライアントなしで型だけを使う](../types/#types-without-the-client)を参照） |
| `runtime` | `package` | 生成コードがランタイムを見つける場所。`package`（`@tsurara/client`、`tsurara-client` など）か、出力にランタイムのコピーを書き込む `vendor` です（[ランタイムを同梱する](../client/#a-vendored-runtime)を参照） |
| `hooks` | | 生成の各段階で実行するコマンド（後述） |
| `typescript` | | TypeScriptバックエンドのオプション（後述）。`language: typescript` のときだけ書けます |
| `python` | | Pythonバックエンドのオプション（後述）。`language: python` のときだけ書けます |
| `rust` | | Rustバックエンドのオプション（後述）。`language: rust` のときだけ書けます |
| `go` | | Goバックエンドのオプション（後述）。`language: go` のときだけ書けます |
| `extends` | | 1つのファイルかそのリスト。そこに書かれた設定がこのファイルのデフォルトになります（後述） |

ほかの言語のセクションを書くと（`language: typescript` で `python:` を書くなど）エラーになります。

## TypeScriptのオプション {#typescript-options}

```yaml
typescript:
  importExtension: ts
  layout: split
  enumStyle: union
  typeMappings:
    uuid: { type: "Brand<'Uuid'>", import: { from: ./brand.ts, name: Brand } }
  overrides:
    "#/components/schemas/Id": string
  naming:
    schemaCase: preserve
    overrides:
      "#/components/schemas/Error": ApiErrorBody
```

| キー | デフォルト | |
|---|---|---|
| `importExtension` | `js` | 生成コードの相対importの拡張子。`js`（`tsc` でのビルドやバンドラー向け）、`ts`（Nodeの型ストリッピングで実行する場合。利用側に `allowImportingTsExtensions` か `rewriteRelativeImportExtensions` が必要）、`none`（Metroや一部のバンドラー向け） |
| `layout` | `split` | `split`：操作ごと（`operations/getPet.ts`）とスキーマごと（`schemas/Pet.ts`）に1ファイル。`tags`：タグごとに1ファイル。`single`：1ファイル |
| `enumStyle` | `union` | `union`：文字列リテラルのunion。`const`：値をキーにしたオブジェクト（`Status.available`）も出力し、型はそのオブジェクトから導きます |
| `aggregateMaps` | `false` | 汎用のクライアント向けに、すべての操作をまとめたマップ `paths.ts` と `operations.ts` も出力します |
| `clientModule` | `@tsurara/client` | 生成コードがランタイムをimportするモジュール |
| `mocks` | | `msw` または `fetch`。モックのファクトリ（`mockPet()`。定義のサンプル値から作ります）と、操作ごとのリクエストハンドラーを `mocks/` に出力します。ハンドラーはMSWのハンドラーか、`@tsurara/client/testing` の `mockFetch` のルートです（[モック](../mocks/)）。ほかのファイルはこれらをimportしません。このオプションがなければ、どのファイルも `msw` に触れません |
| `query` | | `tanstack`。TanStack Query 5のオプションを `query/` に出力します。読み取りの操作（`GET`、`HEAD`、`QUERY`）には型付きのクエリキーのファクトリとクエリオプションを、それ以外の操作にはミューテーションのオプションを出力します（[クライアント](../client/#tanstack-query)）。ほかのファイルはこれらをimportしません。このオプションがなければ、どのファイルも `@tanstack` に触れません |
| `infiniteQueries` | | 無限クエリのオプションに使う、操作IDごとのページング設定（`query: tanstack` のとき）。`param`（ページを運ぶパラメーター、`query.cursor`）、`initial`（最初のページ。デフォルトでは送りません）、`next` と `previous`（成功時の本文を指すJSON Pointer、`/nextCursor`。値がないか `null` ならクエリは終わります。`next` がなければアプリ側で `getNextPageParam` を渡します）。定義の操作に書かれた `x-tsurara-pagination`（同じフィールドを取ります）より優先されます。 |
| `validators` | | `zod`。Zod 4のスキーマを `zod/` に、`responseSchemas` を含む `zod/operations.ts` を出力します。`validateResponses` によるレスポンスの検証に使います（[クライアント](../client/#validation)）。このオプションがなければ、どのファイルも `zod` に触れません |
| `validatorConstraints` | `false` | `validators: zod` のとき、定義の制約（`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`、`minItems`、`maxItems`、`uniqueItems`、`minProperties`、`maxProperties`）と、フォーマット `uri`、`ipv4`、`ipv6`、`date`、`time`、`duration` も検査します。制約に反する値をレスポンスの検証が拒否してしまうので、デフォルトでは無効です。JavaScriptの正規表現として書けない `pattern` は、警告を出して省きます |
| `typeMappings` | | `format`（`uuid`、`date` など）ごとの型。型の式か、`{ type, import: { from, name } }` で書きます。`from` のパスが `.` で始まるときは、このファイルからの相対パスです。JSONの解析結果を変えるマッピングは書けません。`date-time` に `Date`、`int64` に `bigint` を指定するとエラーになります |
| `overrides` | | JSON Pointerごとの型。書き方は `typeMappings` と同じです |
| `naming.schemaCase` | `preserve` | `preserve` は識別子として使えるコンポーネント名をそのまま使います。`pascal` はすべての型名をPascalCaseにします |
| `naming.overrides` | | JSON PointerごとのTypeScriptの最終的な識別子。そのまま使われます |

`typeMappings`、`overrides`、`x-tsurara-type` の型は、型の式（名前、型引数、配列、`|`、`&`、リテラル）でなければなりません。それ以外を書くと、設定ではエラーに、定義では警告を出して無視されます。

## Pythonのオプション {#python-options}

| キー | デフォルト | |
|---|---|---|
| `strictEnums` | `false` | enumと判別子が、定義にない値を拒否します。デフォルトでは、値を受け取る箇所でそうした値も保持します（`Status | str`） |
| `mocks` | `false` | `mocks/` も出力します。サンプル値から作る `mock_{name}()` ファクトリと、操作ごとの `tsurara_client.testing` の `MockRouter` 向けのルートです（[Python](../../languages/python/#mocks)） |

## Rustのオプション {#rust-options}

Rustバックエンドは実験的です（[docs/languages/rust.md](../../languages/rust/)）。

| キー | デフォルト | |
|---|---|---|
| `runtimeCrate` | `tsurara_client` | 生成コードがランタイムのクレートを参照するパス。`runtime: vendor` のときは必須で、クレート内に生成されたモジュール `runtime` のパスを書きます（`crate::api::runtime`） |
| `mocks` | `false` | モジュール `mocks` も出力します（テスト時と、`tsurara-client/testing` を有効にするクレートのフィーチャー `mocks` があるときにコンパイルされます）。中身はファクトリと `MockTransport` 向けのルートです（[Rust](../../languages/rust/#mocks)） |
| `typeMappings` | | `format` ごとの型を型のパスで書きます：`date-time: chrono::DateTime<chrono::Utc>` |
| `overrides` | | JSON Pointerごとの型：`"#/components/schemas/Id": uuid::Uuid` |

## Goのオプション {#go-options}

Goバックエンドは実験的です（[docs/languages/go.md](../../languages/go/)）。`output` に1つのパッケージを書き込みます。

```yaml
language: go
go:
  package: petstore
```

| キー | デフォルト | |
|---|---|---|
| `package` | 出力先ディレクトリの名前 | 生成ファイルのパッケージ名。ディレクトリ名を小文字にし、英数字以外の文字を除いたもの（`pet-store` → `petstore`）になります。Goのキーワードには `api` を付け（`go` → `goapi`）、何も残らなければ `api` です |
| `runtimeModule` | `github.com/tsurara-openapi/tsurara/runtimes/go` | ランタイムのモジュール（`runtimes/go`）のimportパス。`runtime: vendor` のときは出力内の `internal/tsurara` のimportパスで、最も近い `go.mod` から求めます |
| `mocks` | `false` | タグ `tsurara_mocks` でビルドされる `mocks_gen.go` も出力します。中身は `Mock{Type}()` ファクトリと `tsuraratest` 向けのルートです（[Go](../../languages/go/#mocks)） |
| `typeMappings` | | `format` ごとの型を、そのパッケージのimportパスとともに書きます：`date-time: { type: time.Time, import: { from: time } }` |
| `overrides` | | JSON Pointerごとの型：`"#/components/schemas/Id": int64` |

## 複数のターゲット {#targets}

```yaml
extends: ../../tsurara.base.yaml
typescript:
  importExtension: ts           # 以下のすべてのターゲットのデフォルト
targets:
  - name: public
    input: https://api.example.com/openapi.json
    output: src/generated/public
  - name: admin
    input: ./admin.yaml
    output: src/generated/admin
    filter: { tags: [users] }
```

トップレベルのキーは、`targets` の各エントリのデフォルトになります。各ターゲットには重複しない `name` が必要です。

## extends {#extends}

`extends` には1つのファイルかそのリストを書きます。オブジェクトは深くマージされ、配列とそれ以外の値は置き換えられます。値が衝突したときは、extendsを書いた側のファイルが優先されます。各ファイルはまず単独で読み込まれて検査されるので、相対パスは書かれたファイルからの相対のままで、フックはそのファイルのディレクトリで実行されます。

## プラグイン {#plugins}

```yaml
plugins:
  - ./tsurara.plugin.ts                         # @tsurara/plugin を通してNodeで実行
  - { module: ./other.py, runtime: [python, -m, tsurara_plugin] }
```

各モジュールは `tsurara generate` のたびに1回実行され、宣言した段階に参加します（design.md 11.2、[プラグイン](../plugins/#plugins-in-typescript)）。パスは書かれたファイルからの相対パスです。

## 環境変数 {#environment-variables}

どの文字列でも、`${VAR}` は環境変数の値に置き換えられます。トークンを設定ファイルに書かずに済みます。設定されていない変数はエラーになります。

## フック {#hooks}

フックとプラグインは、`tsurara generate`（およびコーディングエージェント向けのMCPサーバーの `generate`）が利用者の権限で実行するコマンドです。設定ファイルはコードとして扱ってください。信頼できるスクリプトだけを実行するのと同じく、信頼できる設定でだけ生成してください。フックとプラグインが返すファイルのパスは、出力先ディレクトリの中に収まっていなければなりません（相対パスで、`..` を含まない）。tsuraraはそれ以外のパスを拒否します。

| フック | 実行される時点 | 入力と出力 |
|---|---|---|
| `transformDocument` | 解析の前 | ルートの定義をJSONで標準入力に受け取り、変換した定義を標準出力に書きます |
| `transformModel` | 解析の後 | モデルのJSON（`semVersion` でバージョンを示します）を標準入力で受け取り、標準出力に書きます |
| `extend` | 生成の後 | `{ language, model, manifest, common, marker }` をJSONで標準入力に受け取り、追加するファイル（`[{ path, contents }]`）を標準出力に書きます。各ファイルは `marker` で始めます（[プラグイン](../plugins/)） |
| `transformFiles` | 書き込みの前 | 出力ファイル（`path`、`contents`）のJSONを標準入力で受け取り、標準出力に書きます |
| `afterWrite` | 書き込みの後 | コマンドのリスト。`{output}` は出力先ディレクトリに置き換えられます |

```yaml
hooks:
  transformDocument: [node, scripts/patch-openapi.mjs]
  afterWrite:
    - [biome, format, --write, "{output}"]
```

フックはリスト形式のコマンド（`[program, args...]`）です。フックが失敗すると生成は止まります。

## 定義の拡張フィールド {#extension-fields-in-definitions}

| フィールド | |
|---|---|
| `x-tsurara-type` | スキーマに言語ごとの型を指定します：`{ typescript: "Brand<'Uuid'>", python: UUID }`。importを伴う場合：`{ typescript: { type: Uuid, import: { from: ./ids.ts, name: Uuid } } }` |
