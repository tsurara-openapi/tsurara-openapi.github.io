---
title: "設計"
sourcePath: docs/design.md
sourceHash: faa01e846180
---

この文書は、OpenAPIの定義からTypeScriptの型とAPIの呼び出し関数を生成するツール、tsuraraの設計を述べる。

- 状態：実装中
- 最終更新：2026-11-10

tsuraraは、TypeScriptだけでなく多くの言語を生成できるように再構成している最中である。目標とするアーキテクチャは18章で述べる。それが4、6、7、10、11章と異なる箇所では、これらの章は現在の実装を述べている。

## 1. 目的 {#1-purpose}

OpenAPIからTypeScriptを生成するツールに、事実上の標準はない。定評のあるツールには、複雑なスキーマから誤った型を生成する、大きな定義で型検査が遅くなる、シリアライズを生成コードに書き込むといった問題がある（3章）。tsuraraが存在するのは出力のこうした問題のためであり、ほかのプロジェクトの状況のためではない。

2026年11月時点の状況は次のとおりである。構造が理想に近いopenapi-typescriptは、2026-09-19にメンテナーによってメンテナンスモードに移され、今後は更新されない（[issue 2874](https://github.com/openapi-ts/openapi-typescript/issues/2874)）。2025-12-29に公開された2026年のロードマップで、openapi-fetchとopenapi-react-queryはすでにメンテナンスモードに移っていた（[discussion 2559](https://github.com/openapi-ts/openapi-typescript/discussions/2559)）。型が理想に近いhey-api（`@hey-api/openapi-ts`）は、2026-06-22の0.99.0までほぼ毎週リリースしていたが、それ以降は `next` のプレリリースしか公開していない（npmレジストリ、2026-11-11に確認）。

tsuraraはこれらを置き換えるために作っている。生成器はRustで書き、単一のバイナリとして配布する。生成コードが使うランタイムライブラリは、npmパッケージ `@tsurara/client` として配布する。

## 2. 要件 {#2-requirements}

| # | 要件 |
|---|---|
| R1 | 生成器をRustで実装する |
| R2 | pnpm workspaceのモノレポで、複数のアプリが1つの生成結果を共有できる。各アプリはログ、トレース、接続時のヘッダーなどを個別に変えられる |
| R3 | 生成コードはTypeScriptの `erasableSyntaxOnly` を満たす |
| R4 | 出力を複数のファイルに分け、Gitの競合を起こりにくくする |
| R5 | OpenAPIの仕様（3.0、3.1、3.2。2.0は3.0に変換する。5.4を参照）を網羅する |
| R6 | 定義はローカルのファイルからもURLからも読み込める |
| R7 | 型だけでなく、操作ごとの呼び出し関数を生成する |
| R8 | 同じ定義からほかの言語も生成する。どの言語でも、まず型を、次に呼び出し関数とランタイムライブラリを用意する（18章） |

R7により、tsuraraはopenapi-fetchの `client.GET('/pet/{id}', ...)` のような汎用関数を通して型を推論する方式を採らない。この方式は推論が重くなり、戻り値の型を取り出すのも難しい。tsuraraは、具体的なパラメーターと戻り値の型を持つ関数を操作ごとに1つ生成する。

## 3. 既存ツールの問題とtsuraraの方針 {#3-problems-with-existing-tools-and-tsuraras-approach}

既存ツールへの主な不満と、それぞれに対するtsuraraの方針を対応させる。詳細は括弧内の章にある。

| 既存ツールの問題 | tsuraraの方針 |
|---|---|
| `allOf`/`oneOf`/discriminator/nullable/循環から誤った型や不正な型ができる | 出力の前に中間表現（IR）で正規化する（6.3）。変換規則を対応表として固定し、すべての行をテストする（6.4、13） |
| 意図しない `unknown` や `Record<string, never>` | 対応表で出力を決め、近似を警告として報告する（6.4、6.8） |
| 順序や配置によって出力が変わる。交差型が読みにくい | allOfを平坦化し、同じ意味のスキーマからは同じ出力を作る（6.3） |
| 大きな定義でIntelliSenseが遅い。「excessively deep」エラー | 巨大な型をインデックスでたどる構造を作らない。Result型は展開したunionとして出力する（7.4） |
| `text/plain` などがJSONとして解析され、実行時に落ちる | レスポンスの解析方法（parseAs）を、定義のメディアタイプから自動で決める（8.5） |
| 生成コードがコンパイルできない | 大きな実在の定義とエッジケースの定義からの出力を、複数のtsconfigで `tsc` に通すテストをCIで実行する（13） |
| `@type` が `_type` になる。予約語から不正な型ができる。大文字小文字の設定で名前が思わぬ形に変わる | プロパティ名は変換せず、引用符で囲む。識別子は1つのサニタイザーに通す。スキーマ名はデフォルトでは変換しない（6.6） |
| `formData.append` の重複など、生成されたマルチパートのコードのバグ | マルチパートを組み立てるコードは生成コードに書かず、ランタイムライブラリに置く（8.5） |
| 生成後に正規表現で後処理するしかない | プラグインがIRにフックできるようにする（11） |
| 結果がプラグインの登録順に依存する | プラグインはフックする段階を宣言し、登録順に依存しない（11） |
| `throwOnError` が生のJSONを投げ、ステータスが失われる | `unwrap()` は `Error` を継承した `ApiError` を投げる（8.3） |
| bigintやDateの型が実行時の値と合わない | 実行時の値と食い違う型マッピングを拒否する（10.4） |
| 仕様とのずれを実行時に検出できない | 検証は当初の範囲外だが、検出できるずれはResultとして返す（8.2）。`kind: 'validation'` は将来の検証のために予約する |
| メジャーバージョンの更新で挙動が変わる | 安定性の約束が何を対象にするかを明示し、変更はsemverのメジャーでだけ行う（14） |

## 4. 全体の構成 {#4-overall-structure}

### 4.1 リポジトリの構成 {#41-repository-layout}

```
crates/
  tsurara-loader     定義の読み込み、$ref の解決、Swagger 2.0 の正規化
  tsurara-sem        定義を解析してモデルにする（I/O のない純粋な変換）
  tsurara-backend    各言語のコード生成器へのインターフェースとプラグイン
  tsurara-lang-typescript  TypeScript の型、OperationDef、関数の生成
  tsurara-config     設定ファイルの読み込み（extends、targets）
  tsurara-cli        tsurara コマンド（generate / check / init）
runtimes/
  typescript      @tsurara/client（生成された TypeScript が使うランタイムライブラリ）
packages/
  tsurara            CLI を配布するための npm ラッパー
spec/
  operation-def.schema.json  すべてのランタイムが共有する OperationDef の形式
  conformance/    すべてのランタイムが実行するリクエストとレスポンスのベクター（18.9）
schema/
  tsurara.config.schema.json   設定ファイルの JSON Schema（エディタの補完用）
examples/
  pnpm-monorepo   apps/app-1 と app-2 が packages/openapi を共有する例。E2E テストを兼ねる
docs/
  design.md       この文書
```

`packages/tsurara` は、biomeと同じく `optionalDependencies` を通してプラットフォームごとのバイナリを配布する。

### 4.2 処理の流れ {#42-processing-flow}

```
入力（ファイル / URL）
  → tsurara-loader: 読み込み、外部の $ref の収集、Swagger 2.0 → 3.0 の変換
  → プラグイン（document の段階）
  → tsurara-sem、続いてバックエンド（tsurara-lang-typescript）
      ① 解析: $ref、判別子、readOnly/writeOnly の解決
      ② 正規化した IR の構築
      → プラグイン（IR の段階）
      ③ 出力: ファイルごとのコード
  → プラグイン（files の段階）
  → tsurara-cli: 書き込み、古い生成ファイルの削除、afterWrite フック
```

tsurara-semとバックエンドはI/Oを行わない。入力は読み込み済みの `DocumentSet`、出力はパスと内容の組のリストである。Rustのライブラリとして組み込んだ場合も、CLIとまったく同じ変換を行う。

## 5. 読み込み（tsurara-loader） {#5-loading-tsurara-loader}

### 5.1 入力元 {#51-input-sources}

入力はローカルのパス、`http(s)://`、`file://` のいずれかである。HTTPでは認証ヘッダーとタイムアウトを指定できる。ヘッダーはルートの定義のオリジンにだけ送る。ローダーはリダイレクトを自分でたどり（最大10回）、リダイレクトがそのオリジンを離れるとヘッダーを外し、`http(s)` 以外へのリダイレクトは拒否する。

ネットワークへのアクセスは `Fetcher` トレイトの背後にある。デフォルトの実装はファイルの読み込みとHTTP（ureq）を扱う。Rustのライブラリとして組み込む場合は、独自のHTTPスタックやキャッシュに置き換えられる。HTTPが不要な利用者向けに、CargoのフィーチャーでHTTPの対応を外せる。

### 5.2 形式の判定 {#52-format-detection}

本文が `{` か `[` で始まればJSONとして読み、失敗すればYAMLとして読む。`200:` のような数値のYAMLキーは文字列に変換する。YAMLのマージキー（`<<`）も展開する。エイリアスはコピーに展開するので、それによって増えるノードの数を制限している（100万、またはYAMLのイベントあたり100のうち大きいほう）。エイリアスを入れ子にした文書（「billion laughs」）は、上限とエイリアスの行を示す解析エラーで失敗する。

### 5.3 $refの解決 {#53-ref-resolution}

ルートの定義から `$ref` をたどり、参照されている外部の定義をすべて `DocumentSet` に読み込む。定義の中の位置は、文書のURLとJSON Pointerの組（`Loc`）で表す。相対参照はURLの結合規則で解決する。

3.1ではJSON Schema 2020-12に従い、`$id`、`$anchor`、`$dynamicAnchor` を索引に登録し、参照先として引けるようにする。

HTTPで取得した定義はローカルのファイルを参照できない。`file://` の文書は、ローカルの文書がそれを参照しているときにだけ読み込む。リモートの文書からの参照（直接でも `$id` 経由でも）は、解決の時点で理由を示して失敗する。そうしなければ、ベンダーの定義が、生成を行うマシン上のファイルの内容を出力に入れられてしまう。リモートの定義がほかのHTTPのアドレスを参照することはできる。ホストの許可リストはまだない。

外部の定義の読み込みに失敗しても、その時点ではエラーにしない。それへの参照を実際に解決するときにエラーになる。こうしておけば、例の値に `$ref` という名前のキーが含まれているだけで読み込みが止まることはない。

### 5.4 Swagger 2.0の正規化 {#54-swagger-20-normalization}

Swagger 2.0の定義は、tsurara-semに渡す前にOpenAPI 3.0に変換する。こうすればtsurara-semは3.xだけを扱えばよい。変換は次の内容を含む。

- `definitions` / `parameters` / `responses` を `components` の下に移し、`$ref` を書き換える
- `in: body` のパラメーターを `requestBody` に、`in: formData` のパラメーターをmultipartかurlencodedの `requestBody` に変換する
- `produces` / `consumes` からメディアタイプを決める
- `host` / `basePath` / `schemes` から `servers` を作る
- `securityDefinitions` を `securitySchemes` に変換する
- `x-nullable` を `nullable` に、`type: file` を `type: string, format: binary` に変換する

2.0への対応は当初の範囲に含める。既存の定義の多くはまだ2.0であり、変換をローダーの中に閉じておけばコード生成に影響しない。

## 6. コード生成（tsurara-semとtsurara-lang-typescript） {#6-code-generation-tsurara-sem-and-tsurara-lang-typescript}

### 6.1 3つの段階 {#61-three-stages}

OpenAPIのスキーマをそのままTypeScriptとして書くと、スキーマの書き方の揺れがそのまま出力に持ち込まれる。コード生成は、解析、正規化したIR、出力の3段階に分ける。

1. 解析：`$ref` を解決し、判別子の関係と、readOnly/writeOnlyの有無を調べる。
2. 正規化したIR：TypeScriptの型に近い中間表現を作り、同じ意味のスキーマを同じ形にそろえる。
3. 出力：IRから型、OperationDef、関数を書き出し、ファイルに割り当てる。

### 6.2 対応する仕様 {#62-supported-specification}

| バージョン | 主な項目 |
|---|---|
| 3.0 | `nullable`、discriminator（`oneOf` の側と、`allOf` で継承する側の両方）、`readOnly`/`writeOnly` |
| 3.1 | `type` の配列、`const`、`prefixItems`（タプル）、`$defs`、兄弟キーのある `$ref`、`contentMediaType`/`contentEncoding`、webhook、`$dynamicRef` |
| 3.2 | `query` メソッド、`additionalOperations`、`in: querystring`、`itemSchema`（シーケンシャルなメディアタイプ）、`discriminator.defaultMapping` |
| すべて | パラメーター（path/query/header/cookie、パスレベルのパラメーターとのマージ、`content` での指定）、複数のメディアタイプ、レスポンスヘッダー、`default` と `2XX` 形式のステータス、コールバック、servers、JSDoc（description、deprecated、default、example、format、各種の制約） |
| 拡張 | `x-event-channels`：ハブの更新のように、操作のレスポンスではないメッセージ（8.8） |

初期のバージョンでは、`$dynamicRef` は参照箇所ごとに静的に解決し、具体的な型（`PetPage` など）として出力する。`Page<T>` のようなジェネリック型の出力は将来に回す。

### 6.3 正規化 {#63-normalization}

正規化したIRを作る際に、次の処理を行う。

- allOfの平坦化：名前のないオブジェクトのメンバーは1つのオブジェクトリテラルにまとめる。名前付きの型（`$ref`）は交差型のまま残すが、交差型に含まれるオブジェクトリテラルは1つまでにする。出力は `Base & { a: string; b: number }` の形になる。異なる型で現れたプロパティだけは、そのプロパティについて交差型を残す。
- unionの整理：入れ子を平坦にし、重複を除く。`unknown` を含むunionは `unknown` になり、`never` は除く。
- nullableの統一：3.0の `nullable: true`、3.1の `type: [..., 'null']`、`type: 'null'` を含む `oneOf` は、すべて `X | null` になる。3.0で `$ref` の兄弟として書かれた `nullable: true` は、仕様に従って無視する。このパターンは実在の定義によく現れるので、無視したことを警告し（6.8）、`null` を許すなら `allOf: [{ $ref }]` と `nullable: true` に書き換えるよう勧める。
- 順序：プロパティは定義での順序を保つ。読みやすさにはその順序が重要だからである。一方、`required` の順序とallOfのメンバーの順序は出力に影響しない。

### 6.4 型の対応表 {#64-type-mapping-table}

スキーマから型への変換規則は次の表で固定し、各行をテストにする。

| スキーマ | 出力 |
|---|---|
| `{}` / `true` | `unknown` |
| `false` | `never` |
| プロパティも `additionalProperties` もない `type: object` | `{ [key: string]: unknown }` |
| プロパティがなく `additionalProperties: false` | `{ [key: string]: never }`（この場合だけ） |
| プロパティがあり、`additionalProperties` がない | インデックスシグネチャなし |
| プロパティがあり、`additionalProperties` にスキーマがある | インデックスの値の型は、そのスキーマとすべてのプロパティの型のunion |
| `patternProperties` | インデックスシグネチャ（値はパターンごとの型のunion） |
| `enum` | リテラル型のunion |
| `const` | リテラル型 |
| `prefixItems` | タプル。各要素は省略可能（`[string?, number?]`）で、`minItems` までの要素は必須。`items` にスキーマがあれば残りの要素の型になる。`items` がなければ `...unknown[]` を付け足し、`items: false` なら残りの要素を許さない |
| HTTPの本文そのもの、またはマルチパートのパートの値としての、`format: binary` の文字列や `contentEncoding` のない `contentMediaType` | `Blob \| File` |
| JSONの値の中の `type: string`（`contentMediaType`、`contentEncoding`、`format: binary` があっても） | `string`。`contentMediaType` などはJSDocに書く。`format: binary` はJSONの中では表せないので、JSONの値の中（宣言のルートやJSON以外の本文ではない場所）に現れたら警告する |
| 循環 | 必ず名前付きの型を経由する。インラインの自己参照は名前付きの型に引き上げる |
| TypeScriptで表せないキーワード（`not` など） | そのキーワードだけを省き、残りのキーワードから型を作る。何も残らなければ `unknown`。どちらの場合も警告する |

プロパティと `additionalProperties` の両方があるときにunionを取るのは、`{ a: string; [key: string]: number }` がTypeScriptのエラーになるからである。

`prefixItems` の要素が省略可能なのは、JSON Schemaの `prefixItems` が決めるのは「先頭から順に、存在する要素の型」だけで、要素の数は決めないからである。`prefixItems: [string, number]` と `items: false` だけなら、`[]` も `["a"]` も正しい値である。そのため出力は `[string?, number?]` になり、`minItems: 2` があれば `[string, number]` になる。`maxItems` が `prefixItems` の数より小さければ、要素をその数まで切り詰める。

次の2つもTypeScriptで正確に表せる。`minItems` が `prefixItems` の数を超えるときは、残りの要素の型を必須の要素として足せる（`[string, number, boolean, ...boolean[]]`）。`items` にスキーマがあり `maxItems` が上限を決めるときは、上限まで省略可能な要素を並べられる（`[string?, boolean?, boolean?]`）。しかし数が大きいとタプルが長くなり、出力の大きさと型検査のコストが増える。そこで初期のバージョンでは、どちらも残りの要素の型（`...T[]`）で近似し、制約はJSDocに残す。

- `minItems` が `prefixItems` の数を超えるとき
- `items` にスキーマがあり、`maxItems` が上限を決めるとき

どの値も満たせない組み合わせは `never` になる。`minItems` が `maxItems` より大きい場合と、`items: false` で `minItems` が `prefixItems` の数を超える場合である。

IRのタプルは、要素の型のリストに加えて必須の要素の数を持つ（028での作業）。

値がバイナリかどうかは、現れる場所で決まる。JSONの中で `type: string` と宣言された値はJSONの文字列として届くので、`contentMediaType: text/html` や `format: binary` があっても `string` である。`Blob | File` になるのは、リクエストやレスポンスの本文そのもの（`application/octet-stream` など）とマルチパートのパートの値だけである。パートの値とは、マルチパートの本文のスキーマのトップレベルのプロパティと、その中の配列の項目で、`$ref` をたどった先も含む。名前付きのオブジェクトスキーマで、その使われ方（すべての文書のすべての `$ref` と判別子のマッピング）がすべてマルチパートのリクエストの本文であるものは、パートの値を持つ型として宣言し、それらの本文はその型を参照する。それ以外の名前付きのスキーマはJSONの値として変換するので、JSONの中のどこで使われてもその型は正しい。マルチパートの本文がそうしたスキーマを参照していて、そのスキーマにバイナリのパートの値があるときは、本文の型はそのスキーマを参照せず、それらのパートを `Blob | File` にしてインラインに展開する。名前付きの型は変えず、誤った型も出力しない（029で決定）。

#### 6.4.1 正確に表すもの、近似するもの、拒否するもの {#641-what-is-exact-what-is-approximated-and-what-is-rejected}

TypeScriptの型ですべての制約を表せるわけではない。tsuraraはキーワードごとに、次の4つの扱いのどれにするかをあらかじめ決めている。表せない制約が1つあるだけで型全体を `unknown` にし、わかっている部分まで捨てることはしない。

| 扱い | 例 | 出力と通知 |
|---|---|---|
| 正確に表す | `type`、`enum`、`const`、`required`、nullable、`properties`、`allOf` によるプロパティの合成、`prefixItems`（6.4の規則。ただし `minItems` が `prefixItems` の数を超える場合と、`items` のスキーマと `maxItems` の組み合わせは除く） | 型だけで表せる |
| 広い型で近似する | 6.4で近似する `prefixItems` の2つの長さの制約、`oneOf` の排他性（TypeScriptのunionは複数のメンバーに一致する値も受け入れる）、`patternProperties` のパターン、プロパティと `additionalProperties` の組み合わせ（6.4）、文字列と数値の制約（`minLength`、`pattern`、`minimum` など）、`uniqueItems` | 定義が許さない値の一部も型が受け入れる。日常的に起こるので警告はしない。制約はJSDocに書き、この文書の表で近似であることを明記する |
| キーワードを省いて近似する | `not`、`if`/`then`/`else`、`dependentSchemas`、解決できない参照、静的に解決した `$dynamicRef`、無視した `$ref` の兄弟 | 警告する（6.8）。CIでは警告をエラーとして扱える |
| 拒否する | 実行時の値と食い違う型マッピング（10.4） | 生成はエラーで止まる |

型の正しさは、出力が `tsc` を通ることだけでなく、定義が許す値を受け入れ、許さない値を拒否することでも確かめる（13章）。近似のために受け入れられる値は、テストの中で近似として印を付ける。

### 6.5 discriminatorとreadOnly/writeOnly {#65-discriminator-and-readonlywriteonly}

discriminator：`oneOf`/`anyOf` に判別子があるとき、各メンバーには判別するプロパティがリテラル型として付く（`({ petType: 'cat' } & Cat) | ...`）。値は `mapping` から取り、`mapping` になければスキーマ名を使う。そのプロパティをすでにその値だけで必須にしている（必須の `const`）メンバーは、交差させても何も変わらないのでそのままにする。子のスキーマが `allOf` で親を参照し、親に判別子があるときは、子の型にも同じリテラルが付く。親が `oneOf` で子を並べ、各子が `allOf` で親を参照する循環では、子の側は `oneOf` を除いた親だけを展開し、型の循環参照エラーを避ける。

判別子は検証の結果を変えない（OpenAPI 3.1.1のDiscriminator Object）。また、親のスキーマを検証しても子のスキーマを探しにはいかない。そのためtsuraraは判別するプロパティにリテラル型を付けるだけで、親の型を子のunionに置き換えることはしない。親に判別子があり、子が `allOf` で親を参照しているだけの定義では、レスポンスの型は親の型のままで、子の型に絞り込めない。絞り込みたければ、定義の親で子を `oneOf` に並べる。

readOnly/writeOnly：どちらかを持つスキーマ（参照先を通じて持つものを含む）には、元の型に加えて `PetWritable` を生成する。元の型はレスポンスで使い、writeOnlyのプロパティを除く。`Writable` の型はリクエストで使い、readOnlyのプロパティを除く。どちらも持たないスキーマには `Writable` の型を作らない。この分割は設定で無効にでき、その場合はreadOnly/writeOnlyを無視して型を1つだけ出力する。

スキーマがreadOnly/writeOnlyを持つかどうかは、参照のグラフ全体で決める。AがBを参照し、BがAを参照するような相互参照では、強連結成分ごとに結果が変わらなくなるまで計算を繰り返す。検査の途中の仮の結果を確定したものとして扱ってはいけない。仮の結果で確定すると、相互参照の向こう側にあるreadOnlyのプロパティがリクエストの型に残ってしまう（030での作業）。

スキーマにreadOnlyのプロパティを1つ足すだけで、そのスキーマへの参照のリクエスト側の型名が `X` から `XWritable` に変わる。これは命名の規則どおりだが、利用者のコードにとっては互換性のない変更である（14章）。

### 6.6 命名 {#66-naming}

- プロパティ名：変換しない。識別子にできない名前は引用符で囲む（`'@type'`）。
- 型名と関数名：すべて1つのサニタイザーに通す。予約語や、生成コードが使うTypeScriptのグローバル（`Date`、`Error`、`Blob`、`File`、`Record` など）との衝突は、固定の規則で避ける。大文字小文字だけが異なる名前も衝突とみなす。大文字小文字を区別しないmacOSのファイルシステムで、ファイル名がぶつかるのを防ぐためである。
- スキーマ名：正しい識別子ならそのまま使う。キャメルケースへの変換などはオプトインである。
- 関数名：`operationId` から作る。`operationId` がなければ、メソッドとパスから作る。
- 衝突の解決：名前は定義の順に割り当てるので、同じ定義からは常に同じ名前ができる。自動で選ばれた名前は、設定の `naming.overrides` で固定できる。

インラインのスキーマを名前付きの型にするバックエンド（TypeScript以外）は、18.4.2で述べるとおり、持ち主とパスから名前を導く。候補は最後に命名するので、インラインのスキーマを追加しても宣言の名前は変わらない。

予約語やグローバルと衝突する名前には接尾辞 `Model` を付ける（`Error` → `ErrorModel`、`Date` → `DateModel`）。接尾辞を付けてもほかの名前と衝突するときは、`2`、`3` などを付け足す。避けた衝突は警告として報告し（6.8）、`naming.overrides` で別の名前に固定できる。

操作から導いた型名（`{P}Data`、`{P}Responses`、`{P}Errors`、`{P}Result`、`{P}ResponseHeaders`、`{}Def`、webhookとコールバックの型）がすでに使われている場合（たいていはスキーマ）は、スキーマが名前を保ち、導いた名前だけをずらす。接尾辞の前に `Operation` を入れ（`ListPetsOperationResult`）、それも使われていれば番号を付ける。関数名とほかの導いた名前は変わらないので、`ListPetsResult` という名前のスキーマを追加しても、関数 `listPets` が `listPets2` に変わることはない。`renamed` の警告が両方の名前を示し、`naming.overrides` で別の名前を選べる。これはkubbの衝突検出（種類をまたぐ場合は意味のある接尾辞、同じ種類の中では番号）にならったものである。最初の方針では生成をエラーで止めていたが、OpenAIの定義にはこうした衝突が10個ある（`UsageCompletionsResult` はスキーマであり、`usageCompletions` の結果でもある）ので、064で変更した。

名前については、決定性と安定性を分けて考える。

- 決定性：同じ定義と設定からは常に同じ名前ができる。tsuraraは常にこれを保証する。
- 安定性：定義に項目を追加しても既存の名前が変わらない。予約語とグローバルに付ける接尾辞 `Model` は名前そのものだけで決まるので安定している。一方、大文字小文字だけが異なる名前や重複した名前に付ける番号は、定義の順序に依存する。項目を追加すると既存の名前が変わることがあり、その場合は警告で知らせる。固定したい名前は `naming.overrides` で指定する。割り当てた名前を記録するロックファイルは、選択肢として残している（16章）。

### 6.7 型検査の性能 {#67-type-checking-performance}

型の計算は生成器で行い、TypeScriptの型システムには任せない。

- `paths['/x']['get']['responses'][200]['content']['application/json']` のように、巨大な型をインデックスでたどる構造を作らない。
- Result型はジェネリクスで組み立てず、展開したunionとして出力する。ホバーで読みやすく、インスタンス化のコストもかからない。
- すべての関数に明示的な戻り値の型を付ける。これで `isolatedDeclarations` を満たし、プロジェクト参照を使う型検査も速くなる。
- 条件型や再帰的なmapped typeを生成しない。

### 6.8 警告 {#68-warnings}

`tsurara generate` は、近似的に変換した箇所（`unknown` で代用した、解決できない `$dynamicRef` を静的に解決した、`$ref` の兄弟を無視したなど）をJSON Pointerとともに報告する。これにより利用者は、型が `unknown` になった理由を知るために定義のどこを見ればよいかがわかる。どの近似で警告を出すかは、6.4.1の表に従う。

| コード | 意味 |
|---|---|
| `unsupported` | モデルで表せないキーワードを省いた。または、値が定義のとおりになりえない |
| `dynamic-ref` | `$dynamicRef` を参照箇所ごとに静的に解決した |
| `renamed` | 衝突を避けるために名前を変えた |
| `unresolved-ref` | 参照を解決できず、`unknown` になった |
| `invalid-definition` | 定義が想定外の形をしていて、できる範囲で解釈した |
| `ignored-sibling` | `$ref` の隣のキーワードを無視した（OpenAPI 3.0） |
| `wildcard-media-type` | ワイルドカードのメディアタイプに、バイナリでないスキーマがある |
| `unmapped-type` | マッピングした型に、その言語のエントリがない |
| `sample-cycle` | サンプル値（18.7.1）：必須のプロパティが自分自身の宣言を参照している |
| `sample-pattern` | サンプル値：`example` のない `pattern` |

`tsurara inspect warning <code>` は、各コードの意味と解決方法を表示する。説明は `WarningKind::explanation` にあり、すべてのコードがこの表にあることをテストで確かめている。

## 7. 出力 {#7-output}

### 7.1 ファイルの構成 {#71-file-layout}

```
src/generated/
  schemas/Pet.ts               スキーマごとに 1 ファイル（型のみ）
  operations/getPetById.ts     操作ごとに 1 ファイル（型、OperationDef、関数）
  webhooks/newPet.ts           webhook ごとに 1 ファイル
  client.ts                    ClientOptions（servers から作った baseUrl の型）
  index.ts                     barrel（ファイルごとに 1 行）
  zod/Pet.ts                   `typescript.validators: zod` のとき（8.7）。barrel には含めない
  query/getPetById.ts          `typescript.query: tanstack` のとき（9.4）。barrel には含めない
  channels/board.ts            `x-event-channels` のイベントチャネルごとに 1 ファイル（8.8）。barrel には含めない
  mocks/                       `typescript.mocks: msw | fetch` のとき（8.9）。barrel には含めない
  _runtime/                    `runtime: vendor` のとき（7.5）：`@tsurara/client` のコピー
```

コールバックは、それを持つ操作と同じファイルに出力する。

オプションで、`tags` レイアウトでは操作をタグごとに1ファイルにまとめ、`single` レイアウトではすべてを1ファイルにまとめる。デフォルトは上の `split` レイアウトである。汎用のクライアント向けの集約マップ（`paths.ts`、`operations.ts`）も出力できるが、デフォルトでは出力しない。

### 7.2 競合を起こりにくくする {#72-making-conflicts-unlikely}

- スキーマと操作はそれぞれ独自のファイルを持つので、別々のAPIへの変更が同じファイルに入ることはない。
- barrelのように複数の項目を並べるファイルは、1行に1項目を決まった順序で書く。
- 出力にタイムスタンプや生成器のバージョンを入れない。
- 同じ定義と設定からは、常にバイト単位で同一の出力ができる。

再生成の際には、生成ファイルのヘッダーを持ち、今回生成されなかった古いファイルだけを削除する。

### 7.3 erasableSyntaxOnlyへの対応 {#73-supporting-erasablesyntaxonly}

- `enum`、`namespace`、コンストラクターのパラメータープロパティを出力しない。
- enumはデフォルトで文字列リテラルのunionにする。オプションで、`export const PetStatus = { ... } as const` と `export type PetStatus = (typeof PetStatus)[keyof typeof PetStatus]` の組を出力できる。
- 型のimportには `import type` を使うので、`verbatimModuleSyntax` でも通る。
- barrelは、型だけのファイルを `export type *` で、値を持つファイルを `export *` で再exportする。
- importの拡張子は `.js`、`.ts`、なしから選べる。デフォルトは `.js` である。Nodeの型ストリッピングで直接実行するなら `.ts` を選ぶ。Nodeは `.js` の指定子を `.ts` ファイルに対応づけないためである。

`erasableSyntaxOnly` を満たすことは、Nodeで直接実行するための必要条件にすぎない。直接実行するには、`.ts` のimport拡張子とNode 22.18以降も必要である（NodeのTypeScriptのドキュメント）。共有パッケージに勧める設定は9.2にある。

### 7.4 操作のファイルの例 {#74-example-operation-file}

```ts
// operations/getPetById.ts
import type { Client, RequestOptions, TransportFailure } from '@tsurara/client';
import type { Pet } from '../schemas/Pet.js';
import type { ErrorModel } from '../schemas/ErrorModel.js';

export type GetPetByIdData = {
  path: { petId: number };
  query?: { expand?: string[] };
};

export type GetPetByIdResponses = { 200: Pet };
export type GetPetByIdErrors = { 404: ErrorModel; default: ErrorModel };

export type GetPetByIdResult =
  | { ok: true; kind: 'success'; status: 200; data: Pet; response: Response }
  | { ok: false; kind: 'http'; documented: true; status: 404; error: ErrorModel; response: Response }
  | { ok: false; kind: 'http'; documented: true; status: number; error: ErrorModel; response: Response }
  | TransportFailure;

export const getPetByIdDef = {
  v: 1,
  id: 'getPetById',
  method: 'GET',
  path: '/pet/{petId}',
  tags: ['pet'],
  params: {
    path: { petId: {} },
    query: { expand: { style: 'form', explode: true } },
  },
  responses: {
    200: { parseAs: 'json' },
    404: { parseAs: 'json' },
    default: { parseAs: 'json' },
  },
} as const;

/** Find pet by ID */
export function getPetById<Ctx>(
  client: Client<Ctx>,
  options: GetPetByIdData & RequestOptions<Ctx>,
): Promise<GetPetByIdResult> {
  return client.request<GetPetByIdResult>(getPetByIdDef, options);
}
```

- 関数の第1引数はクライアントで、常に明示的に渡す。暗黙のグローバルなクライアントはない。共有パッケージの中のグローバルな状態は、アプリやリクエストの間で設定を混ぜてしまうからである。
- 必須のパラメーターがない操作では、`options` を省略できる。
- リクエストの本文に複数のメディアタイプがある操作では、`Data` 型の `body` と `contentType` を判別付きunionで結び付ける。定義の最初のメディアタイプがデフォルトで、そのメンバーだけが `contentType` を省略できる。本文が省略可能なら、各メンバーは `body` を省略できる。`body` を省略すると、`contentType` を指定していても本文は送らない。

  ```ts
  export type UploadPetData =
    | { contentType?: 'application/json'; body: PetWritable }
    | { contentType: 'multipart/form-data'; body: UploadPetForm };
  ```
- 関数の本体は `client.request(def, options)` を呼ぶだけである。パスの展開、クエリのシリアライズ、リクエストの本文の組み立て、レスポンスの解析は、`@tsurara/client` がOperationDefを読んで行う。
- `OperationDef` は値を持つが、ただのオブジェクトリテラルなので、erasableSyntaxOnlyに違反しない。
- OperationDefには `satisfies OperationDef` を付けない。`isolatedDeclarations` が型を推論できなくなる（TS9010）からである。形は `client.request` のパラメーターの型で検査される。

### 7.5 ランタイムの同梱 {#75-vendored-runtime}

`runtime: vendor`（デフォルトは `package`）は、ランタイムのソースのコピーを出力に書き込み、生成コードはパッケージの代わりにそのコピーをimportする。ランタイムのパッケージを追加できないプロジェクト（依存関係の方針が厳しい、オフラインでビルドする、依存関係をアセットとして同梱するゲームエンジン）のためのものである。コピーは `spec/conformance` を通るソースそのもので、シリアライズはランタイムに残る。

| 言語 | コピー | 生成コードからの参照方法 |
|---|---|---|
| TypeScript | `_runtime/`（ターゲットのimportの拡張子付き） | `@tsurara/client` の代わりに相対指定子 |
| Python | サブパッケージ `_runtime` | 相対import（`from .._runtime import Client`） |
| Rust | モジュール `runtime`（`mod.rs` の `pub mod runtime;`） | 必須の `rust.runtimeCrate`：利用者のクレートにおけるモジュールのパス（`crate::api::runtime`） |
| Go | 出力のパッケージ `internal/tsurara` | `go.runtimeModule`。指定がなければ最も近い `go.mod` から求める |

- ソースはビルド時にバイナリに埋め込む（`tsurara-runtimes`。`runtimes/` を対象とするビルドスクリプトで、テストは除く）。そのためコピーは常に生成器と一致する。
- コピーしたファイルはすべて、生成ファイルの目印と、MITライセンスを示す行で始まる。古いファイルの削除と `tsurara check` は、生成コードと同じくコピーも対象にする。編集すれば `check` が失敗し、`generate` が元に戻し、vendoringをやめれば削除される。ランタイムのバージョンの目印は書かず、`check` のバージョンの検査も適用しない（コピーそのものがそのバージョンだからである）。
- コピーに手を加えるのは、言語が必要とする箇所だけである。TypeScriptの相対importにはimportの拡張子を付ける。Rustでは、`crate::`、`$crate::`、`tsurara_client::` のパスを `runtimeCrate` にし、`#[macro_export]` のマクロをパスで再exportし、cargoのフィーチャーを解決し（クライアントの層は操作があるときだけ、モックのトランスポートは `rust.mocks` のときだけ `cfg(any(test, feature = "mocks"))` の下に置く）、ランタイムがRust 1.85を保っているので `clippy::collapsible_if` を許可する。Goでは、ランタイムと `tsuraratest` のimportをvendorしたパスにする。
- サードパーティの依存関係はコピーしない。`generate` がそれを示す（Pythonはhttpx、Rustはserde、serde_json、indexmap、操作があればtokio、fastrand、httpdate、reqwest。Rustでは `mod.rs` にも書く）。TypeScriptとGoには依存関係がない。
- `operations: false` では、Rustは型の層だけをコピーする（18.9）。TypeScriptは、ランタイムをimportするファイルがなければ何もコピーしない。
- コピーはターゲットごとに持つ。複数のターゲットで共有する置き場所は用意しない。1つのリポジトリの中でランタイムを共有するターゲットには、パッケージのほうが向いている。

## 8. ランタイムライブラリ（@tsurara/client） {#8-runtime-library-tsuraraclient}

### 8.1 クライアントの作成 {#81-creating-a-client}

```ts
import { createClient } from '@tsurara/client';

const api = createClient<{ traceparent?: string }>({
  baseUrl: 'https://api.example.com',
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  middleware: [tracing(), logging(logger), retry({ max: 2 })],
  onResult: (result, req) => metrics.record(req.operation.id, result.kind),
  fetch: customFetch,
  timeout: 10_000,
});
```

| オプション | 説明 |
|---|---|
| `baseUrl` | 接続先 |
| `headers` | すべてのリクエストに付けるヘッダー。非同期関数も使える |
| `middleware` | リクエストとレスポンスに割り込む関数（8.4） |
| `onResult` | 最終的なResultを受け取る観測用のフック（8.4） |
| `onUndocumentedStatus` | 定義にないステータスのレスポンスで呼ばれる観測用のフック（8.2） |
| `auth` | 操作のセキュリティスキームに対する認証情報を返す（後述） |
| `fetch` | fetchの実装。テストで差し替えたり、サーバーで使ったりするため |
| `timeout` | デフォルトのタイムアウト（ミリ秒） |
| `validate` | JSONのレスポンスの本文を検証する。`validateResponses(schemas)` でStandard Schemaのスキーマから作れる（8.7） |

ここでも `RequestOptions` でも、省略可能なオプションは `undefined` を「指定なし」として受け付ける。そのため `exactOptionalPropertyTypes` のもとでも条件付きで指定できる（`onUndocumentedStatus: dev ? log : undefined`）。

認証は定義に従う。各OperationDefは操作のセキュリティ要件（操作自身の `security`、またはルートのもの）を、各認証情報を置くのに必要な情報とともに持つ。`auth(scheme, info)` はスキームに対する認証情報か `undefined` を返す。クライアントは、すべてのスキームに認証情報がそろう最初の選択肢を使い、スキームに応じて認証情報を置く。APIキーはそのヘッダー、クエリパラメーター、Cookieに、`http` の `bearer`、OAuth 2、OpenID Connectのトークンは `Authorization: Bearer` に、`basic` は `Authorization: Basic` に置く（フックは `user:password` を返し、クライアントがエンコードする）。`security: []` の操作は何も送らず、そろわない選択肢は飛ばす。`mutualTLS` はトランスポート（`fetch`）の役目である。生成コードはスキーム名のunion `SecuritySchemeName` をexportする。トークンの取得（OAuthのフロー）はクライアントの外に置き、フックからそれを行う処理を呼べばよい。

型パラメーター `Ctx` は呼び出しごとに渡すcontextの型で、SSRでリクエストごとのトレースIDを渡すような用途に使う。モジュール拡張（module augmentation）は使わないので、アプリごとに異なる型を持っても互いに干渉しない。

`signal`、`headers`、`timeout`、`baseUrl`、`context` は、`RequestOptions` で呼び出しごとに上書きできる。

### 8.2 Result {#82-result}

`client.request` が返すPromiseは決してrejectされない。HTTPのエラー、通信の失敗、中断はすべてResultの値として返す。

| `kind` | `ok` | 条件 | 主なフィールド |
|---|---|---|---|
| `success` | true | 定義にある成功のステータスが返った | `status`、`data`、`response` |
| `http` | false | エラーのステータス、または定義にないステータスが返った。定義にないステータスは `documented: false` と `error: unknown` になる。ほかの成功のステータスが定義されているときは、定義にない2xx（200だけを定義した操作での201など）もここに入る | `status`、`error`、`documented`、`response` |
| `network` | false | fetch自体が失敗した（DNS、接続の切断、CORSなど） | `cause` |
| `timeout` | false | `timeout` で指定した時間を超えた | `cause` |
| `aborted` | false | 呼び出し側の `signal` で中断された | `cause` |
| `parse` | false | 本文の解析に失敗した。Content-Typeが想定と異なる場合を含む | `cause`、`response`、`contentType` |
| `unexpected` | false | ミドルウェアなど利用者のコードが例外を投げた | `cause` |
| `validation` | false | `validate` が成功の本文か定義にあるエラーの本文に問題を見つけた（8.7） | `status`、`value`、`issues`、`response` |

内部では、`timeout` も `aborted` もAbortSignalによる中断である。それでも分けているのは、ログやリトライで扱いが異なるからである。`unexpected` を `network` と分けているのも同じ理由で、利用者のコードのバグと通信の失敗を混ぜないためである。

`validation` は最初から予約しておく。後から検証を追加しても、`kind` で分岐する利用者のコードを壊さないためである。

定義にないステータスは、サーバーが成功のつもりで返したものでも失敗になる。そのためサーバーと定義のずれ（定義では200なのにサーバーが201を返す）は、予期しない失敗としてしか現れない。`onUndocumentedStatus({ operation, context, status, response })` は、そうしたレスポンスのたびに `onResult` より前に呼ばれる。開発中にこれをログに出せば、ずれが起きた場所で見えるようになる。`onResult` と同じく、このフックが投げた例外はResultを変えない。

`default` のレスポンスは `status: number` の型を持つ。TypeScriptは「404以外の数値」を表せないので、`status === 404` で絞り込んでもunionに `default` のメンバーが残る。実際には、定義に書かれたステータスを先に確かめれば問題にならない。

### 8.3 unwrapとApiError {#83-unwrap-and-apierror}

例外のほうが書きやすい場面のために `unwrap(result)` がある。成功なら `data` を返し、失敗なら `ApiError` を投げる。`ApiError` は `Error` を継承し、`kind`、`status`、`operationId`、元の `result`、`cause` を持つ。スタックトレースも保たれる。

`ApiError` は操作のResult型を型パラメーターに取る。`ApiError<GetPetResult>` は `result` をその操作の失敗に絞り込むので、`result.kind === 'http' && result.documented` で、定義にあるエラーの本文にスキーマの型が付く。投げられた値は静的な型を持てないので、これはTanStack Queryの `useQuery<Pet, ApiError<GetPetResult>>` のように、操作がわかっている場所で使う。デフォルトの `ApiError` は、`error: unknown` の汎用の失敗を持つ。

`new ApiError(result)` は、`unwrap` と同じく `result` を返した操作の名前を記録する。

`isHttpError(result, 422)` は、Resultをそのステータスの定義にあるエラーに絞り込む。そのステータスが単独で定義されていればそのメンバーに、そうでなければ `status` をそのステータスにした `default`（または範囲）のメンバーに絞り込む。`status` だけを確かめても絞り込めないのは、定義にないステータスのメンバーが `status: number` を持つからである。

Resultでない値を渡すと、代わりに `TypeError` を投げる。よくあるのは `await` の付け忘れ（`unwrap(getPet(api, …))`）である。型検査はこれを拒否するが、型ストリッピングだけで実行するコードでは拒否されないので、エラーメッセージで呼び出しをawaitするよう伝える。

### 8.4 ミドルウェアとonResult {#84-middleware-and-onresult}

ミドルウェアは `(req, next) => Promise<Response>` の形の関数である。ミドルウェアは外側のものから呼ばれ、`next` で内側に制御を渡す。`req.operation` を通して、操作の `id`、`method`、パスのテンプレート（`/pet/{petId}`）、`tags` を参照できる。これらはトレースのスパン名やログのキーに使う。

ミドルウェアは例外を投げてもよい。`@tsurara/client` が外側で捕まえ、Resultに変える。

`onResult` は、すべての処理が終わったあとのResultを受け取る。ログやメトリクスでは、HTTPより前の失敗（タイムアウトなど）も含めた最終的な結果がほしいことが多い。ミドルウェアだけではそれを捕まえにくいので、別のフックにしている。

どちらのランタイムも、同じデフォルトでリトライを同梱している。`@tsurara/client` では `retry()` ミドルウェア、`tsurara-client` ではクライアントのオプション `retry=Retry()` である。べき等なメソッド（GET、HEAD、OPTIONS、PUT、DELETE）についてだけ、通信の失敗とステータス408、429、500、502、503、504を最大2回リトライする。待ち時間は、レスポンスに `Retry-After`（秒数かHTTPの日付）があればそれ、なければfull jitterの指数バックオフ（リトライごとに倍になる100ミリ秒を上限とするランダムな待ち時間）で、どちらも30秒（`maxDelay` / `max_delay`）が上限である。クライアントの `timeout` はすべての試行をまとめて対象にする。その時間を過ぎてから終わる待ちは始めずに最後のレスポンスを返し、タイムアウトや中断のあとは何もリトライしない。リクエストは試行のたびに組み立て直し、もう一度送れないストリームの本文はリトライしない。

`bindClient(client, { getPet, listPets })` は、クライアントを第1引数に束縛した関数を返す（`api.getPet(options)`）。束縛した関数の `context` の型はクライアントから決まる。

### 8.5 シリアライズとレスポンスの解析 {#85-serialization-and-response-parsing}

リクエストとレスポンスの変換は、すべて `@tsurara/client` がOperationDefに基づいて行う。生成コードには変換の処理を含めない。変換の処理がライブラリの1か所にあれば、まとめてテストできる。

- パスとクエリ：OpenAPIの `style`（form、spaceDelimited、pipeDelimited、deepObjectなど）と `explode` に従う。パスパラメーターがない場合や、値によってパスのセグメント全体が空、`.`、`..` になる場合は、送信前に失敗する（`kind: 'unexpected'`）。URLの解析はドットセグメントを取り除くので、そうしなければ `/users/{id}/profile` の `id: '..'` は `/profile` を呼んでしまう。値は `%` も含めてパーセントエンコードするので、`%2e` のような値は `%252e` として送られる。パスのテンプレートは `/` で始まらなければならない。テンプレートはベースURLに文字列として付け足すので、`https://api.example.com` のあとの `@evil.example/x` や `:8443/x` はホストやポートを変えてしまう。モデルは先頭に `/` のないパスのキーを `invalid-definition` の警告とともに除き（webhookの名前やコールバックの式はパスではない）、どのランタイムもそうしたOperationDefを送信前に拒否する（`unexpected`）。
- リクエストの本文：JSON、`multipart/form-data`、`application/x-www-form-urlencoded`、バイナリに対応する。マルチパートは `encoding` に従う。配列は要素ごとに `append` し、オブジェクトは指定されたContent-Typeでシリアライズする。
- レスポンス：生成器がメディアタイプから `parseAs` を決め、OperationDefに書き込む。

次の表は上から確かめ、最初に一致した行で決まる。

| 順 | メディアタイプとスキーマ | parseAs | dataの型 |
|---|---|---|---|
| 1 | 本文なし（204など） | `none` | `undefined` |
| 2 | 項目のスキーマ（3.2の `itemSchema`、または `x-itemSchema`）を持つ `text/event-stream` | `events` | `AsyncIterable<{P}Event>` |
| 2a | 項目のスキーマを持つJSON Lines（`application/jsonl`、`application/x-ndjson`）とJSON text sequences（`application/json-seq`） | `jsonLines`、`jsonSeq` | `AsyncIterable<{P}Item>` |
| 2b | そのほかのシーケンシャルな形式（上のもので項目のスキーマがないもの） | `stream` | `ReadableStream<Uint8Array>` |
| 3 | `application/json`、`*/*+json` | `json` | JSONの文脈でのスキーマの型（6.4）。`type: string` に `format: binary` や `contentMediaType` があっても `string` のままで、`blob` には変えない |
| 4 | `text/*` などの文字列の形式 | `text` | `string` |
| 5 | `*/*` や `application/*` などのワイルドカードで、スキーマがバイナリ（6.4：`format: binary`、または `contentEncoding` のない `contentMediaType`） | `blob` | `Blob` |
| 6 | ワイルドカードで、スキーマがバイナリでない | `auto` | スキーマの型 \| `string` \| `Blob` |
| 7 | それ以外（`application/octet-stream`、画像など） | `blob` | `Blob` |

`auto` では、解析の方法をレスポンスの実際のContent-Typeで決める。JSONのメディアタイプならJSONとして解析し、`text/*` なら文字列として、それ以外なら `Blob` として読む。どれが返るかは実行時までわからないので、dataの型はありうる値すべてのunionにする。こうすれば、定義が許す値に誤った型を付けずに済む。ワイルドカードには警告を出し、実際にはJSONしか返さないAPI向けに、設定でワイルドカードをJSONとして扱えるようにしている（031での作業、016での設定）。JSONとして扱う操作がJSONでないContent-Typeを返したら、結果は `kind: 'parse'` になる。

Server-Sent Events：項目のスキーマは、1つのイベントを、プロパティ `event`、`data`、`id`、`retry` を持つオブジェクトとして記述する。その `oneOf` か `anyOf` の各エントリが1つのイベントで、キーワードの隣に書かれたプロパティで補われる。それらがなければ、スキーマそのものが唯一のイベントである。`{P}Event` はイベントのunion `{ event: 'note'; data: Note; id?: string; retry?: number } | ...` なので、`switch (e.event)` で `data` が絞り込まれる。`event` はそのイベントの名前（`event` の `const` か `enum`）のunionで、名前のないイベントでは `string` になり、ほかのあらゆる名前を表す。タグ付きunionを持つ言語では、イベントは `event` でタグ付けされた、操作にちなんだ名前（`StreamNoteEvent`）のunionで、名前のないイベントはそのデフォルトのメンバーになる。スキーマにJSONの `contentMediaType` がある `data` は、その `contentSchema` の型（なければ `unknown`）を持ち、ランタイムが解析する。それ以外の `data` は `string` である。OperationDefは、どのイベントを解析するかを示す。JSONであるイベントの名前（`event` の `const` か `enum`）を並べ、定義に挙がっていないイベントがテキストのままになるようにする。`jsonEvents: true` は、すべてのイベントがJSONで、そのどれかに名前がない（ほかのあらゆる名前を表す）場合に限る。テキストのイベントの中にある、JSONのデータを持つ名前のないイベントは、実行時に区別できないので、その `data` は `string` のままにして警告を出す。データのないイベントは配送されない（`EventSource` と同じ）ので、`data` は常に必須である。`id` と `retry` は、`required` に挙がっていなければ省略可能である。ランタイムはHTML標準のとおりにストリームを解析し、1回だけ読める非同期イテラブルを渡す。ループを抜けるとストリームはキャンセルされる。Resultはすでに返しているので、イベントのJSONが不正なら反復の中で例外を投げる。定義に挙がっていないイベントは、`data` が文字列のままそのまま届く。セマンティックモデルは本文の種類を `stream` のままにして、その隣にイベントを持つ（`MediaContent::events`）。tsurara-lowerはそうしたレスポンスに印を付け（`OperationTypes::sequences`）、1項目の型を持たせる。どのランタイムもイベントとJSONの項目を読む。`@tsurara/client` とPythonは（非同期の）イテレーターを、Rustは `next().await` で読む `Items<T>` を、Goは `All()` で読む `*Items[T]` を渡す。タイムアウトは送信とヘッダーまでを対象にし、項目は対象にしない。Python、Rust、Goは、サーバーが書くそばから項目が届くように、すべてのレスポンスをストリーミングのトランスポートで読む。`@tsurara/client` の `parseEventStream` は、スキーマのないバイト列のストリームを同じ方法で読む。

JSON LinesとJSON text sequences：項目のスキーマはJSONの文脈での1項目のスキーマで、`{P}Item` がその型である。ランタイムは、1行に1つのJSONテキスト（`jsonLines`。空行は読み飛ばし、CR、LF、CRLFが行を終える）か、U+001Eで始まるレコードごとに1つのJSONテキスト（`jsonSeq`。最初の区切りより前のテキストと空のレコードは読み飛ばす）を読み、JSONが不正なら反復の中で例外を投げる。モデルは本文の種類を `stream` のままにして、その隣に項目の型を持つ（`MediaContent::items`）。

リクエストの本文も、メディアタイプとスキーマに従って組み立てる。

- JSONのメディアタイプでは、JSONの文脈でのスキーマの型の値をJSONとして送る。`format: binary` や `contentMediaType` があっても、値をそのまま送る方式には切り替えない。
- バイナリの本文（`application/octet-stream` など）と、スキーマがバイナリのワイルドカードでは、値をそのまま送る。ワイルドカードでは `Blob` の `type` がContent-Typeになり、`type` がなければContent-Typeを設定しない。
- スキーマがバイナリでないワイルドカードでは、値をContent-Type `application/json` のJSONとして送る。生成器は警告を出す。
- `Blob`、`ArrayBuffer`、`Uint8Array`、`ReadableStream`、`FormData` は、決して `JSON.stringify` に渡さない。これらがJSONの本文として渡されたら、データを黙って `{}` にするのではなく、`kind: 'unexpected'` のResultを返す。

### 8.7 レスポンスの検証 {#87-response-validation}

検証は任意で、使わなければ何も変わらない。`@tsurara/client` は、Zod（3.24以降、4）、Valibot、ArkTypeが実装している[Standard Schema](https://standardschema.dev)のインターフェース（`~standard.validate`）を通して検証するので、どれにも依存しない。`validate` オプションは、解析済みの本文と操作、ステータス、メディアタイプを受け取り、問題を返すか何も返さない関数である。`validateResponses(schemas)` は、操作ID、ステータス（`2XX` と `default` も）、メディアタイプごとのスキーマからそれを作る。呼び出しごとに別のバリデーターや `validate: false` を渡せる。検証するのは、JSONとして読んだ成功の本文と定義にあるエラーの本文である（テキスト、バイナリ、ストリームは対象外）。問題のある本文は `{ ok: false, kind: 'validation', status, value, issues, response }` になり、`unwrap` はその種類の `ApiError` を投げる。非同期のバリデーターはawaitする。

`typescript.validators: zod` はZod 4のスキーマを出力する。`zod/Pet.ts` は `PetSchema: z.ZodType` をexportし（`isolatedDeclarations` のために型注釈を付け、参照は `z.lazy` を通すので、循環やモジュールの順序は問題にならない）、`zod/operations.ts` は `validateResponses` 向けの `responseSchemas` をexportする。型と呼び出し関数はZodのファイルを決してimportしないので、検証しないアプリは `zod` を読み込まない。

スキーマが検査するのは、型、`enum`、`const`、フォーマット `uuid`、`email`、`date-time` である。`typescript.validatorConstraints: true` にすると、定義の制約を加える。制約はモデルのドキュメントのタグから `Doc::constraints()` で読む。文字列の `minLength`、`maxLength`、`pattern`、数値の `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`（3.0の真偽値は境界に畳み込む）、`multipleOf`、配列の `minItems`、`maxItems`、`uniqueItems`（JSONテキストによる絞り込み）、オブジェクトの `minProperties`、`maxProperties`、そしてフォーマット `uri`、`ipv4`、`ipv6`、`date`、`time`、`duration` である。nullを許す値では、null以外のメンバーに適用する。サーバーは制約に反する値を害なく送ることが多い（長い説明、オフセットのない日時）ので、これはデフォルトでは無効である。有効にすると、そうしたレスポンスは `kind: 'validation'` になる。このオプションは、フォームなどの入力にスキーマを使い回すアプリ向けである。`pattern` は仕様上ECMA-262の正規表現だが、ほかのエンジン向けに書かれた定義もある。各パターンは生成時にECMAScriptの規則と `u` フラグでコンパイルし（`regress` クレート）、コンパイルできないものは、読み込み時に例外を投げるモジュールにする代わりに、`unsupported` の警告を出して省く。`$ref` の制約と、配列の中の配列の項目の制約は、モデルがスキーマのドキュメントを保持している場所（宣言とプロパティ）で適用する。入れ子の項目のスキーマは型だけを保持する。リクエストは、まだ送信前に検証しない。

```ts
import { createClient, validateResponses } from '@tsurara/client';
import { responseSchemas } from './generated/zod/operations.ts';

const api = createClient({ baseUrl, validate: validateResponses(responseSchemas) });
```

スキーマが検査するのはTypeScriptの型が表すことで、定義を超えることは決して検査しない。

| スキーマ | Zod |
|---|---|
| `string`、`integer`、`number`、`boolean`、`null` | `z.string()`、`z.number().int()`、`z.number()`、`z.boolean()`、`z.null()` |
| `format: uuid`、`email`、`date-time` | `z.uuid()`、`z.email()`、`z.iso.datetime({ offset: true })`。ほかのフォーマットはただの文字列 |
| `enum`、`const` | `z.enum([...])`（文字列）か `z.literal` のunion。TypeScriptの型と同じく閉じている（18.5.3） |
| オブジェクト | 省略可能なプロパティに `.optional()` を付けた `z.object({...})`。挙がっていないプロパティは許す。`additionalProperties` は `.catchall(...)` に、プロパティのない `false` は `.strict()` になる |
| 配列、タプル | `z.array(...)`。固定長のタプルは `z.tuple([...])`、それ以外のタプルは `z.array(z.unknown())` |
| `oneOf`、`anyOf`、discriminator | `z.union([...])`（`oneOf` の排他性は検査しない） |
| `allOf` | `z.intersection(...)` |
| `$ref` | `z.lazy(() => PetSchema)` |
| readOnly / writeOnly | レスポンスの型（writeOnlyのプロパティを除く） |
| 外部の型（`x-tsurara-type`、型マッピング）、バイナリ | `z.unknown()`（外部の型には警告を出す） |
| 文字列と数値の制約（`minLength`、`pattern`、`minimum` など） | まだ検査しない。型もこれらを近似している |

Zodのスキーマは型検査のコストが高い。GitHub、Stripe、Kubernetes、OpenAIの出力に対する `tsc` は、Zodのスキーマがあると0.1〜0.2秒ではなく0.9〜1.4秒かかり、型のインスタンス化は1.3万〜3.6万回ではなく130万〜270万回になる（TypeScript 7.0.2、2026-11-11）。コーパスのテストは、Zodの出力も `tsc` で検査する。PythonのランタイムはTypeDefで値をデコードし、それだけで型の合わない本文を拒否するので、別の検証オプションはない。

### 8.8 イベントチャネル {#88-event-channels}

レスポンスではないメッセージもある。サーバーはコミットのあとにハブ（Mercure）へ更新を発行し、ブラウザは別のサーバーであるハブから `EventSource` でそれを受け取る。`x-event-channels` は、文書のルートでそれらを記述する。

```yaml
x-event-channels:
  board:
    summary: Updates every participant of a board may see
    channel: 'board/{boardId}'         # appended by the app to the deployment's topic prefix
    parameters:
      boardId: { type: string }
    private: true                      # the hub requires a subscriber claim; informational
    content:
      application/json:
        schema: { $ref: '#/components/schemas/BoardEvent' }   # oneOf with a discriminator on `type`
```

ワイヤーフォーマット：1つのメッセージは1つのJSON文書（`MessageEvent.data`）である。イベントの種類はSSEの `event` フィールドではなく、その中のプロパティ（`type`。値は `card.added` など）なので、すべてのメッセージが `onmessage` に届き、同じ形式がWebSocketでも使える。`seq` のような順序のためのデータはペイロードのプロパティである。SSEの `id` はハブのもの（`Last-Event-ID`）のままにする。

モデルはこれらを `Model::channels`（名前、ドキュメント、テンプレート、パラメーター、ペイロードの内容）としてwebhookのあとに持ち、`channel` の名前要求を出す。パラメーターのないテンプレートの変数は文字列になり、テンプレートにないパラメーターは捨てる。どちらも `invalid-definition` の警告を出す。TypeScriptバックエンドはチャネルごとに `channels/{name}.ts` を書く。中身は、`{Channel}Message`（ペイロードの型。JSONのメディアタイプならその型、テキストなら `string`、どちらもなければ `unsupported` の警告を出して `unknown`）、`{Channel}TopicParams` と `{channel}Topic(params)`（各値をパーセントエンコードする）、`{channel}ChannelDef`、そして `decode{Channel}(data, options?)` である。最後のものは `@tsurara/client` の `decodeMessage` を呼び、`MessageResult` を返す。`MessageResult` は `{ ok: true, value }`、`{ ok: false, kind: 'parse', data, cause }`、`{ ok: false, kind: 'validation', value, issues }` のいずれかである。`typescript.validators: zod` では、`zod/channels.ts` が `validateChannels` 向けの `channelSchemas` をexportする。`validateChannels` は同期的に検証する（非同期のスキーマは例外を投げる）。デコーダーは文字列を受け取るので、`EventSource`、`fetch` 上の `parseEventStream`、WebSocketのどれでも使える。接続はクライアントが持つものではない。Zodのスキーマは `z.ZodType` の型注釈のままにする。Zodが推論する省略可能なプロパティは `exactOptionalPropertyTypes` を満たさないので、デコーダーは検証済みの値をメッセージの型として信頼する。ほかの言語は今のところチャネルを無視する。`webhooks` をチャネルとして読むことはしていない。

### 8.9 モック {#89-mocks}

`typescript.mocks: msw | fetch` は、ほかのファイルからimportされない `mocks/` を書く。中身は次のとおりである。`mock{Name}()` を持つ `mocks/schemas/{Name}.ts`（18.7.1のサンプル値。プロパティを持つオブジェクトは `overrides?: Partial<T>` を受け取る。値が自分自身のサンプルである名前付きの型はそのファクトリで作る。サンプルは循環を切るので、循環があっても有限になる）。`{Op}MockResponse`（定義にあるステータスと本文の型のunion。コードはリテラルで、範囲と `default` は `number`）と `{function}Handler(response?, options?)` を持つ `mocks/operations/{function}.ts`。レスポンスをそのメディアタイプに変換する処理を持つ `mocks/support.ts`。すべての操作が定義にある最初の成功レスポンスで応答する `mocks/index.ts`。`msw` では、ハンドラーはMSW 2と3の `HttpHandler` である（`*/pets/:petId`。セグメントの途中にパラメーターがあれば正規表現、MSWにヘルパーのないメソッドにはメソッドを確かめる `http.all`）。`fetch` では、`mockFetch` 向けのルートである（18.9）。

ファクトリはフィールドごとに型検査する。ただし、サンプルがTypeScriptの型に従わないかもしれない構造を型が含む場合は除く。判別付きunion（実在の定義には、マッピングがメンバーの定数と矛盾していて `never` になるものがある）、継承したタグ、`allOf` の交差型、外部の型である。それらの値はJSONとして書き、型アサーションする（`as unknown as T`）。ハンドラーでのリクエストの検証と、項目ごとにストリームで返す応答は生成しない。

### 8.6 配布と互換性 {#86-distribution-and-compatibility}

`@tsurara/client` はESMのみで、ビルド済みのJSと `.d.ts` を配布する。依存するのは標準の `fetch`、`Request`、`Response`、`AbortSignal` だけである。Nodeはnode_modulesの下の `.ts` に型ストリッピングを適用しないので、このパッケージは配布前にビルドする。

OperationDefの形式はバージョン番号を持つ。生成コードは互換性のある `@tsurara/client` のバージョンの範囲を記録し、`tsurara check` はインストール済みのバージョンとの不一致を検出する。これで、生成器とライブラリを別々に更新してずれたときに気づける。

## 9. pnpm workspaceでの使い方 {#9-using-it-in-a-pnpm-workspace}

### 9.1 構成 {#91-layout}

```
packages/openapi/                  共有パッケージ
  package.json                     name: @acme/openapi, "sideEffects": false
  tsurara.config.yaml
  src/generated/...                tsurara の出力
  src/index.ts                     生成結果と @tsurara/client を再 export
apps/app-1/src/api.ts              app-1 のクライアント
apps/app-2/src/api.ts              app-2 のクライアント
```

生成は `packages/openapi` で1回だけ行う。app-1とapp-2はそれぞれ自分のクライアントを作り、生成された関数に渡す。ログ、トレース、ヘッダーの違いはクライアントの設定にあるので、生成結果は個々のアプリについて何も知らない。

| カスタマイズの種類 | 場所 | 例 |
|---|---|---|
| 生成時（すべてのアプリで共通） | `packages/openapi/tsurara.config.yaml`、プラグイン | 型マッピング、定義へのパッチ、タグによる絞り込み |
| 実行時（アプリごと） | 各アプリの `createClient()` | baseUrl、認証ヘッダー、ログ、トレース、リトライ、fetchの差し替え |

### 9.2 共有パッケージの扱い {#92-handling-the-shared-package}

`packages/openapi` はビルドしない。`package.json` の `exports` が `.ts` ファイルを直接指す内部パッケージである。バンドラー（Viteなど）を使うアプリとNodeで直接実行するアプリの間で1つの生成結果を共有するために、次の設定を勧める。

- 生成の設定でimportの拡張子を `.ts` にする（7.3）。Nodeは `.js` の指定子を `.ts` に対応づけない。
- 共有パッケージをimportするコードをコンパイルするすべてのtsconfigで、`allowImportingTsExtensions`（`noEmit` とともに）か `rewriteRelativeImportExtensions` を有効にする。各アプリだけでなく、テスト用のパッケージやツールも対象である。生成ファイルは `.ts` の拡張子で互いにimportし、TypeScriptはそれらをimportする側のプロジェクトの一部として検査する。そのため設定のないプロジェクトは、自分のコードではなく共有パッケージのファイルの中でTS5097（「An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled」）を報告する。それができない場合は、`.js` のimport拡張子で生成し、公開するパッケージと同じく共有パッケージを `.js` と `.d.ts` にビルドする。Nodeで実行するアプリはビルドしたファイルを使う。
- Nodeで直接実行するアプリにはNode 22.18以降を使う。pnpmのシンボリックリンクは実際のパスに解決されるので、Nodeの「node_modulesの下では型ストリッピングをしない」という制約は当てはまらないはずである。
- 共有パッケージの `exports` には、barrelのほかにサブパス `operations/*` と `schemas/*` を用意する。

```json
{
  "name": "@acme/openapi",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./src/index.ts",
    "./operations/*": "./src/generated/operations/*.ts",
    "./schemas/*": "./src/generated/schemas/*.ts"
  }
}
```

この構成は、1つのパッケージを共有する3つのアプリで確かめた。Viteを使うReact（開発サーバーと本番ビルド。厳格なtsconfigとbarrelからのimport）、Viteを使う素のTypeScript（緩いtsconfig、サブパスからのimport、独自のミドルウェアと `retry()`）、Node 26の型ストリッピングで実行するCLI（`nodenext`）である。生成ファイルを編集するとViteのページが再読み込みされ、Nodeはpnpmのシンボリックリンクを通してパッケージを実行し、tree-shakingはbarrelを経由していても使われない操作を除き、ワークスペースの `@tsurara/client` は1つになる。`examples/pnpm-monorepo` はリポジトリの中のこの構成で、CIで確かめている。使う操作だけがバンドルに残るViteのアプリと、ローカルのサーバーに対するエンドツーエンドのテストを持つNodeのアプリがある。サンプルのNext.jsのアプリ（App Router、サーバーコンポーネントとクライアントコンポーネント）は、`transpilePackages` なしでTurbopackでもwebpackでもビルドできる。Next.js 16.4は、リンクされたワークスペースのパッケージの `.ts` ファイルをコンパイルする。そのtsconfigには、ほかの利用側と同じく `allowImportingTsExtensions` が必要で、これがないと `next build` が共有パッケージの中でTS5097で失敗する。NodeとTypeScriptの最低バージョンは034で確かめ、2つのアプリは024の受け入れ条件として確かめている。

各操作は独自のファイルを持ち、`sideEffects: false` を設定しているので、barrelからimportしても、本番のバンドルには使った関数だけが入る。ただしそれは本番ビルドのtree-shakingの話である。Nodeでの直接実行やViteの開発サーバーでは、barrelが参照するすべてのモジュールを読み込む。`tsc` とエディタも、barrelを経由するとすべてのファイルを読む。操作の多い定義では、サブパスから直接importする。

```ts
import { getPetById } from '@acme/openapi/operations/getPetById';
import type { Pet } from '@acme/openapi/schemas/Pet';
```

barrelを経由した場合と直接importした場合の読み込み時間は、025で測っている。

1つの共有パッケージで複数の定義を生成する（`targets`）ときは、ターゲットごとに独自のサブパス（`@acme/openapi/public`、`@acme/openapi/admin` など）で公開する。各ターゲットの出力は `BaseUrl` や `servers` のような同じ名前を持つので、`export *` で1つのbarrelにまとめると名前が衝突する。

`@tsurara/client` は `packages/openapi` の依存関係にする。アプリは `@acme/openapi` の再exportを通してそれを使うので、ワークスペースの `@tsurara/client` は1つのバージョンにそろう。

### 9.3 アプリのコードの例 {#93-example-app-code}

```ts
// apps/app-1/src/api.ts
import { createClient } from '@acme/openapi';

export const api = createClient<{ traceparent?: string }>({
  baseUrl: import.meta.env.VITE_API_URL,
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  middleware: [tracing(), logging(logger)],
});
```

```ts
// apps/app-1/src/pages/pet.ts
import { getPetById } from '@acme/openapi';
import { api } from '../api';

const r = await getPetById(api, { path: { petId: 1 }, context: { traceparent } });
if (r.ok) {
  render(r.data);
} else if (r.kind === 'http' && r.status === 404) {
  renderNotFound(r.error);
} else {
  reportError(r);
}
```

必要なアプリは、`bindClient(api, { getPetById, ... })` で関数とクライアントを1つのオブジェクトにまとめられる（任意）。

### 9.4 TanStack Query {#94-tanstack-query}

`typescript.query: tanstack` は、操作ごとに `query/{function}.ts` を出力する。ほかのもの（型、関数、barrel）はこれをimportしないので、TanStack Queryを使わないアプリがこれを読み込むことはない。

- 読み取り（`GET`、`HEAD`、`QUERY`）：`{function}QueryKey(data, scope?)` は `[operationId, data]`（スコープがあれば `[{ scope }, operationId, data]`）を返す。これは `DataTag` で型付けされているので、`getQueryData`、`setQueryData`、`cancelQueries` はデータとエラーの型を知っている。`{function}QueryOptions(client, data)` は `{ queryKey, queryFn }` を返し、その `queryFn` はクエリの `signal` を付けて関数を呼び、結果を `unwrap` する。操作に必須の入力がなければ `data` は省略できる（そのときは `{}`）。`data` の代わりに `skipToken` を渡すと、`queryFn` が `skipToken` のオプションを返す（オーバーロード、`{P}SkippableQueryOptions`）。これで、入力がまだわからないクエリも、呼び出し側で条件分岐せずに型付けできる。TanStackの要求どおり、`useSuspenseQuery` はこれを拒否する。`{function}QueryFilter(scope?)` は、その操作のすべてのクエリに一致する `{ queryKey }`（`[operationId]` または `[{ scope }, operationId]`）を `DataTag` 付きで返し、`invalidateQueries`、`cancelQueries`、`removeQueries`、`setQueriesData` に使える。TanStackの `setQueriesData` と `getQueriesData` はフィルターからデータの型を推論しない（5.108でも同じ）。そこで `set{P}QueriesData(queryClient, updater, scope?)` と `get{P}QueriesData(queryClient, scope?)` が、データの型と、その操作のクエリだけに一致するフィルターを付けてそれらを呼ぶ。このフィルターは、データがページの集まりである無限クエリには一致しない。
- そのほかのメソッド：`{function}MutationOptions(client)` は `{ mutationKey: [operationId], mutationFn }`（スコープがあれば `[{ scope }, operationId]`）を返す。その変数は操作の `Data` である。
- エラーは `ApiError<{P}Result>` なので、`onError` と `error` からは定義にあるエラーの本文が見え、`isHttpError(error.result, status)` で絞り込める。データは `SuccessData<{P}Result>` である。`@tsurara/client` の `queryRetry()` は、`retry()` ミドルウェアがリトライするもの（通信の失敗と、両者が共有する `RETRY_STATUSES`）だけをリトライするTanStack Queryの `retry` オプションである。生成されたオプションはこれを設定しない。アプリがリトライの層を1つ選ぶ場所は `QueryClient` のデフォルトだからである。`retry()` は、あきらめたリクエストを何回送ったかを記録し（最後のレスポンスか、最後の通信の失敗の原因をキーにした `WeakMap`。Resultの型は変えない）、`queryRetry()` はそうした失敗をリトライしない。そのため、両方を設定しても2つの層のリトライ回数が掛け合わさることはない。
- 成功がストリームである操作には、どちらも付かない（`streamedQuery` は後で追加するかもしれない）。
- 無限クエリ：OpenAPIはページングを記述せず、`cursor` のような名前から推測もしない。そのため読み取りの操作に `{function}InfiniteQueryOptions(client, data)` と `{function}InfiniteQueryKey(data, scope?)` が付くのは、ページングの方法が書かれているときだけである。書く場所は、操作の `x-tsurara-pagination`（モデルが言語に依存しない `Operation::pagination` に読み込む）か、それより優先される `typescript.infiniteQueries.<operationId>` である。どちらも `param`（パラメーターの `in` と名前、`query.cursor`）、`initial`（最初のページ。なければ最初のリクエストではパラメーターを送らないので、必須のパラメーターには必要）、`next` と `previous`（成功時の本文を指すJSON Pointer。そこに値がないか `null` ならクエリは終わる）を取る。`queryFn` は `pageParam` からパラメーターを設定する。`getNextPageParam` と `getPreviousPageParam` はポインターを読み、`next` がなければ、オプションの型は `getNextPageParam` をアプリに任せる（ポインターでは表せない形式：Linkヘッダー、総数からのオフセット）。`{P}PageParam` はパラメーターの型なので、`data.pageParams` とポインターの値はそれに照らして検査される。操作のどのパラメーターも指さないページング、JSON Pointerでないポインター、読み取りでない操作、存在しない操作IDの設定は、`invalid-definition` の警告になり、その操作には無限クエリのオプションが付かない。

キーの形は、楽観的更新やMercureによるキャッシュの書き換えでアプリが頼る契約である。操作IDのあとにリクエストのデータ（`path`、`query`、`headers`、`cookies`、そして `QUERY` では `body`）が続く。等しい2つのリクエストのキーは等しく、異なる操作のキーが最初の要素を共有することはなく、`['getPet']` は `invalidateQueries` ですべての `getPet` クエリに一致する。ベースURLと認証情報はキーに含めない。`queryScope`（結果を共有してよい範囲を示すJSONの値。テナント、API、環境など。認証情報は決して入れない）を指定して作ったクライアントは、そのオプションのキーの先頭に `{ scope }` を置く。こうすれば、1つの `QueryClient` 上でスコープの異なるクライアントが別々のエントリを持つ。キーはクライアントが手元にない場所（Server-Sent Eventによるキャッシュの書き換え、サーバーレンダリング）でも組み立てるので、キーのファクトリはスコープを引数で受け取る。スコープのないキーは操作ID（文字列）で、スコープのあるキーはオブジェクトで始まるので、両者が一致することはない。`@tsurara/client` の `queryScopeFilter(scope)` は、ログアウトやテナントの切り替えのために、あるスコープのすべてのクエリとミューテーションに一致する。キーにはJSONの値しか入らないので、サーバーで `dehydrate` し、ブラウザで `hydrate` したあとも同じハッシュになる。無限クエリのキーはデータのあとに目印を付け足す（`[..., operationId, data, { infinite: true }]`）。通常のキーと等しくなることはないが、操作のフィルターには一致する。無限クエリのオプションの型では、キーはすべて正確なunionではなく広い `DataTag<QueryKey, InfiniteData<…>>` である。Vueの `useInfiniteQuery` はキーを深くマッピングし、長さの異なるタプルのunionを拒否したからである。`{function}InfiniteQueryKey` は正確な型を保つ。どのミューテーションがどのクエリに影響するかはOpenAPIに書かれておらず、推論もしない。アプリが `onSuccess` で組み合わせる部品が、型付きのキーとフィルターである。

型は `@tanstack/query-core`（`QueryObserverOptions`、`DataTag`、`QueryFunctionContext`、`MutationOptions`）から取る。これはどのアダプターも再exportしているので、フレームワークごとに生成しなくても、Reactやほかのアダプターの `useQuery`、`useSuspenseQuery`、`useQueries`、`prefetchQuery`、`ensureQueryData`、`fetchQuery`、`useMutation` で使える。オプションの型の中のキー（`QueryObserverOptions` のキーの型パラメーター、`queryKey`、`queryFn` のcontext）は、すべて同じ `DataTag` のキーである。1か所でも素のキーにすると、`useQueries`（React）と `useQuery`（Vue）が2つのキーの型を推論し、オプションを拒否した。オプションを展開しても、アダプターの推論は保たれる。`select` が `data` を決め、`initialData` が `data` を定義済みにし、`onMutate` の戻り値が `onError` の型付きのcontextになる。これらは `isolatedDeclarations` のために明示的な型で書いている。ファクトリは呼び出しごとのリクエストのオプションを受け取らない。`RequestOptions` は `headers` と `contentType` をリクエストのデータと共有しているので、呼び出しごとの設定はクライアントのオプションかミドルウェアに置く。TypeScript 5.8と7で、`@tanstack/react-query` と `@tanstack/vue-query` 5.107に対して確かめている。

## 10. 設定ファイル {#10-configuration-file}

### 10.1 例 {#101-example}

```yaml
# packages/openapi/tsurara.config.yaml
extends: ../../tsurara.base.yaml
targets:
  - name: public-api
    input:
      url: https://api.example.com/openapi.json
      headers:
        Authorization: "Bearer ${API_TOKEN}"
    output: src/generated/public
    filter:
      tags: [pet, store]
    naming:
      overrides:
        "#/components/schemas/Error": ApiErrorBody
    language: typescript       # the default
    typescript:
      importExtension: ts
      typeMappings:
        uuid: { type: Uuid, import: { from: ../brand.js, name: Uuid } }
    hooks:
      transformDocument: [node, scripts/patch-spec.mjs]
      afterWrite:
        - [biome, format, --write, "{output}"]
```

形式はYAML、JSON、TOMLのいずれでもよい。エディタの補完のために `schema/tsurara.config.schema.json` を配布する。

言語に依存する設定（`layout`、`importExtension`、`enumStyle`、`aggregateMaps`、`clientModule`、`typeMappings`、`overrides`、`naming.schemaCase`、最終的な識別子の `naming.overrides`）は、ターゲットの `language` の名前のセクションに書く（18.10）。共通の `naming.overrides` は希望する名前で、各言語の規則はそのまま適用される。

### 10.2 extendsとマージ {#102-extends-and-merging}

`extends` は1つ以上のファイルを取る。オブジェクトは深くマージし、配列は置き換える。トップレベルに書いたエントリは、`targets` のすべてのエントリのデフォルトになる。`targets` がなければ、トップレベルが `default` という名前の唯一のターゲットになる。ターゲットが複数あれば、それぞれに重複しない `name` が必要である。

### 10.3 パスと環境変数 {#103-paths-and-environment-variables}

相対パスは、それが書かれた設定ファイルの場所を基準に解決する。`extends` で読み込んだ基底の設定に書かれたパスも、その基底のファイルを基準に解決する。フックのコマンドは、それが書かれた設定ファイルのディレクトリで実行する。

環境変数は `${VAR}` として展開できるので、認証トークンを設定ファイルに書かずに済む。

### 10.4 型マッピングの制約 {#104-constraints-on-type-mappings}

`typeMappings` は、フォーマットごとに出力する型を置き換える。ただし置き換えた型は、JSONから読んだ実行時の値と一致しなければならない。

`date-time` を `Date` に、`int64` を `bigint` にマッピングすると、実行時に値を変換しない限り型が嘘になる。初期のバージョンでは、この2つを設定のエラーにし、デフォルトをそれぞれ `string` と `number` にする。実行時の変換は、変換するパスをOperationDefに持たせれば後から追加できる。

ブランド付きの型（`string & { __brand: 'Uuid' }` など）のように、実行時の値を変えないマッピングは許す。

`typeMappings` と `x-tsurara-type` の `import.from` は次のように扱う（016での作業）。

- `.` で始まる相対パスは、10.3に従い、それが書かれた設定ファイルを基準に解決する。生成器は解決したパスを、その型を使う各生成ファイルからの相対の指定子に書き換える。
- パッケージ名のような相対でない指定子は、そのまま書く。
- 利用者が書いた拡張子は保つ。importの拡張子の設定（7.3）に合わせて機械的に書き換えると、外部モジュールの指定子を壊すおそれがある。Nodeで直接実行するなら、利用者が自分で `.ts` の拡張子を書く。

### 10.5 フィルター {#105-filter}

`filter` は、生成する操作をタグか `operationId` で絞り込む。`tags` と `operationIds` は含め、`excludeTags` と `excludeOperationIds` は除き、除外は包含より優先される。絞り込んだときは、どの操作からも参照されないスキーマは出力しない。共有パッケージ全体で定義の一部しか使わないときに、出力を小さく保てる。アプリごとに使う関数が違うだけなら、アプリごとにターゲットを分けず、本番のバンドルのtree-shakingに任せる（9.2）。ターゲットを分けると同じ型が別々のファイルに重複し、アプリ間で型を共有できなくなる。

## 11. 拡張 {#11-extensions}

tsuraraを拡張する方法は3つある。

1. 宣言的な設定：設定の `typeMappings`、`naming.overrides`、`overrides`（JSON Pointerごとの型）と、定義の `x-tsurara-type` のような拡張フィールド。
2. 外部コマンドのフック。どの言語でも書ける。

   | フック | 入力と出力 |
   |---|---|
   | `transformDocument` | ルートの定義をJSONで標準入力から受け取り、変換した定義を標準出力に返す |
   | `transformModel` | モデルをJSON（18.4.6）で標準入力から受け取り、変換したモデルを標準出力に返す。結果は `semVersion` を保たなければならない |
   | `extend` | `{ language, model, manifest, common, marker }` をJSONで標準入力から受け取り、追加するファイル（`[{ path, contents }]`）を標準出力に返す（11.1） |
   | `transformFiles` | 出力ファイルのリスト（パスと内容）をJSONで受け取り、変換したリストを返す |
   | `afterWrite` | 書き込みのあとに実行する。`{output}` は出力先ディレクトリに置き換えられる |

3. Rustの `Plugin` トレイト。tsuraraをライブラリとして組み込む利用者向けである。外部コマンドのフックも、内部ではこのトレイトの実装である。

外部の型（定義の `x-tsurara-type`、設定の `typeMappings` と `overrides`）は生成コードにそのまま書き込まれるので、各バックエンドはまずそれを検査する。型は、その言語向けに制限した文法の型の式でなければならない。TypeScriptでは、識別子、修飾名、型引数、配列とタプル、括弧、`|`、`&`、エスケープを含まない文字列型とテンプレートリテラル型（各 `${...}` も同じく検査する）、数値である。Pythonでは、名前、ドット付きの名前、添字、`|`、文字列リテラル、数値である。セミコロン、波括弧、`=`、コメント、リテラルの外の改行は拒否する。importの名前は識別子でなければならず、モジュールは引用符やバックスラッシュを含まない指定子（TypeScript）か、ドット区切りのモジュールパス（Python）でなければならない。検査に通らない定義のエントリは `invalid-definition` の警告を出して無視し、スキーマ自身の型を使う。設定のエントリなら設定のエラーである。定義のエントリはデフォルトで尊重する。この文法では型を名指すことしかできず、importは型だけ（TypeScriptでは `import type`、Pythonでは `if TYPE_CHECKING:` の下）なので、何も実行されない。

プラグインはフックする段階（document、model、extend、files）を宣言する。各段階の入力は決まっているので、結果はプラグインの登録順に依存しない。同じ段階の複数のプラグインは、設定に書いた順に適用する。

### 11.1 マニフェストとextendの段階 {#111-the-manifest-and-the-extend-stage}

どのバックエンドも、ファイルとともにマニフェストを返す。マニフェストは生成したものを名前で示し、プラグインは衝突、予約語、`naming.overrides` によって変わる名前を導き直さずに、生成コードを参照するファイルを書ける。

```jsonc
{
  "manifestVersion": 1,
  "language": "typescript",
  // The declarations of the model (`name` is the declaration's id in the model), in model order.
  "types": [{ "name": 3, "identifier": "ErrorModel", "file": "schemas/ErrorModel.ts" }],
  // The operations, then the webhooks.
  "operations": [{
    "operationId": "getPet",
    "kind": "operation",
    "function": { "identifier": "getPet", "file": "operations/getPet.ts" },
    "operationDef": { "identifier": "getPetDef", "file": "operations/getPet.ts" },
    "types": { "data": { "identifier": "GetPetData", "file": "operations/getPet.ts" }, "result": { ... } }
  }]
}
```

`file` は識別子を宣言している出力ファイルである。プラグインはそれを、言語に合わせたimportに変える（TypeScriptでは設定された拡張子付きの相対指定子、Pythonではモジュールパス、Rustでは `crate::…::types` か `…::operations`、Goでは何もしない。出力が1つのパッケージだからである）。`types` の役割は言語ごとに異なる。

| 言語 | 役割 | `operationDef` |
|---|---|---|
| TypeScript | `data`、`responses`、`errors`、`result`、`responseHeaders`、`event`、`item`。webhookでは `request`、`responses` | `{name}Def` |
| Python | `result` | `DEF` |
| Rust | `options`、`body`（本文のメディアタイプが複数あるとき） | なし（private） |
| Go | `options`、`body` | なし（exportしない） |

バックエンドが独自に追加する宣言（引き上げたインラインのスキーマ）は最初のバージョンでは並べず、ファイルがexportするすべての識別子も並べない。プラグインは自分のファイルを専用のディレクトリに置くか（TypeScript、Python、Rust）、独自の接頭辞を使って（Go。1つのパッケージのため）、生成された名前とぶつからないようにする。マニフェストは、モデルと同じく `manifestVersion` でバージョンを示す。

extendの段階は、バックエンドのあと、`transformFiles` の前に実行する。モデル（modelのプラグインを適用したあとのもの）、マニフェスト、共通のオプション、生成ファイルの目印を受け取り、追加するファイルを返す。追加するファイルはそれぞれ目印で始めなければならない。そうすれば古いファイルの削除と `tsurara check` の対象になる。目印のないファイルや、生成ファイルと同じパスのファイルはエラーである。外部バックエンドはプロトコル2からマニフェストを返す（18.11）。プロトコル1ではマニフェストは `null` である。入力には言語のオプション（`options`、`Backend::options_json`。TypeScriptではimportの拡張子、レイアウト、クライアントのモジュール）も含まれ、追加するファイルを生成ファイルに合わせられる。

### 11.2 プラグインモジュール {#112-plugin-modules}

`plugins:` には、1回の実行につき1つのプロセスで複数の段階に参加するモジュールを並べる。段階ごとにコマンドを起動するフックとは異なる。tsuraraは各モジュールを1回だけ起動し（デフォルトでは `@tsurara/plugin` のランナーを通して `node` で。ほかのSDKなら別の `runtime` コマンドで）、それを並べたファイルのディレクトリで実行して、標準入出力で `tsurara_backend::session` のセッションプロトコルを話す。1行に1つのJSONメッセージで、まず `hello`（プロトコルのバージョン付き。バージョンが異なれば、両方を示して実行を止める）、次にプラグインが宣言した段階ごとの `call` を送り、`result` か `error` で応答を受ける。プラグインモジュールは、各段階でフックのあとに、並べた順に実行する。メッセージは `spec/plugin-protocol.schema.json`（`SessionRequest`、`SessionResponse`）にある。

`@tsurara/plugin`（`packages/plugin`）はTypeScriptのSDKである。中身は、`definePlugin({ name, transformDocument, transformModel, extend, transformFiles })`、モデル、マニフェスト、入力の型（tsurara自身がプロトコルのスキーマから生成した `src/generated/protocol.ts`）、`ts.file`（マニフェストからターゲットの拡張子でimportし、目印を出力するライター）、そしてプラグイン作者のテスト向けの `runPlugin`（`@tsurara/plugin/testing`）である。プラグインモジュールはNode 22.18以降が型ストリッピングで実行するTypeScriptなので、ビルドの手順はない。`tsurara init --plugin` がひな形を書き、`examples/plugin-swr` はSWRのフックを書き出す。

ほかのSDKも同じセッションを話す。Python向けの `tsurara-plugin`（`packages/plugin-python`。`python -m tsurara_plugin <module>` として実行する）、`github.com/tsurara-openapi/tsurara/packages/plugin-go`（`packages/plugin-go`）、そして `tsurara-plugin` クレート（`crates/tsurara-plugin`）である。PythonとGoの型は、tsurara自身のPythonとGoのバックエンドがプロトコルのスキーマから生成していて、それらのJSON Schemaへの対応を試す役目も果たす。Rustのクレートは実際の型を使う。

## 12. CLI {#12-cli}

| コマンド | 説明 |
|---|---|
| `tsurara generate [--config <path>] [--target <name>] [--strict] [--format json]` | ファイルを生成して書き込む |
| `tsurara check [--format json]` | 生成結果をディスク上のファイル（同梱したランタイムを含む。7.5）と比べ、異なれば終了コード1で終わる。同梱したランタイムを除き、`@tsurara/client` のバージョンの不一致も検出する。CI向け |
| `tsurara init` | 設定ファイルのひな形を作る |
| `tsurara inspect operations [--tag t] [--search text]` | 操作の一覧：ID、メソッド、パス、概要、生成された関数とファイル |
| `tsurara inspect operation <id or "METHOD /path">` | パラメーター、リクエストの本文、レスポンス、生成された関数と型、そのほかの生成された値（マニフェストの `helpers`：クエリオプション、キー、フィルター、モックのハンドラー）、ターゲットの言語での呼び出し例 |
| `tsurara inspect schema <name>` | スキーマ（定義での名前か生成された名前で指定）の、生成された名前、ファイル、宣言 |
| `tsurara inspect warning <code>` | 警告コードの意味と解決方法（6.8） |

`--format json` は、スクリプトやコーディングエージェント向けに、行の代わりに1つのJSONオブジェクトを標準出力に出す。`generate` ではターゲットごとに、書き込んだ、変更のなかった、削除したファイルと、警告（コード、文書、JSON Pointer、メッセージ）を出す。`check` ではターゲットごとに、差分とランタイムの問題を出す。失敗は `error` として出し、終了コードは1である。`spec/cli-output.schema.json` はRustの型（`tsurara_cli::output`）から生成する。`inspect` のサブコマンドは `--target`（ターゲットが複数あれば必須）と `--format json|text` を取り、何も書き込まずにモデル、マニフェスト（11.1）、生成ファイルを読む。呼び出し例は `Backend::example` がサンプル値（18.7.1）から作る。生成コードの隣でコンパイルできるファイル（出力のルートの `example.ts`、パッケージ内の `example.py`、`mod.rs` の隣で `mod example;` として宣言する `example.rs`、パッケージ内の `example.go`）で、各言語の流儀でResultを扱う。単純なスカラーでない引数は、RustとGoではJSONから、PythonではTypeDefのコーデックでデコードする。JSONでないリクエストの本文は、アプリが埋めるように残す。

### 12.1 MCPサーバー {#121-mcp-server}

`tsurara mcp` は、同じバイナリに入った標準入出力のModel Context Protocolサーバーである。JSON-RPC 2.0で、1行に1つのメッセージを扱い、SDKを使わずに `tsurara-cli/src/mcp.rs` で実装している（RustのSDKはMSRVより新しいコンパイラーを必要とするため）。ツールは `inspect`、`generate`、`check` の薄い層で、短いテキストとCLIのJSON（`structuredContent`）の両方を返す。ツールは、`list_targets`、`search_operations`（クエリのすべての単語が、ID、メソッド、パス、概要、タグのいずれかの単語の先頭に一致しなければならない。`offset` と `limit`、デフォルトは50）、`describe_operation`（107の呼び出し例付き）、`describe_schema`、`generate`（CLIと同じく、設定された出力先ディレクトリにだけ書き込む）、`check`（ずれはツールのエラーではなく結果として返す）、`explain_warning` である。ガイド（`docs/guide/*`、`docs/languages/*`）はビルド時に埋め込み、リソース（`tsurara://docs/guide/configuration.md`）として並べる。クライアントの設定方法は `docs/guide/ai.md` にある。`.claude-plugin/plugin.json` はこのサーバーをClaude Codeのプラグインとして登録し、このプラグインはスキル `skills/tsurara` も含む（そのコードブロックは生成コードに対して型検査している）。`tsurara init --agents` はエージェント向けのルールを `AGENTS.md` か `CLAUDE.md` に書き、リポジトリのルートの `llms.txt`/`llms-full.txt` がドキュメントの索引になる。

`tsurara check` は、定義と生成ファイルのずれ（再生成のし忘れ、生成ファイルの手での編集）と、生成コードと `@tsurara/client` のバージョンのずれを見つける。サーバーの実際のレスポンスと定義のずれを防ぐのは、バックエンドのコントラクトテストなどの役目である。

## 13. 品質保証 {#13-quality-assurance}

- コーパスのテスト：大きな実在の定義（GitHub、Stripe、Kubernetes、OpenAIなど）と、エッジケースを集めた定義から生成し、出力を `tsc --noEmit` に通す。次のtsconfigの組み合わせを確かめる。
  - `strict`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`isolatedDeclarations`
  - `moduleResolution` を `nodenext` と `bundler` にしたもの
- 対応表のテスト：6.4の表の各行が、入力と期待する出力を持つテストである。期待する出力は、JSON Schemaの意味に照らして確かめる。出力した型の文字列を比べるだけでは、期待する値そのものの誤り（`prefixItems` のタプルを固定長にする誤りなど）を見つけられない。
- 代入可能性のテスト：定義が許す値を生成された型に代入できること、許さない値を代入すると `@ts-expect-error` が成り立つことを確かめる（035での作業）。TypeScriptがすべての制約を検査できるとは約束しない。6.4.1で近似する制約については、近似として値を受け入れることをテストに明記する。
- 型ストリッピングの確認：出力をNodeの型ストリッピングでimportして実行できること、そして対応する最低のTypeScriptのバージョン（5.8）と開発に使うバージョンの両方で `tsc` を通ることを、CIで確かめる（`crates/tsurara-lang-typescript/tests/type_stripping.rs`。tscのテストはすべて両方のバージョンで実行する）。
- プロパティベースのテスト：ランダムに作ったスキーマから生成し、`tsc` を通ることを確かめる。`crates/tsurara-cli/tests/properties.rs` はproptestで定義を作り（合成、null許容の値、循環のある参照、readOnlyとwriteOnly、判別子、命名に負荷をかける名前）、すべてのケースを1回の `tsc`（最も厳しいtsconfig）とpyrightの実行で確かめ、失敗したケースを1段階ごとに1回の検査で縮める。最小の定義は `target/proptest-failures` に保存し、`corpus/edge-cases` に追加する。CIは固定のシードで48ケースを、毎週のworkflowは新しいシードで2000ケースを実行する（`TSURARA_PROPTEST_CASES`、`TSURARA_PROPTEST_SEED`）。このテストは、参照を通して自分自身を参照するエイリアスを見つけた。そうしたエイリアスは今では `unknown` になるか、警告を出してその参照を失う。
- スナップショットのテスト：出力全体を保存し、意図しない変更を検出する。
- ランタイムライブラリのテスト：OpenAPIのstyleごとに、シリアライズとレスポンスの解析をテストする。失敗を模擬して、Resultの各 `kind` が正しく返ることを確かめる。
- E2Eのテスト：`examples/pnpm-monorepo` を、生成から2つのアプリでの呼び出しまで実行する。
- 性能の計測：大きな定義での生成時間と `tsc` の時間をCIで記録し、劣化を検出する。barrelからのimportと直接のimportで、Nodeの起動時間、開発サーバーの読み込み、`tsc` の時間を比べる。`pnpm bench`（`scripts/bench.mjs`）は、コーパスのGitHub（3.1）、Stripe、Kubernetes、OpenAIについて、リリースバイナリの生成時間、出力全体に対する `tsc --extendedDiagnostics`（時間と型のインスタンス化の数）、そしてbarrel経由とサブパス経由で1つの操作をimportしたときの `tsc` と、型ストリッピングを使うNodeの起動を測る。CIの `bench` ジョブは、mainへのpushのたびに前回の結果と比べ（インスタンス化が+5%を超える、時間が+50%を超える場合）、結果をアーティファクトとして残す。Viteの開発サーバーはまだ測っていない。

  2026-11-11の結果（Apple Silicon、TypeScript 7.0.2、Node 26）：

  | 定義 | 生成 | 出力に対する `tsc` | インスタンス化 | Nodeの起動、barrel / サブパス |
  |---|---|---|---|---|
  | GitHub 3.1 | 704 ms | 184 ms | 22 933 | 212 / 54 ms |
  | Stripe | 390 ms | 130 ms | 24 718 | 151 / 54 ms |
  | Kubernetes | 397 ms | 156 ms | 35 748 | 229 / 53 ms |
  | OpenAI | 313 ms | 107 ms | 13 313 | 115 / 53 ms |

  9.2で予想したとおり、barrelからimportすると、Nodeはすべての操作のモジュールを読み込む（サブパスから1つimportしたときの起動の2〜4倍）。`tsc` の時間はどちらでも短いままである。

### 13.1 テストのコーパス {#131-test-corpus}

| 定義 | 出典 | 主に確かめること |
|---|---|---|
| Petstore（2.0、3.0、3.1） | OpenAPI InitiativeとSwaggerの公式の例 | 基本的な変換、Swagger 2.0の正規化 |
| GitHub REST API | github/rest-api-description | 大きな定義、`oneOf`/`anyOf`、nullable |
| Stripe | stripe/openapi | `anyOf` と展開可能なフィールド、urlencodedの本文 |
| Kubernetes | kubernetes/kubernetesの `api/openapi-spec` | 深い参照、`x-kubernetes-*` の拡張 |
| OpenAI | openai/openai-openapi | discriminator、シーケンシャルな形式（`text/event-stream`）、マルチパート |
| エッジケース | このリポジトリで書いたもの | 循環、予約語、珍しいプロパティ名、判別子の各パターン |

出典はコミットハッシュかタグで固定し、sha256で確かめる（`corpus/sources.json`）。対象は、3.0と3.1の両方の記述のGitHub、Stripe、Kubernetes（Swagger 2.0）、OpenAI（3.1）、Petstore 2.0である。`pnpm corpus:fetch` がそれらを `target/corpus` にダウンロードし、`crates/tsurara-cli/tests/corpus.rs` が `tsurara` のバイナリで各定義をすべての言語に生成する。TypeScriptの出力はTypeScript 7.0.2と5.8でtsconfigの組み合わせを使って検査し、Pythonの出力はpyrightで検査する。エッジケースは `corpus/edge-cases` にある。実在の定義で見つかったバグごとにそこへ1つ追加し、ダウンロードなしで確かめられるようにする。これらの定義で解決できない参照があればtsuraraのバグなので、テストは失敗する。

## 14. 安定性とバージョニング {#14-stability-and-versioning}

次の5つの項目は安定性の約束の対象で、semverのメジャーバージョンでだけ変える。

1. 生成する名前の規則
2. Resultの形
3. OperationDefの形式
4. 設定ファイルのスキーマ
5. tsuraraの外のプログラムとやりとりするJSON：モデル、マニフェスト、プラグインと外部バックエンドのプロトコル（`spec/sem-model.schema.json`、`spec/manifest.schema.json`、`spec/plugin-protocol.schema.json`）

1が約束するのは命名の規則であり、定義が変わったときに個々の名前が決して変わらないことではない。たとえばreadOnlyのプロパティを追加するとリクエスト側の型名が変わり（6.5）、名前に付く番号は定義の順序によって変わりうる（6.6）。こうした変更は、`tsurara check` の差分と警告で気づけるようにする。

5は独自のバージョンのフィールドを持ち、ほかのリポジトリのプラグインとバックエンドが受け取るものを確かめられる。

- 互換性のある変更ではバージョンを変えない。省略可能なフィールドの追加や、フィールドを省略可能にする変更である。利用側は知らないフィールドを無視する。Rustの型はそうしており、105と106のSDKもそうしなければならない。
- それ以外の変更ではバージョン（`semVersion`、`manifestVersion`、`protocol`）を変える。フィールドの削除、名前の変更、必須化、型の変更、そしてenumへの新しいバリアントの追加（新しい種類の型や警告コード）である。利用側はenumを網羅的に照合するからである。
- CLIが作るモデルとマニフェストのバージョンは1つである。現在の `semVersion` を挙げていない外部バックエンドは、モデルを古いバージョンに変換するのではなく、両方のバージョンを示して拒否する。プロトコルは、省略可能な部分だけが異なる古いバージョンを残す（プロトコル1と2、18.11）。
- 3つのスキーマへの変更は、互換性の有無にかかわらず、新しいスキーマのハッシュとともに `spec/CHANGELOG.md` に記録する。記録のないままスキーマが変わるとテストが失敗する。最初のリリースからは、置き換えられた各バージョンのスキーマを `spec/versions/<schema>-<version>.json` として残す。

最初のリリースまでは、`semVersion` と `manifestVersion` は1のままにし、変更履歴には上げずに変更を記録する。外部バックエンドがすでに交渉に使っているプロトコルには、最初からバージョンを付けている。

依存関係は最小限にとどめる。生成器は単一のバイナリで、`@tsurara/client` は標準のAPIにだけ依存する。

同梱したランタイム（7.5）はライブラリではなく生成結果の一部である。そのソースは生成コードと同じく生成器とともに変わり、上の約束が適用されるのは、生成コードがそこから使うもの（Resultの形、OperationDefの形式）であって、内部のファイルではない。

## 15. 範囲外 {#15-out-of-scope}

初期のバージョンは次のものを扱わない。どれも、後からプラグインや `@tsurara/client` の機能として追加できる構造にしている。

- `date-time` から `Date` への、`int64` から `bigint` への実行時の変換
- `$dynamicRef` からのジェネリック型の生成

検証の責任は次のように分ける。tsuraraは型と呼び出し関数を生成し、型はレスポンスが定義に合っていることを前提にする。

- APIのレスポンスが定義に合っているかの検証：任意で、`validate` オプションと生成したZodのスキーマで行う（8.7）。サーバーの実装と定義のずれを防ぐには、やはりバックエンドのコントラクトテストが最もよい（12章）。
- UIのフォームの検証：tsuraraの範囲外である。リクエストの型（`Writable` の型）は、フォームが最終的に送信する値の契約として使えるが、入力途中の値の検証やエラーメッセージの表示はアプリの責任である。
- Zod向けのスキーマの生成：`typescript.validators: zod`（8.7）で、型とは別のファイルとして生成する。

## 16. 未解決の問題 {#16-open-questions}

| # | 問題 | 残っている理由 |
|---|---|---|
| 1 | 業務で使う定義（または構造が似た定義）をテストのコーパスに追加する | そうした定義が提供されたら追加する。公開されている定義は13.1のとおり決めた |
| 3 | 割り当てた名前を記録するロックファイル（`tsurara.names.json` など）を導入するか | 名前の安定性（6.6）を補う選択肢である。衝突した導出名を警告付きでずらすだけで足りるかを見てから決める |
| 4 | 呼び出し関数なしで型だけを出力するモードを用意するか | 統合のレビューで出た提案で、要件には含まれない。採用するなら別のissueにする |

### 16.1 決定事項 {#161-decisions}

| 問題 | 決定 | 反映先 |
|---|---|---|
| グローバルな名前と衝突するスキーマ名 | 接尾辞 `Model` を付け、それでも衝突すれば番号を付ける | 6.6 |
| Next.jsが共有パッケージを読むのに必要な設定 | tsconfigの `allowImportingTsExtensions` だけ。`transpilePackages` は不要（Next.js 16.4、Turbopackとwebpack） | 9.2 |
| readOnly/writeOnlyでの分け方 | 元の型はwriteOnlyを除き、`Writable` の型はreadOnlyを除く | 6.5 |
| Swagger 2.0を当初の範囲に含めるか | 含める | 5.4 |
| `date-time` のデフォルト | `string`。`Date` は実行時の変換とともに後で追加する | 10.4 |
| テストのコーパス | 13.1の定義 | 13.1 |
| TypeScriptとNodeの最低バージョン | TypeScript 5.8以降、Node 22以降 | 17章 |
| 判別子を持つ親を、allOfで継承する子のunionにするか | しない。判別子は検証の結果を変えないので、判別するリテラルを付けるだけにする | 6.5 |
| 3.0で `$ref` の兄弟として書かれた `nullable` | 仕様に従って無視し、警告する。兄弟を尊重する互換モードはない | 6.3 |
| 導出した型名がほかの名前と衝突したとき | ほかの名前がそのまま使い、導出した名前は接尾辞の前に `Operation` を入れ、警告を出す（kubbにならう） | 6.6 |
| JSONの中でもマルチパートの本文としても使われ、バイナリのパートを持つ名前付きのスキーマ | 名前付きの型はJSONに従う（`string`）。マルチパートの本文はスキーマをインラインに展開し、バイナリのパートを `Blob \| File` にする | 6.4 |
| ワイルドカードのメディアタイプの扱い | 実際のContent-Typeで解析し（`auto`）、型はありうる値のunionにする。設定でJSONとして扱える | 8.5 |
| TypeScript以外の言語の生成 | 言語に依存しないセマンティックモデル、共有の命名、ローワリング、ランタイムの契約、言語ごとに1つのバックエンド。TypeScriptを最初に、Pythonを2番目にする | 18 |
| 多言語の設計の未解決の問題（Q1〜Q7） | 18.16を参照 | 18.16 |

## 17. 対応環境 {#17-supported-environments}

| 対象 | 最低バージョン | 理由 |
|---|---|---|
| TypeScript | 5.8 | `erasableSyntaxOnly` が導入されたバージョン。開発には7.0.2を使い、CIでは両方で型検査する |
| Node | 22 | Node 20のサポートは2026年4月に終了した。生成コードを型ストリッピングで直接実行するには22.18以降が必要 |
| Rust（生成器のビルド） | 1.85 | edition 2024を使う |
| Python（生成コードと `tsurara-client`） | 3.11 | 18.16、Q2 |

`@tsurara/client` は、`fetch`、`Request`、`Response`、`Headers`、`AbortController`、`URL`（コンストラクターだけ）を必要とする。`ReadableStream`、`Blob`、`FormData`、`URLSearchParams`、`AbortSignal.any`、`DOMException` はあれば使うので、React Nativeのようにその一部がない環境でもクライアントは動く。リクエスト、タイムアウト、中断はそれらなしで動き、React Nativeのファイルオブジェクト（`reactNativeFile` を通して渡す `{ uri, name, type }`）はファイルのパートとしてアップロードされる。ストリーミングのレスポンスには、ストリーミングの本文を扱える `fetch`（Expoでは `expo/fetch`）が必要で、なければ `parseAs: 'stream'` は `kind: 'parse'` を返す。Hermesについては、`runtimes/typescript/hermes`（`@tsurara/hermes-check`）が、Metroと同じくReact Native自身の `fetch`、`FormData`、`URL` のポリフィルとBabelのプリセットでクライアントをバンドルする。React Native 0.88の `hermesc` でコンパイルし、Hermes CLIの最後のリリース（v0.13.0、React Native 0.75の時期）のVMで、JSONの呼び出し、Basic認証、`reactNativeFile` を使うマルチパートのアップロード、タイムアウト、中断、そしてストリーミングの `fetch` がない場合のストリームの `parse` の失敗を実行する。React NativeとExpoは、まだ実機で確かめていない。

## 18. 複数の言語 {#18-multiple-languages}

tsuraraは1つのOpenAPIの定義から多くの言語のコードを生成する。現在はTypeScriptで、次にPython、Rust、C#、Go、PHP、Ruby、Kotlin、Java、Swift、GDScriptが続き、さらに増える予定である。この章では、新しい言語の追加を、新しい生成器を作ることではなく、おもに規則とプリンターを書くことで済ませるためのアーキテクチャを述べる。現在のTypeScriptだけの実装を述べる4、6、7、10、11章と異なる箇所では、この章が目標である。

### 18.1 目標と非目標 {#181-goals-and-non-goals}

目標：

- G1. OpenAPIの文書の解析に手を加えずに、言語をバックエンドとして追加できる。
- G2. どの言語でも、まず型を、次に呼び出し関数と、共通のランタイムの契約（18.9）を実装するランタイムライブラリを用意する。
- G3. バックエンドの大部分は共有の仕組みである。命名（18.6）、ローワリング（18.5）、値の変換のメタデータ（18.7）、整形出力（18.8）である。言語固有の部分は、命名のポリシー、能力の集合、プリンターである。
- G4. セマンティックモデルは言語に依存せず、シリアライズでき、バージョンを持つ。これはIRのプラグインと、外部プログラムとして書くバックエンド（18.11）の入力である。
- G5. 同じ言語の別の出力（Zodのスキーマ、MSWのハンドラー、pydanticのモデル）は、同じ仕組みの上に作るバックエンドかバックエンドの派生である。

非目標：

- 現在のクレートのAPI、設定のキー、OperationDefの形、生成される名前との互換性。tsuraraは0.xで開発者は1人なので、リリースの間で互換性のない変更を許す（2026-11-09に決定）。互換性の規則は内部のものだけである。安全網として、リファクタリングの段階ではTypeScriptの出力をバイト単位で同一に保ち、意図した出力の変更は別の、レビューを経た段階で行う。
- すべての言語を今すぐ実装すること。TypeScriptとPythonを先にする（18.14）。

### 18.2 言語の調査 {#182-language-survey}

各言語が生成器に求めるもの。18.5の能力の集合と18.7の変換の方針は、この表から導いている。

| 言語 | 型システム | 値の変換（18.7） | 主な制約 |
|---|---|---|---|
| TypeScript | 構造的：union、リテラル、交差型、インデックスシグネチャ | なし：解析したJSONがそのまま型付きの値 | `erasableSyntaxOnly`、`isolatedDeclarations` |
| Rust | 公称的。データを持つenum、継承なし | アノテーション（serde） | 再帰には `Box` が必要。値がないことと `null` の区別。名前を変えたsnake_caseのフィールド |
| C# | 公称的。単一継承、unionなし | アノテーション（System.Text.Json） | ポリモーフィズムはクラス階層への属性でしか表せない。null許容参照型 |
| Go | 公称的。unionなし、継承なし、埋め込み | アノテーション（structのタグ）と、union向けのランタイムのヘルパー | 省略可能な値はポインターで表す。exportする名前と頭字語（`ID`、`URL`）。ディレクトリごとに1パッケージ |
| Kotlin | 公称的。sealed class | アノテーション（kotlinx.serialization） | クラスの判別子の慣習 |
| Java | 公称的。record、sealed interface、unionなし | アノテーション（Jackson） | パッケージはディレクトリと一致し、ファイル名はクラス名と一致する |
| Swift | 公称的。関連値を持つenum | アノテーション（Codable） | 値がないことと `null` の区別。再帰するstructには間接参照が必要 |
| Python | 構造的（TypedDict）または公称的（dataclass） | TypeDefのメタデータ（18.7）。pydanticの派生ではアノテーション | 同期と非同期のクライアント。フィールド名としてのキーワード |
| PHP | 公称的なクラス。限られたunion。ジェネリクスなし、要素の型はPHPDocだけ | TypeDefのメタデータ | 型がネイティブの宣言とPHPDocに分かれる。PSR-4の名前空間 |
| Ruby | 静的な型なし。RBSのシグネチャ | TypeDefのメタデータ | 単位ごとに2ファイル（`.rb` と `.rbs`） |
| GDScript | 公称的。unionなし、null許容のプリミティブなし、型付きの `Array`/`Dictionary` 以外のジェネリクスなし、enumは整数だけ、グローバルな `class_name` | TypeDefのメタデータ | JSONの数値はfloatとして解析される。例外なし。HTTPはシグナルと `await` で扱う。`.uid` のサイドカーファイル |

### 18.3 アーキテクチャ {#183-architecture}

```
入力
  → tsurara-loader: DocumentSet
  → プラグイン（document の段階）
  → tsurara-sem: 解析 → sem::Model（シリアライズ可能、バージョン付き）
  → プラグイン（model の段階: Rust のトレイトか `transformModel` コマンド）
  → バックエンド（組み込みのクレート、または外部プログラム。18.11）
      a. 命名: 言語の NamingPolicy を使う tsurara-naming                    (18.6)
      b. ローワリング: 言語の Capabilities を使う tsurara-lower → tir       (18.5)
      c. ランタイムのメタデータ: OperationDef と TypeDef                    (18.7, 18.9)
      d. tsurara-pretty による出力、ファイルの配置、目印                    (18.8)
  → プラグイン（files の段階）
  → tsurara-cli: 書き込み、古いファイルの削除、check
```

#### 18.3.1 クレート {#1831-crates}

| クレート | 内容 |
|---|---|
| `tsurara-loader` | 変更なし |
| `tsurara-sem` | セマンティックモデル、`DocumentSet` からのその構築、共有の正規化、意味上の警告、serdeによるシリアライズ |
| `tsurara-naming` | スコープ付きの名前の割り当てと、`NamingPolicy` トレイト |
| `tsurara-lower` | ローワリングした型のIR（`tir`）、`Capabilities`、ローワリングのパス、バリデーター |
| `tsurara-pretty` | すべてのプリンターが共有する、Wadler方式のドキュメントプリンター |
| `tsurara-backend` | インターフェースだけ：`Backend` トレイト、`Output`、`Markers`、外部バックエンドのプロトコルの型。どの言語のクレートにも依存しない |
| `tsurara-lang-<language>` | 言語ごとに1つのクレート：命名のポリシー、能力、言語固有のパス、プリンター、配置、オプション |
| `tsurara-config` | 設定。各言語のオプションは、そのバックエンドのクレートから来る |
| `tsurara-cli` | `tsurara` コマンド。組み込みのすべての `tsurara-lang-<language>` クレートに依存し、`language` の値をバックエンドに対応づけるレジストリを持つ。そのため、これより下のクレートはどれも言語のクレートに依存しない |
| `tsurara-testkit` | 言語ごとのチェッカー（18.12） |

以前の `tsurara-codegen` クレートはなくなった。その解析は `tsurara-sem` に、`emit.rs` は `tsurara-lang-typescript` に移った。命名は `tsurara-naming` とTypeScriptバックエンドに移った。`ir.rs` はモデルの言語に依存しない型のIRで、`tsurara-lower` とすべてのバックエンドが使う。そのバリアントのうち `Undefined`、`Ref`、`External`、`Builtin` だけはTypeScriptのローワリングに属する（モデルには決して現れず、シリアライズもされない）。`print.rs`（TypeScriptの型の出力。正規化でも安定したメンバーの順序のために使う）と `options.rs`（共通のオプション）も `tsurara-sem` に残っている。043〜045でTypeScriptだけのオプションと命名を外に移し、これらを残した。

```rust
pub trait Backend {
    /// `typescript`, `go`, ... Used as the `language` value in the configuration.
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> &Capabilities;
    fn naming(&self) -> &dyn NamingPolicy;
    fn markers(&self) -> &Markers;
    /// Parses and validates the language section of the configuration.
    fn options(&self, raw: &serde_json::Value) -> Result<Box<dyn Any>, OptionsError>;
    fn generate(&self, model: &sem::Model, common: &CommonOptions, opts: &dyn Any) -> Result<Output, Error>;
}
```

### 18.4 セマンティックモデル {#184-semantic-model}

セマンティックモデルは、定義が意味することを保持する。すべての言語の型システムを合わせたものではなく、ある言語のために選んだ識別子も含まない。

#### 18.4.1 スキーマ {#1841-schemas}

```rust
pub enum Schema {
    Any,
    Never,
    Null,
    Boolean,
    Integer { format: Option<String> },          // int32, int64, ...
    Number { format: Option<String> },           // float, double, decimal, ...
    String { format: Option<String>, content: Option<Content> },
    /// A raw byte value: only where the value is the HTTP body itself or a multipart part (6.4).
    Binary,
    Const(serde_json::Value),
    Enum(Enum),
    Ref(SchemaId),
    Array { items: Box<Schema>, unique: bool },
    Tuple(Tuple),
    Object(Object),
    Union(Union),
    /// `allOf`: the conjunction of its members, which may be any schemas (objects, references,
    /// scalars, unions). Only the inline objects among them are merged (see the rules below).
    AllOf(Vec<Schema>),
    Nullable(Box<Schema>),
    External(ExternalId),
}

pub struct Object {
    pub properties: Vec<Property>,
    /// `additionalProperties`, unwidened.
    pub additional: Option<Box<Schema>>,
    pub patterns: Vec<(String, Schema)>,
}

pub struct Property {
    /// The JSON key, exactly as in the definition. Backends assign member names (18.6).
    pub wire_name: String,
    pub schema: Schema,
    pub required: bool,
    pub read_only: bool,
    pub write_only: bool,
    pub default: Option<serde_json::Value>,
    pub doc: Option<Doc>,
    pub pointer: String,
}

pub struct Union {
    /// Members as written, including duplicates and nested unions (see the rules below).
    pub members: Vec<Schema>,
    /// `oneOf` is exclusive, `anyOf` is not.
    pub exclusive: bool,
    pub discriminator: Option<Discriminator>,
}

pub struct Discriminator {
    pub property: String,
    /// The values that select each member, in member order.
    pub values: Vec<Vec<String>>,
    /// `defaultMapping` (3.2).
    pub default: Option<SchemaId>,
}
```

`tsurara-sem` に置くものの規則：

- ここに残すのは、JSON Schemaの意味のもとで正確な正規化だけである。`allOf` のメンバーのうちインラインのオブジェクトのマージ、入れ子の `anyOf` の平坦化と重複した `anyOf` のメンバーの除去（`anyOf` は結合的かつべき等である）、nullableの3つの書き方の `Nullable` への統一、`$dynamicRef` の静的な解決、readOnly/writeOnlyの解析である。
- `oneOf` は構造と重複を保つ。`oneOf: [A, A]` は `A` に一致するすべての値を拒否し、入れ子の `oneOf` は結合的ではないので、平坦化や重複の除去はどの値が正しいかを変えてしまう。どのみちunionが包含的であるバックエンド（TypeScript）は、自分のパスで平坦化と重複の除去を行う。
- オブジェクトでない `allOf` のメンバー（スカラー、配列、union）は、`AllOf` のメンバーとして残す。TypeScriptは今と同じく交差させ、ほかのバックエンドはローワリングで扱う（18.5.3、pass 2）。
- ある言語の型システムのために存在するものは、その言語のパスに移す。unionの `unknown` への吸収、インデックスシグネチャの拡大、リテラルのオブジェクトとの交差としての判別子、`X | null` としての `Nullable(X)`、リテラルのunionとしてのenumである。
- 継承した判別子（`allOf` で親を参照する子）は、リテラルのオブジェクトとして先に適用せず、子の `allOf` のメンバーの中にタグ（`Tag { property, values }`）として保持する。

実装では、`Union` は `Choice`（`tsurara_sem::ir::Choice`）と呼ばれ、`AllOf` は今も共有のIRの交差のノードである。すべてのメンバーを保持し、インラインのオブジェクトだけをマージする。
- 定義の値（`const`、`enum`、`default`、`example`）は、文字列ではなくJSONの値として保持する。

#### 18.4.2 宣言とインラインの候補 {#1842-declarations-and-inline-candidates}

```rust
pub struct SchemaDecl {
    pub id: SchemaId,
    /// The name the definition asks for (components key, title, or derived name), before any sanitizing.
    pub preferred_name: String,
    /// Whether the preferred name came from the definition and should be kept when valid.
    pub preserve: bool,
    /// `Read`, or `Write` for the `Writable` variant.
    pub mode: Mode,
    pub schema: Schema,
    pub inherited_discriminator: Option<(String, Vec<String>)>,
    pub doc: Option<Doc>,
    pub pointer: String,
}
```

インラインのオブジェクト、enum、unionはどれも引き上げの候補で、それぞれ独自の `SchemaId`、場所から導いた希望する名前、JSON Pointerを持つ。

- 持ち主の希望する名前のあとに、プロパティ名をPascalCaseにしたもの（`Pet` + `owner` → `PetOwner`）
- 配列の項目には `Item`、マップの値には `Value`、unionのメンバーにはメンバーの番号（`PetKind1`）
- 操作では、操作の希望する名前のあとに役割（`GetPetByIdQuery`、`GetPetById200`）

実装では、候補は `Type::Inline { preferred_name, loc, ty }` で、入れ子の位置（プロパティの値、項目、マップの値、unionのメンバー、本文、パラメーター、ヘッダーのスキーマ）にあるインラインのオブジェクト、enum、union（nullableなものの、null以外のメンバーも）を包む。`allOf` のメンバーは持ち主にマージされるので候補ではない。希望する名前は、持ち主の希望する名前（宣言、または操作のIDをPascalCaseにしたもの）のあとにパスを続けたものである。パスは、プロパティ名やヘッダー名をPascalCaseにしたもの、項目には `Item`（`prefixItems` では `Item1`、`Item2`）、マップの値には `Value`、`oneOf`/`anyOf` には1から始まるメンバーの番号、リクエストの本文には `Body`、レスポンスにはステータス（`200`、`Default`）、パラメーターにはその `name`（番号ではない）である。`tsurara_backend::hoist::claim_candidates` は、宣言と操作のあとに、モデルの順でこれらに名前を付け、JSON Pointerによる `naming.overrides` を尊重する。

どの候補を名前付きの型にするかは、ローワリング（18.5）が決める。TypeScriptバックエンドが名前を付けるのは、今名前を付けているものとまったく同じである。コンポーネント、`$ref` で到達するコンポーネント以外のすべてのスキーマ（`#/components/schemas/Pet/properties/owner` など。循環の有無を問わない。`Converter::ref_type` を参照）、操作から導いた型である。それ以外の候補はすべてインラインのままである。

#### 18.4.3 操作 {#1843-operations}

`Operation`、`Param`、`Body`、`Response`、`Status` は今の意味を保ち、次の点だけが変わる。

- その中の型は `Schema` になり、レスポンスヘッダーは `Property` の値になる。
- 操作は `preferred_name`、`OpKind`、ポインターを持つ。関数名と導いた型名はバックエンドが割り当てる。
- `ParseAs` は、HTTPのペイロードを表す `BodyKind`（json、text、binary、stream、none）になる。
- servers、タグ、セキュリティ要件とスキームは、ランタイムのために保持する（Q4）。

#### 18.4.4 外部の型 {#1844-external-types}

`x-tsurara-type` と型マッピングは言語ごとである。セマンティックモデルでは、マッピングしたスキーマは自分のスキーマに加えて `ExternalId` を持つ。そのIDのエントリがないバックエンドは、スキーマを使って警告を出す。

```yaml
# 定義の中
x-tsurara-type:
  typescript: { type: Uuid, import: { from: ./uuid, name: Uuid } }
  rust: { type: uuid::Uuid }
  go: { type: github.com/google/uuid.UUID }
```

#### 18.4.5 ドキュメントと警告 {#1845-docs-and-warnings}

`Doc` は、説明と構造化したタグ（`deprecated`、`default`、`example`、`format`、文字列ではなく値としての制約）を持つ。各プリンターはそれを自分の構文（JSDoc、rustdoc、XMLドキュメント、docstring、PHPDoc、`##`）で出力する。

意味上の警告（解決できない参照、無視した `$ref` の兄弟、省いた `not`/`if`/`then`/`else`、静的に解決した `$dynamicRef`）は、決して言語に触れない。ローワリングと出力は、言語の名前を示すバックエンドの警告を出す。

#### 18.4.6 シリアライズと不変条件 {#1846-serialization-and-invariants}

`sem::Model` は `Serialize` と `Deserialize` を実装し、`sem_version` を持つ。そのJSON Schemaは `spec/sem-model.schema.json` で、マニフェストとプラグインのプロトコルのスキーマと並んで、Rustの型から生成する。JSONの形はserdeのものである。フィールドとバリアントの名前はcamelCase、enumは外部タグ付き（`{ "scalar": { "kind": "integer", "format": "int64" } }`。値のないバリアントは `"unknown"` のような文字列）、位置は `{ "doc": url, "pointer": pointer }`、ドキュメントのタグは `[name, value]` の組で、値は定義に書かれたとおりのJSONである。`semVersion`（`tsurara_sem::SEM_VERSION`、現在は1）が変わるのは、形が互換性なく変わるときだけである。利用側は知らないバージョンを拒否する。バックエンドだけが作る型（`Builtin`）は決して現れない。このJSONの形を、外部バックエンドと `transformModel` フックが受け取り（18.11）、意味のケースのテストが比べる（18.12）。

順序はモデルの一部である。コンポーネントを文書の順に、次に引き上げの候補を見つけた順に、次に操作を、次にwebhookを並べる。名前の割り当てはこの順序に従う（18.6）ので、これは文書化された不変条件である。

### 18.5 ローワリング {#185-lowering}

ローワリングは、セマンティックモデルを `tir` に変える。`tir` は、いずれかの言語が持つすべての構造を表せる型のIRである。バックエンドは受け入れる構造を宣言し、それ以外は共有のパスが書き換える。ローワリングのあと、能力の集合の外にある構造が残っていないことをバリデーターが確かめる。違反があればパスのバグである。

#### 18.5.1 ローワリングした型のIR {#1851-the-lowered-type-ir}

`tir` は名前付きの宣言と型の式を持つ。

- 宣言：`Record`（ワイヤー上の名前、メンバー名、存在の扱い、省略可能な基底を持つフィールド）、`Enum`（値、開いているか閉じているか）、`TaggedUnion`（判別するプロパティ、バリアント）、`UntaggedUnion`（メンバー。順に試してデコードする）、`Alias`。
- 式：`Scalar`（bool、幅と符号を持つ整数、幅を持つ浮動小数点数、decimal、string、bytes、date、date-time、uuidなど）、`List`、`Map`、`Tuple`、`Optional`、`Nullable`、`Any`、`Named`、`External`、そしてそれらを持つ言語向けの構造的な形 `InlineRecord`、`Union`、`Intersection`、`Literal`。

#### 18.5.2 能力 {#1852-capabilities}

| 能力 | 意味 | 値の例 |
|---|---|---|
| `inline_records` | ほかの型の中の無名のオブジェクト型 | TS、Go：yes（Goのバックエンドは、読みやすい公開APIのために方針として引き上げることもある）。Python（TypedDictは名前付きの宣言を必要とし、dataclassはクラスである）、Java、C#：no |
| `structural_unions` | 任意の型のunion | TS、Python：yes。Rust、Swift：no（タグ付きのみ）。Go、Java、C#、GDScript：no |
| `tagged_unions` | データを持つ直和型、または判別子を持つsealedな階層 | Rust、Swift、Kotlin、Java、C#：yes。Go、GDScript：no |
| `intersections` | `A & B` | TSのみ |
| `inheritance` | なし、単一、多重（インターフェース） | C#、Kotlin：単一。Go、Rust：なし |
| `literal_types` | リテラル型とconst型 | TS、Python |
| `enums` | 文字列の値、整数のみ、なし | GDScript：整数のみ |
| `tuples` | 固定長と可変長のタプル | TS、Python、Rust、Swift |
| `presence` | 「値がない」と `null` をどう区別するか | TS：`?` と `\| null`。Rust：`Option<Option<T>>`。Go：ポインターとランタイムのラッパー |
| `nullable_primitives` | `int` などが `null` を持てるか | GDScript：no |
| `recursion_by_value` | 型が間接参照なしに自分自身を含められるか | Rust、Swift：no |
| `integer_widths` | どの幅の整数と浮動小数点数があるか | TS：なし（すべて `number`）。Java：32/64 |
| `maps` | 値に型の付いたマップと、追加のマップのフィールドを持つレコード | 4.4より前のGDScript：型なしのみ |

#### 18.5.3 パス {#1853-passes}

パスはこの順で実行する。能力によって不要なパスは飛ばす。

1. その言語がインラインに書けないインラインの候補を、希望する名前で引き上げる。
2. `allOf`：`intersections` があれば交差型にする。そうでなく、すべてのメンバーがオブジェクトかオブジェクトへの参照なら、参照が1つで `inheritance` が許せば基底の型にし、そうでなければ参照先の宣言のプロパティをコピーする。オブジェクトでないメンバーがあるとき（`allOf: [{ type: string }, { anyOf: [...] }]`）は、その言語が表せる最も具体的なメンバーを使い、ほかの制約を省いたことを警告する。
3. 判別子のあるunion：`tagged_unions` があればタグ付きunionにする。なければ、ランタイムのヘルパーでデコードするタグなしunionにする（18.7）。
4. 判別子のないunion：`structural_unions` があれば構造的なunionにする。なければタグなしunionにし、メンバーを区別できないときは警告を出して `Any` にする。
5. enum：許されるところではネイティブのenum、それ以外では定数にする。開いているかどうかは、宣言ごとではなく、使われる箇所ごとに方向で決め、`splitVisibility` やreadOnly/writeOnlyには依存しない。ローワリングは、使われるすべての箇所に、送る（リクエストの本文とパラメーター、webhookのレスポンス）か受け取る（レスポンス、webhookのリクエスト）かの印を付ける。値を受け取る箇所では、挙がっていない値でデシリアライザーが失敗する言語のenumを開く。値は受け皿（`Unknown(String)` のバリアントか、文字列で裏打ちした値の型）に保持し、`strictEnums` オプションでこれを無効にできる。値を送る箇所では、enumは閉じている。両方の方向で使われるコンポーネントのenumは、両方の表現を持つ。閉じた型と、受け取る箇所で使う開いた型である（言語が許すなら、挙がっている値しか受け付けないコンストラクターを持つ、1つの開いた型）。
6. 判別付きunionも、同じ方向の規則で、挙がっていない判別子の値のための同じ受け皿を持つ。

TypeScriptは、どちらの方向でも閉じたリテラルのunionのままにする（2026-11-09に決定）。unionの外の値を受け取ると型は不正確になるが、実行時に失敗することはなく、出力もバイト単位で同一のままである。開いたenumがデフォルトになるのは、挙がっていない値でデコードが失敗する言語（Pythonとそれ以降の言語）だけである。
7. リテラルと `const`：許されるところではリテラル型にする。それ以外では基になるスカラーにし、値はドキュメントに書く。
8. 存在の扱い：省略可能とnullableを、その言語の表現にする。値がないことと `null` を区別するラッパーの型は、省略可能かつnullableのプロパティにだけ使う（Q3）。
9. タプル：許されるところではタプルにする。それ以外では、メンバーのunionか `Any` のリストにする。
10. 再帰：`recursion_by_value` がfalseのところに間接参照を入れる。
11. プロパティと `additionalProperties` の組み合わせ：追加のマップのフィールドにし、シリアライズ時に平坦にする。
12. スカラー：`format` から幅を決める。その言語に型のないフォーマットは、基本の型にフォールバックする。

実装では、`tsurara-lower` が `tir`（`tir.rs`）、`Capabilities`（プリセット `ALL` と `MINIMAL` 付き）、`lower`、`validate` を持つ。方向は宣言ごとに操作から計算し（webhookとコールバックは逆向き。どの操作からも到達しない宣言は両方とみなす）、すべての参照がその `Site` を持つ。そのためバックエンドは、値を送る箇所では閉じた形を、受け取る箇所では開いた形を出力できる。パス12はスカラーを `format` とともに保持し、各バックエンドがフォーマットを自分の型に対応づける。TypeScriptは独自のローワリング（`tsurara-lang-typescript/src/lower.rs`）を保つ。そのIRは、すべての能力を有効にした `tir` の構造的な部分集合だからである。

言語固有のパスは共有のパスのあとに実行する。たとえば、TypeScriptのインデックスシグネチャの拡大や判別子の交差である。各言語は近似を、6.4.1の形で `docs/languages/<language>.md` に書く。

### 18.6 命名 {#186-naming}

#### 18.6.1 コンテキストとスコープ {#1861-contexts-and-scopes}

すべての識別子はいずれかのコンテキストに属し、各コンテキストには名前が一意でなければならないスコープがある。

| コンテキスト | スコープ | 例 |
|---|---|---|
| 型 | 名前空間（ほとんどの言語では出力全体） | `Pet`、`PetWritable`、`PetOwner` |
| 関数 | 名前空間 | `getPetById`、`get_pet_by_id` |
| メンバー | 1つの宣言 | フィールド、enumのメンバー、unionのバリアント |
| パラメーター | 1つの関数 | パスとクエリのパラメーターの名前（言語がそれを使う場合） |
| 定数 | 名前空間 | OperationDef、TypeDef、サーバーのリスト |
| ファイル | ディレクトリ。言語やファイルシステムが求めるなら大文字小文字を区別しない | `pet.go`、`Pet.java`、`pet_owner.py` |

snake_caseへの変換などによって、1つのスコープの中で名前が衝突する（`fooBar` も `foo_bar` も `foo_bar` になる）。そのためメンバーは、型と同じ規則で宣言ごとに割り当てる。

#### 18.6.2 NamingPolicy {#1862-namingpolicy}

```rust
pub trait NamingPolicy {
    /// Converts a preferred name for a context (casing, initialisms, invalid characters).
    fn convert(&self, context: Context, raw: &str, preserve: bool) -> String;
    /// Words reserved in a context: keywords, globals, and members the language or library defines
    /// (`copy` on Kotlin data classes, `get`/`set`/`free` on GDScript objects).
    fn is_reserved(&self, context: Context, ident: &str) -> bool;
    /// Suffix for reserved names (`Model` for TypeScript types, `_` for Python members).
    fn reserved_suffix(&self, context: Context) -> &str;
    fn file_name(&self, decl_name: &str) -> String;
    fn fold_case(&self, context: Context) -> bool;
}
```

実装では、モデルが名前要求（`tsurara_sem::naming::NameRequest`）を、解析が名前を必要とする順に記録し、各バックエンドが `tsurara_naming::Names` と自分のポリシーでそれを再生する。`Type::Named` は要求を参照する。`tsurara-naming` の割り当てのアルゴリズムは共有である。名前の確保はモデルの順序（18.4.6）に従い、予約された名前には接尾辞を付け、残った衝突には番号を付け、すでに使われている導出名（`{P}Data`、`{P}Result` など）は関数名を変えずに `{P}Operation…` にずらす（6.6）。引き上げた名前は、TypeScriptを除くすべての言語で、宣言と操作のあとに確保する。TypeScriptは今の順序を保つ。

#### 18.6.3 ワイヤー上の名前と上書き {#1863-wire-names-and-overrides}

メンバーはワイヤー上の名前を保つ（18.4.1）。メンバー名が異なるときは、プリンターがその言語の名前変更（`#[serde(rename)]`、`[JsonPropertyName]`、structのタグ、`CodingKeys`）を出力するか、TypeDefがそれを記録する（18.7）。TypeScriptはプロパティ名を変えず、必要なら引用符で囲む。

- `naming.overrides`（共通）は、JSON Pointerを希望する名前に対応づける。各言語のポリシーが名前を変換する前に、すべての言語に適用する。
- `<language>.naming.overrides` は、JSON Pointerを、その言語だけの最終的な識別子に対応づける。

ポインターは、スキーマ、プロパティ、操作、引き上げの候補を指せる。

### 18.7 値の変換 {#187-value-conversion}

生成コードには、宣言、アノテーション、登録だけがあり、変換のアルゴリズムは決して含まれない。各言語は次の3つの方針のどれかを使う。

| 方針 | 言語 | JSONが型付きの値になる方法 |
|---|---|---|
| なし | TypeScript | 解析したJSONがそのまま値 |
| アノテーション | Rust、C#、Go、Kotlin、Java、Swift、Python（pydanticの派生） | プリンターが出力するアノテーションに従う、その言語のシリアライズのライブラリ。ライブラリで表せない構造（タグなしunion、開いたenum）にはランタイムの汎用ヘルパーを使う。生成コードはそれを登録するが、実装はしない |
| TypeDef | Python（デフォルトの派生）、PHP、Ruby、GDScript | 生成器が宣言ごとにTypeDefを出力し、ランタイムが値を汎用的に変換する。名前の変更、入れ子のレコード、受け皿付きのenum、union、数値の型変換（GDScriptはすべてのJSONの数値をfloatとして解析する）、日付 |

TypeDefと値の関係は、OperationDefとリクエストの関係と同じである。その形式は `spec/type-def.schema.json` で定め、すべてのTypeDefのランタイムが共有する。TypeDefの言語がローワリングから受け取りうるすべての `tir` の構造を扱う。レコード（ワイヤー上の名前、メンバー名、型、存在の扱い、基底を持つフィールド）、enum（方向に応じた受け皿付き）、タグ付きとタグなしのunion、タプル、フォーマット付きのスカラー、リスト、マップ、外部の型（利用者が名前でランタイムに登録するコンバーターで解決する）、ほかのTypeDefへの参照である。

TypeDefのランタイムは両方向に変換する。

- デコード（JSONから値へ）：名前の変更、入れ子のレコード、enumと判別子の受け皿、unionの選択、数値の型変換、日付。
- エンコード（値からJSONへ）：逆向きの名前の変更と変換。値のない省略可能なフィールドは省く。`null` を書くのは、明示的にnullである値だけである（パス8の存在の規則）。受け皿に保持した挙がっていないenumの値は、受け取ったとおりに書き戻す。

操作はOperationDefを通してルートのTypeDefを選ぶ。TypeDefの言語では、バックエンドはリクエストの本文のメディアタイプごと、レスポンスのステータスとメディアタイプごと、スカラーでないパラメーターごとに型の参照を加える。参照はOperationDefの形式の省略可能なフィールドなので、それを必要としないランタイム（TypeScript）は無視する。

#### 18.7.1 サンプル値 {#1871-sample-values}

すべての言語のモックは同じ値を出力する。値は `tsurara-sample` がモデルから1回だけ計算する。宣言ごとに1つのJSONの値と、操作ごとに、パラメーター、リクエストの本文（値のある最初のメディアタイプ）、レスポンスの本文（ステータスとメディアタイプごと。ストリームにはない）ごとに1つの値である。バックエンドはそれらをリテラルとして出力する。値は決定的で、定義とJSON Pointerから作り、時計や乱数は決して使わない。

スキーマについては、次の順で決める。

1. 値がスキーマのJSONの型を持つ（そしてそのenumかリテラルの値のどれかである）なら、その `example`（または `examples` の最初のもの）、次にその `default`。例が制約を満たすかは確かめない。
2. `const` と、最初の `enum` の値。判別子のタグの最初の値。
3. 型から作る。`true`。整数なら `1`、数値なら `1.5` を、`minimum`/`maximum`（包含か排他か。3.0の真偽値も含む）の範囲に移し、`multipleOf` に合わせて上げる。文字列は `format` によって決め（`date-time` は `2024-01-01T00:00:00Z`、`date`、`time`、`duration`、JSON Pointerから導く `uuid`、`email`、`uri`、`uri-reference`、`hostname`、`ipv4`、`ipv6`、`byte`、`binary`）、それ以外はプロパティかパラメーターの名前（なければ `string`）を、`minLength` まで `x` で埋め、`maxLength` で切る。配列は1項目か、`minItems` 個のコピー。タプルは必須の項目と、`minItems` までの残りの項目。オブジェクトは値を持つすべてのプロパティで、省略可能なものも含む。マップは空。任意の型の値は `{}`。
4. unionは、`null` でなく値を持つ最初のメンバーを取る（`null` しかなければ `null`）。型と同じく、`oneOf` の排他性は保たない。判別付きunionは、タグの値を持つ最初のメンバーを取ってタグを設定する。ただし、メンバー自身のプロパティがそれを許さない場合は除く。
5. `allOf` はメンバーのオブジェクトをマージし、ほかのメンバーの `additionalProperties` が拒否するプロパティを除く。異なる配列は `[]` で交わる。オブジェクトとほかのJSONの型の組み合わせにはサンプルがない。矛盾する合成は解かない。
6. 1つの値の中で、1つの宣言には最大2回まで入る。もう一度入ることになる省略可能なプロパティや配列の項目は除く。必須のものは、`sample-cycle` の警告を出して `{}` にする（そうしたスキーマには有限の値がない）。
7. `pattern` があり例のない文字列は、一般には生成できない。上のプレースホルダーを使い、`sample-pattern` の警告を出す。

方向は型に従う。リクエストの本文は `Writable` の宣言（readOnlyのプロパティを除く）を、レスポンスは元の宣言（writeOnlyのプロパティを除く。OpenAPIはそれをリクエストでだけ必須にするので、必須のものも除く）を使う。

### 18.8 出力 {#188-output}

- 配置はバックエンドが決める。宣言ごとかモジュールごとのファイル、ディレクトリの構造、インデックスのファイル（`index.ts`、`__init__.py`、`mod.rs`）、ファイルどうしの参照方法である。
- 名前空間を必要とする言語（Goのモジュールパス、Java/Kotlinのパッケージ、C#の名前空間、PHPの名前空間、Swiftのモジュール、GDScriptの `class_name` の接頭辞）は、その言語のセクションに必須のオプションを持つ。
- プロジェクトのマニフェスト（`Cargo.toml`、`.csproj`、`go.mod`、`composer.json`、`pyproject.toml`、`Package.swift`）は、デフォルトでは生成しない（Q5）。
- 同梱したランタイム（7.5）は、バックエンドが選ぶ出力のディレクトリで、言語にすでにある参照の方法（相対import、`runtimeCrate`、`runtimeModule`）でたどり着く。
- 目印：バックエンドは、その言語のコメントの構文で生成ファイルを示す行、必要なランタイムのバージョンを記録するファイルと行、そしてCLIが古い生成ファイルと一緒に削除するサイドカーの拡張子（Godotでは `.uid`）を提供する。
- プリンターは `tsurara-pretty` を使い、最終的で決定的な出力を書く。`tsurara check` はバイト列を比べるので、バックエンドは外部のフォーマッターを呼ばない。

### 18.9 ランタイムの契約 {#189-runtime-contract}

どのランタイムも同じ契約を実装する。そうすれば、どの言語でも生成コードを薄く保てる。

- OperationDef：リクエストとレスポンスのメタデータの形式で、`spec/operation-def.schema.json` で定める。バックエンドはそれを自分の言語のリテラルとして出力し、JSONに変換すればスキーマに対して検証できる。
- TypeDef：18.7。TypeDefの方針を採るランタイム向け。
- Resultの種類：`success`、`http`、`network`、`timeout`、`aborted`、`parse`、`unexpected`、そして予約済みの `validation` で、意味は8.2のとおりである。各言語はそれを慣用的な形で表す。TypeScriptでは判別付きunion、RustとSwiftではenum、Kotlin、Java、C#ではsealedな階層、Goでは型付きのエラーを伴う `(T, error)`、GDScript（例外がない）では結果のオブジェクトである。Python、PHP、Rubyは結果のオブジェクトを返し、例外を投げる `unwrap` を用意する。契約はPromiseを前提にしない。各ランタイムは同期、非同期、またはその両方を選ぶ。
- シリアライズと解析：パラメーターのstyle、`explode`、`allowReserved`、`deepObject`、`content` のパラメーター、マルチパートの `encoding` を含むメディアタイプごとのリクエストの本文、本文の種類の表（8.5）。
- ランタイムの能力：ランタイムは対応する本文の種類、パラメーターのstyle、メディアタイプを宣言する。バックエンドは、ランタイムが実行できない操作について、実行時に失敗するコードを生成するのではなく、警告を出して呼び出し関数を省く。
- バージョン：`OPERATION_DEF_VERSION` とTypeDefのバージョンは共有である。生成コードが必要とするランタイムのバージョンの範囲はランタイムごとで、バックエンドの目印を通して記録する。

どのランタイムも2つの層を持つ。型の層は、生成された宣言を宣言し、エンコードし、デコードするのに必要なものである。省略可能とnullableを表す型、unionのヘルパー、ファイルの値、そして言語がTypeDefを使うならTypeDefのコーデックである。HTTPクライアントにも非同期のランタイムにも依存しない。クライアントの層はそれ以外のすべてで、クライアント、実行時のOperationDef、Result、リトライ、シーケンスである。`operations: false`（18.10）で生成した出力は、型の層だけを使う。言語ごとには次のとおりである。

| 言語 | 型の層 | クライアントの層 |
|---|---|---|
| TypeScript | 空。宣言は何もimportしない（チャネルのデコーダーは `decodeMessage` を使うが、何も送らない） | `@tsurara/client` |
| Python | `TypeDefs`、`File`、`MISSING`、`OperationDef`、`SecurityScheme`。標準ライブラリだけで `import tsurara_client` できる | 残りのすべて。最初に使うときにimportする。httpxは `http` のextras（`tsurara-client[http]`）で入る |
| Rust | `Nullable`、`File`、`tagged_union!`、`serde`/`serde_json`（`default-features = false`） | `client` フィーチャー（tokio）。デフォルトのトランスポートには `reqwest` |
| Go | 1つのパッケージ `tsurara` の `types.go` と `value.go`。操作のない生成された型は `net/http` をimportしない | パッケージの残り。サブパッケージにしても名前が移るだけである。モジュールには依存関係がなく、型が使わないものはリンカーが取り除く |

今後のランタイム（Swift、Kotlin、C#、GDScriptなど）も最初から同じ分け方を保ち、同梱できるようにする（7.5）。そのソースは、パッケージとしてだけでなく、利用者のプロジェクトのディレクトリとしても動かなければならない。TypeDefのデコードとエンコードのベクターが型の層の適合性テストである。Pythonはhttpxなしでそれを実行する。

どのランタイムも、テスト向けのモックのトランスポートも持つ。`@tsurara/client/testing`、`tsurara_client.testing`、Rustの `testing` フィーチャー、Goのパッケージ `tsuraratest` である。これはメソッドとパスのテンプレートで振り分けたハンドラーからトランスポートの継ぎ目で応答し、`spec/README.md`（Mock transports）と `spec/conformance/mock-routing.json` の振り分けの規則とベクターに従う。そのため、生成されたモックと手書きのテストは、どの言語でも同じように動く。

`spec/conformance/` の適合性テストのベクターはデータである。リクエストのベクターはOperationDefと入力を与え、メソッド、URL、ヘッダー、本文を期待する。レスポンスのベクターはOperationDef、ステータス、ヘッダー、本文を与え、Resultの種類とデータを期待する。デコードのベクターはTypeDefとJSONを与え、デコードした値を中立的な形で期待する。エンコードのベクターはTypeDefと中立的な値を与え、値を省く場合と `null` を書く場合を含めてJSONを期待する。JSONでない値はタグ付きの形を使う。ランタイムは、そのバックエンドが呼び出し関数を出力する前に、宣言した機能のすべてのベクターを通らなければならない。

ランタイムは `runtimes/<language>/` に置く。`@tsurara/client` は `runtimes/typescript/` に移す。

### 18.10 設定 {#1810-configuration}

1つのターゲットは1つの言語を生成する。1つの定義から2つの言語を生成するなら、同じ `input` を持つ2つのターゲットにする。

```yaml
targets:
  - name: web
    input: ./openapi.yaml
    output: ./web/src/generated
    language: typescript
    splitVisibility: true
    filter: { tags: [pets] }
    naming:
      overrides: { "#/components/schemas/Error": ApiError }
    typescript:
      importExtension: .js
      enumStyle: union
      typeMappings:
        uuid: { type: Uuid, import: { from: ./uuid, name: Uuid } }
  - name: server
    input: ./openapi.yaml
    output: ./server/api
    language: go
    go:
      package: github.com/example/server/api
      strictEnums: false
      typeMappings:
        uuid: { type: github.com/google/uuid.UUID }
```

- 共通のキー：`name`、`input`、`output`、`language`、`filter`、`splitVisibility`、`naming`、`hooks`。
- 言語に依存するものはすべて、`typeMappings`、`overrides`、最終的な識別子の `naming.overrides` も含めて、その言語の名前のセクションに書く。選んだ言語以外のセクションはエラーである。
- 設定のJSON Schemaは、共通の部分と、組み込みのすべてのバックエンドのオプションから組み立てる。
- 現在のトップレベルのTypeScriptのキー（`importExtension`、`enumStyle`、`aggregateMaps`、`clientModule`、平らな `typeMappings` と `overrides`）は削除する。

### 18.11 プラグインと外部バックエンド {#1811-plugins-and-external-backends}

- プラグインのmodelの段階は `sem::Model` を受け取る。Rustの `Plugin` トレイトのほかに、`transformModel` フックが、`transformDocument` と同じく、モデルをJSONで標準入力に渡し、変換したモデルを標準出力から読む。
- 外部バックエンドは、`language: { command: [tsurara-backend-elm] }` で選ぶプログラムである。CLIはそれを2回実行する。
  1. `describe`：プログラムは `{ protocol, semVersions, markers }` を標準出力に書く。`semVersions` は受け入れるモデルのバージョンを並べ、`markers` は `Backend::markers` と同じ内容（生成ファイルの目印、ランタイムのバージョンの目印、サイドカーの拡張子）を持つ。現在のモデルのバージョンが挙がっていなければ、CLIはエラーで止まる。
  2. `generate`：プログラムは `{ protocol, semVersion, model, common, options }` を標準入力から受け取り、`{ files, warnings }` を標準出力に書く。

  CLIは結果を組み込みのバックエンドのものと同じように扱う。古いファイルの削除、サイドカー、`tsurara check` は、`describe` で示された目印を使う。プロトコル1はプログラムにセマンティックモデルだけを渡す。共有の命名とローワリングは、下のとおり提供する（Q6）。

  プロトコル2は、`generate` の応答に省略可能な `manifest`（11.1）を加える。CLIはプロトコル1と2を話し、プログラムが `describe` で示したプロトコルで `generate` を送る。

  共有のローワリングと命名は、どちらのプロトコルでも、求めたプログラムにだけ提供する。

  - `describe` は `lowering: { capabilities }`（`tsurara_lower::Capabilities` のフラグ。camelCase）と、データとしての命名のポリシー `naming`（`tsurara_naming::data::DataPolicy`）を加えられる。`naming` には、コンテキスト（`type`、`function`、`member`、`parameter`、`constant`、`file`。ないものは `type` のものを使う）ごとの `case`（`pascal`、`camel`、`snake`、`screamingSnake`、`kebab`、`preserve`）、`digitPrefix`、`upperPrefix`（Goの `X`）、`fallback`、`ascii`（ファイル名）、`reserved`、`reservedSuffix`と、PascalCaseとcamelCaseで大文字で書く `initialisms` を書く。`naming` には `lowering` が必要である。
  - すると `generate` は、それらの能力に合わせて `tir` にローワリングしたモデル `lowered`（そのJSONの形は `spec/plugin-protocol.schema.json` の一部で、`semVersion` の対象である）と、`names`（`tsurara_lower::AllocatedNames`）も受け取る。`names` は、`lowered` の宣言ごとに型名、ファイル名、メンバー名（レコードのフィールドかenumの値）を、操作ごとに関数名を持ち、ポリシーに従って `Names` が割り当てる。ローワリングの警告はプログラムの警告に加える。
  - この語彙はGoのポリシーを表せる（データの形と `GoPolicy` をエッジケースのコーパスで比べるテストがある）。組み込みのバックエンドはRustのポリシーを保つ。それらは導出名（`{P}Options`）も割り当て、`names` より多くのスコープを持つ。語彙を超える規則にはクレートが必要である。
  - Rustで書くバックエンドは、代わりにクレートを使う。`tsurara-loader`、`tsurara-sem`、`tsurara-naming`、`tsurara-pretty`、`tsurara-lower`、`tsurara-sample`、`tsurara-backend` は1つのバージョンで公開し、CLIとともにリリースする。各クレートのドキュメントが安定したAPIを示す。`examples/backend-rust` はパッケージにした状態のそれらに対してビルドし、`examples/backend-typescript` はプロトコルを使う。

  実装：ターゲットは `language: { command: [program, ...args], options: {...} }` と書く。コマンドは設定ファイルのディレクトリで、`describe` か `generate` を付け足して実行する。`describe` は `{ "protocol": 1, "semVersions": [1], "markers": { "generated": "# Generated by ...", "version": { "file", "prefix" }, "sidecars": [".uid"] } }` を出力する（`version` と `sidecars` は省略可能）。`generate` は `{ "protocol", "semVersion", "model", "common", "options" }`（モデルと共通のオプションはJSONの形。18.4.6）を読み、`{ "files": [{ "path", "contents" }], "warnings": [...] }` を出力する。警告はモデルの警告の形を使い、言語は `external` になる。型は `tsurara_backend::external` にある。

### 18.12 テスト {#1812-testing}

- 意味のテスト：6.4の対応表は、セマンティックモデルのJSONの形に対して1回だけ確かめる。
- ケースのファイル：`expect` は言語から出力へのマップである。1つのケースで複数の言語を扱える。
- ローワリングのテスト：各パスを、小さな能力の集合で `tir` に対してテストし、すべてのテストの出力にバリデーターを実行する。
- チェッカー：`tsurara-testkit` は言語ごとのチェッカーを持つ（`tsc`、`cargo check`、`dotnet build`、`go vet`、`kotlinc`、`javac`、`swiftc`、`mypy`/`pyright`、PHPStan、`steep`、`godot --headless --check-only`）。ツールチェーンのないチェッカーは、`TSURARA_REQUIRE_CHECKERS` に挙がっていなければテストを飛ばす。CIは言語ごとに1つのジョブを実行する。
- コーパス：13.1の定義を、すべての言語で生成して検査する。
- ランタイム：すべてのランタイムが、すべての適合性テストのベクターを実行する。
- このリポジトリの外のバックエンド：`tsurara test-backend --backend <command> --check <command>` は、バイナリに埋め込んだエッジケースのコーパスと、定義のディレクトリ（`--definitions`。実在の定義のコーパス向け）に対してバックエンドを実行し、各出力ディレクトリでチェッカーのコマンドを実行する。失敗した定義は名前で示し、そのディレクトリを残す。`tsurara spec <dir>` はそのバージョンのランタイムの契約（`spec/`：スキーマ、`README.md`、適合性テストのベクター）を書き出すので、外部のランタイムは、チェックアウトからではなく、テストに使うバイナリからベクターを得る。プロパティベースのテストはこのリポジトリに残す。その定義の生成器は、proptestの上に作ったテストのコードだからである。CIは `examples/backend-typescript` に対してこのコマンドを実行する。

### 18.13 言語の追加 {#1813-adding-a-language}

1. 調査の表（18.2）に行を加える。
2. `docs/languages/<language>.md` を書く。能力、近似の表、変換の方針、配置、オプションである。
3. `NamingPolicy` を実装する。大文字小文字、頭字語、コンテキストごとの予約語、接尾辞、ファイル名である。
4. `tsurara-pretty` でプリンター、配置、目印を実装する。
5. `tsurara-testkit` にチェッカーを、CIにジョブを加え、コーパスを実行する。
6. 実験的なフラグの背後で、型だけを出荷する。
7. `runtimes/<language>/` にランタイムを実装し、適合性テストのベクターを通す。
8. 呼び出し関数を出力する。

別のリポジトリのバックエンドも、プロトコル（18.11）を通して同じ手順をたどる。能力と命名のポリシーをデータとして書いた `describe`（Rustならクレート）、コーパスのテストの代わりに自分のチェッカーを使う `tsurara test-backend`、そしてベクターのための `tsurara spec` である。`docs/guide/backends.md` がそのガイドで、リポジトリの構成と既知のバックエンドの一覧がある。`examples/backend-typescript` がひな形である。

### 18.14 ロードマップ {#1814-roadmap}

| 言語 | バックエンド | ランタイム | 補足 |
|---|---|---|---|
| TypeScript | 既存。`tsurara-lang-typescript` に移す | `@tsurara/client` | 1番目 |
| Python | 型と呼び出し関数。`docs/languages/python.md` | `runtimes/python` の `tsurara-client`：httpx、同期と非同期のクライアント、TypeDefのコーデック | 2番目 |
| Rust | 型と呼び出し関数、実験的。`docs/languages/rust.md` | `runtimes/rust` の `tsurara-client`：`Transport` トレイトの背後のreqwest、`tagged_union!` | 3番目 |
| Go | 型（実験的）と呼び出し関数。`docs/languages/go.md` | `runtimes/go` の `tsurara` パッケージ：標準ライブラリのみ、`*Failure[E]` を伴う `(T, error)` | Rustと並行。unionのない最初の言語 |
| C#、Kotlin、Java、Swift、PHP、Ruby、GDScript | 18.13に従って後で登録する | 後で | |

TypeScriptが最初である。共有のクレートの上に作り直し、基準となる出力であり続ける。Pythonが2番目である。Pythonは、TypeScriptが試さない部分を試す。名前付きの型（dataclass）への引き上げ、スコープ付きのメンバー名（ワイヤー上の名前を伴うsnake_case）、方向による開いたenum、両方向のTypeDefの方針、フィールド名としてのキーワードである。

Pythonは構造的なunionと多重継承を持つので、unionや継承のない言語（Go、Java、C#、GDScript）のためのフォールバックは試さない。そうした言語を追加するまでは、それらのパスは小さな能力の集合を使うローワリングのテストで確かめる。

### 18.15 移行の計画 {#1815-migration-plan}

リファクタリングの段階では、TypeScriptの出力をバイト単位で同一に保つ（既存のスナップショットはすべて変えない）。意図して出力を変える段階は、そう明記する。041は029に依存する。現在はJSONの中の `contentMediaType` の文字列が `Blob | File` になる（`table.yaml` がそれを期待している）からである。029はそれらのスナップショットを意図して変え、単独でレビューするので、041は残りを変えずに保てる。

| Issue | 変更 | 依存先 |
|---|---|---|
| 036 | 未解決の問題を決める。この文書をdesign.mdにマージする | — |
| 037 | クレートに分割する。`Backend` トレイトとレジストリ。TypeScriptを `tsurara-lang-typescript` に移す | 036 |
| 038 | モデルの整数、数値、フォーマット | 037 |
| 039 | 明示的なenumのノード | 037 |
| 040 | 構造化した判別子。`allOf` の構造を保つ | 037 |
| 041 | `Binary`、`BodyKind`、言語ごとの外部の型 | 037、016、029 |
| 042 | `tsurara-naming`：コンテキスト、スコープ、`NamingPolicy`、ワイヤー上の名前。モデルは識別子を持たない | 038〜041、032 |
| 043 | 意味上の警告とバックエンドの警告 | 042、015 |
| 044 | 設定：`language`、言語のセクション、トップレベルのキーの削除 | 042、016 |
| 045 | シリアライズでき、バージョンを持つセマンティックモデル | 042 |
| 047 | ランタイムの契約：OperationDefのスキーマ、Resultの種類、ランタイムの能力、適合性テストのベクター。`@tsurara/client` を移す | 036 |
| 048 | 希望する名前を持つ引き上げの候補 | 042 |
| 049 | CLIでのバックエンドの目印とサイドカー | 037 |
| 050 | 意味のケースのテスト、言語ごとの期待値、チェッカーの枠組み | 045 |
| 051 | `tsurara-lower`：`tir`、能力、共有のパス、バリデーター | 048 |
| 052 | TypeDefの形式、操作との結び付け、デコードとエンコードのベクター | 047、051 |
| 053 | `tsurara-pretty`。TypeScriptのプリンターを移植する | 037 |
| 054 | `describe` を持つ外部バックエンドのプロトコル | 045、044、049 |
| 055 | Pythonバックエンド、型のみ | 043、044、049、050、051、052、053 |
| 056 | `transformModel` フック | 045、017 |

### 18.16 決定事項 {#1816-decisions}

2026-11-10に決定した（以前の草稿の提案を採用した）。

| # | 問題 | 決定 |
|---|---|---|
| Q1 | Pythonのデフォルトの派生 | TypeDefを伴うdataclass。TypedDictとpydanticは後で派生として用意する |
| Q2 | Pythonの生成コードの最低バージョン | 3.11。3.10が2026年10月にサポート終了を迎えたあとも、まだサポートされている最も古いバージョンである。最低バージョンを上げるまで、`type` 文（3.12）は使わない |
| Q3 | 値のないプロパティと `null` をいつ区別するか | 省略可能かつnullableのプロパティだけ。それ以外はすべて、その言語の唯一の省略可能の形を使う |
| Q4 | モデルとランタイムの契約におけるセキュリティスキーム | モデルとOperationDefに保持する。ランタイムは `auth` フックに認証情報を求める（8.1） |
| Q5 | プロジェクトのマニフェストの生成 | デフォルトでは無効。利用者から求めがあれば、後で言語ごとのオプションにする |
| Q6 | 外部バックエンド向けの共有の命名とローワリング | 決定：公開するクレートと、`describe` の `lowering`/`naming` と `generate` の `lowered`/`names`（18.11） |
| Q7 | 共有の規則（整形出力、スコープ付きの命名）に合わせてTypeScriptの出力を変えてよいか | よい。ただし、スナップショットの差分をレビューする別の段階としてだけ行う |

2026-11-09に決定：TypeScriptは、どちらの方向でもenumと判別子を閉じたままにする。挙がっていない値でデコードが失敗する言語では、開いたenumをデフォルトにする（18.5.3）。
