---
title: "Rust"
sourcePath: docs/languages/rust.md
sourceHash: 6f0956554b27
---

Rustバックエンド（`language: rust`、クレート `tsurara-lang-rust`）は、serdeのderiveを付けたstructとenum、そしてランタイムのクレート `tsurara-client`（`runtimes/rust`）を使う非同期の呼び出し関数を生成します。このページでは対応関係を説明します。このバックエンドは実験的です。`tsurara generate` もそう表示し、出力は変わることがあります。

生成コードはRust 1.85（生成器のMSRV）でコンパイルでき、依存するのは `tsurara-client` だけです。`tsurara-client` は `serde` と `serde_json` を再exportしていて、deriveは `#[serde(crate = "tsurara_client::serde")]` でクレートを指定します。そのため利用者が追加する依存関係は1つで済みます。

## 能力 {#capabilities}

`tsurara_lang_rust::CAPABILITIES`（design.md 18.5.2）：

| 能力 | 値 | 補足 |
|---|---|---|
| `inline_records` | no | インラインのオブジェクトは、置かれた場所にちなんだ名前のstructになります（`PetOwner`） |
| `structural_unions` | no | unionはenumになります |
| `tagged_unions` | yes | 判別子で選ぶenum |
| `intersections` | no | `allOf` はフィールドをコピーした1つのstructになります（Rustには継承がありません） |
| `inheritance` | none | |
| `literal_types` | no | `const` はそのスカラー型になります |
| `enums` | any | 文字列のenumはRustのenumです。整数や混在したenumは、そのスカラー型の定数になります |
| `tuples` | yes | 固定長のタプルは `(A, B)`。それ以外のタプルは `Vec<serde_json::Value>` |
| `strict_decoding` | yes | serdeは挙がっていない値で失敗するので、受け取るenumと判別子は開いています |
| `nullable_primitives` | yes | `Option<T>` |
| `recursion_by_value` | no | 循環を閉じるフィールドに `Box<T>` を使います（pass 10）。unionを通る循環も同じです |

## 値の変換 {#value-conversion}

アノテーション（design.md 18.7）：serdeのderiveと属性です。serdeのderiveで表せない構造は `tsurara-client` のマクロを通します。生成コードはマクロを呼び出すだけで、実装は持ちません。OperationDefにTypeDefの参照は含まれません。

## 対応表 {#mapping}

| モデル | Rust |
|---|---|
| オブジェクト | `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] pub struct Pet { ... }` |
| 必須のプロパティ | `pub name: T`。JSONのキーとフィールド名が異なるときは `#[serde(rename = "...")]` を付けます |
| 省略可能なプロパティ | `#[serde(default, skip_serializing_if = "Option::is_none")] pub name: Option<T>` |
| nullを許すプロパティ | `pub name: Option<T>`（`null` は `None`。値がない場合も受け入れる、より広い型です） |
| 省略可能かつnullを許す | `#[serde(default, skip_serializing_if = "Nullable::is_missing")] pub name: tsurara_client::Nullable<T>`。`Missing`、`Null`、`Value(T)` からなるenumです（Q3） |
| `additionalProperties` | `#[serde(flatten)] pub additional_properties: BTreeMap<String, T>` |
| 文字列のenum | `pub enum Status { #[serde(rename = "available")] Available, ... }`。定義に `x-enum-varnames` か `x-enumNames` があれば、バリアントの名前はそこから作ります。値を受け取る箇所では `#[serde(untagged)] Unknown(String)` も加わり、挙がっていない値を保持して、そのまま書き戻します |
| 整数または混在のenum | `pub type Level = i64;` と `pub const LEVEL_1: Level = 1;` |
| 判別子付きのunion | `tsurara_client::tagged_union!` を使った `pub enum Pet { Cat(Cat), Dog(Dog) }`。マクロは判別子を読み、オブジェクト全体からメンバーをデコードします（メンバーはタグのフィールドを保持します）。挙がっていない値は `defaultMapping` のメンバーが受け取り、それがなければ値を受け取る箇所では `Unknown(serde_json::Value)` が受け取ります |
| そのほかのunion（`oneOf`、`anyOf`、型の配列） | `#[serde(untagged)] pub enum Id { Integer(i64), String(String) }`。メンバーは順に試されます。バリアント名はメンバーの型から作ります |
| `allOf` | すべてのメンバーのフィールドを持つ1つのstruct |
| エイリアス | `pub type Name = T;`。自分自身を含むエイリアス（`Tree: { type: array, items: { $ref: Tree } }`）はnewtypeになります：`#[serde(transparent)] pub struct Tree(pub Vec<Tree>);` |
| `$ref` の循環 | 循環を閉じるフィールドに `Box<T>` |
| `integer`（`int32`、`int64`、指定なし） | `i32`、`i64`、`i64` |
| `number` | `f64` |
| `string`（どのフォーマットでも）、`boolean` | `String`、`bool`。フォーマットはドキュメントコメントに書かれ、型マッピングでほかの型を指定できます |
| 配列、マップ | `Vec<T>`、`BTreeMap<String, T>` |
| `{}`、`rust` のエントリがない外部の型 | `serde_json::Value` |
| バイナリ | 送る箇所（本文、マルチパートのパート）では `tsurara_client::File`。レスポンスでは `Vec<u8>` |
| `x-tsurara-type` / 型マッピング | `rust` のエントリ。ジェネリクスを含むパス（`uuid::Uuid`、`chrono::DateTime<chrono::Utc>`）で、073と同じく検査されます |

### 近似 {#approximations}

| 構造 | 近似 |
|---|---|
| nullを許す必須のプロパティ | 値がなければ `None` にデコードします |
| `const` | そのスカラー型 |
| 省略可能な要素や残りの要素を持つタプル | `Vec<serde_json::Value>` |
| タグなしのunion | TypeDefを使うどのランタイムとも同じく、最初にデコードできたメンバーが選ばれます |
| どの値でも選ばれないメンバーを持つ判別子付きのunion | 同じメンバーのタグなしunion（インラインのメンバーは、そのプロパティの `const` か `enum` で選ばれます。それがなければ、何もそのメンバーを指しません） |
| 整数のenum | 検査しません。どの整数もデコードできます |
| 小数で書かれた整数（`1.0`） | 拒否します。TypeDefを使うランタイムは整数に変換します |
| 文字列と数値の制約、`oneOf` の排他性 | 検査しません |

## レイアウトと命名 {#layout-and-naming}

出力先ディレクトリは1つのモジュールです。`mod.rs` が `pub mod types;` と `pub mod operations;` を宣言し、`types/mod.rs` が宣言ごとに1つのモジュール（`types/pet.rs`）を宣言してすべての型を再exportし、各型のモジュールは `use super::*;` で始まります。利用者は `mod api;`（または `#[path = "..."]`）で取り込みます。`Cargo.toml` は生成しません（Q5）。

型はPascalCase、フィールド、関数、モジュールはsnake_case、enumのバリアントと定数はそれぞれの規則どおりの大文字小文字です。キーワードは、フィールドと関数ではraw identifier（`r#type`）になり、型では `Model` が付きます。生成コードが使う名前（`Option`、`Result`、`String`、`Vec`、`Box`、`BTreeMap`、`Nullable`、`File`、`Value`）にも `Model` が付きます。JSONのキーと名前が異なるフィールドには `#[serde(rename = "...")]` が付きます。

## 呼び出し関数と結果 {#call-functions-and-results}

`operations/` に操作ごとに1つの非同期関数があります（`operations/get_pet_by_id.rs`。`operations` から再exportされます）。

```rust
pub async fn get_pet_by_id(
    client: &tsurara_client::Client,
    pet_id: i64,                    // 必須のパラメーター（定義の順）
    options: GetPetByIdOptions,     // 省略可能なパラメーター、省略可能な本文、`timeout`
) -> tsurara_client::ApiResult<Pet, Problem>
```

- 必須のパラメーターと必須の本文は引数です。省略可能なものはすべて、操作ごとの `{Operation}Options` のフィールドになります。この型は `Default` をderiveしています（`get_pet_by_id(&client, 1, Default::default())`）。`null` を許す省略可能なパラメーターでは、`None` は送らないことを意味し、`null` だけを送ることはできません。
- メディアタイプが複数ある本文は、メディアタイプごとにバリアントを持つenum `{Operation}Body` です（`Json(Pet)`、`Form(Pet)`、`OctetStream(tsurara_client::File)`、`Multipart(...)`）。バリアントが `Content-Type` を決めます。
- バイナリの本文とマルチパートのファイルのパートは `tsurara_client::File` で、バイト列と、省略可能なファイル名とメディアタイプを持ちます。マルチパートの本文はstructで、フィールドが順にパートになります。ファイルのリストは、ファイルごとに1つのパートになります。
- `ApiResult<S, E> = Result<Success<S>, Failure<E>>`。`S` は成功時の本文の型、`E` は定義にあるエラーの本文の型です。内容のないレスポンスは `()` です。レスポンスに1つの型と内容のないものがあれば `Option<T>`、型が異なれば `serde_json::Value` です。バイナリのレスポンスは `Vec<u8>`、テキストのレスポンスは `String` です。
- 項目のスキーマ（`itemSchema`、または3.2より前の `x-itemSchema`。design.md 8.5）を持つServer-Sent Events、JSON Lines、JSON text sequencesは、すべての成功レスポンスが項目ごとに読まれる場合、`tsurara_client::Items<T>` になります。関数は `Client::request_items` を呼び、ヘッダーが届いた時点で戻ります。`items.next().await` が各項目を `Result<T, ItemError>` として返します。イベントは `event` でタグ付けされたunionです（`StreamEvent::StreamNoteEvent(StreamNoteEvent)` など。定義に挙がっていない名前には `Unknown`）。`Items` をdropするとレスポンスが閉じます。クライアントのタイムアウトは項目の読み取りには及びません。ストリームと並んでJSONのメディアタイプがあれば、その操作は次の項目のとおりJSONとして読まれます。
- JSONのメディアタイプを持つレスポンスはJSONとして読まれ、ほかのメディアタイプの本文は `Parse` の失敗になります。tsuraraは `Accept` を送らないので、サーバーはデフォルトのメディアタイプで応答します。コーパスのどの定義でも、それはJSONです。
- `Failure` は契約にある種類（定義にある本文か定義にない本文を持つ `Http`、`Network`、`Timeout`、`Parse`、`Unexpected`）を持ち、`std::error::Error` を実装しているので `?` が使えます。futureをdropすると呼び出しはキャンセルされます。Pythonと同じく、`aborted` の結果はありません。
- OperationDefは `spec/operation-def.schema.json` のJSONで、raw文字列として埋め込まれ、1回だけ解析されます（`LazyLock`）。
- `mod.rs` には、コードが必要とするランタイムのバージョンが記録されます（`// Requires tsurara-client ^0.1.0`）。`tsurara check` は、それを最も近い `Cargo.lock` の `tsurara-client` と比べます。

### 使い方 {#using-it}

クレートのディレクトリに生成し（`output: src/api`）、ランタイムを追加して（`cargo add tsurara-client`）、`mod api;` を書きます。

```rust
use api::operations::*;
use api::types::*;
use tsurara_client::{Client, Failure};

let client = Client::builder("https://petstore3.swagger.io/api/v3").build();
let pets = find_pets_by_status(&client, FindPetsByStatusStatus::Available, Default::default()).await?;
match get_pet_by_id(&client, 1, Default::default()).await {
    Ok(pet) => println!("{}", pet.data.name),
    Err(Failure::Http { status: 404, .. }) => println!("no such pet"),
    Err(other) => return Err(other.into()),
}
```

## オプション {#options}

```yaml
language: rust
rust:
  runtimeCrate: tsurara_client   # 生成コードがランタイムを参照するパス
  typeMappings:               # フォーマットごと
    date-time: chrono::DateTime<chrono::Utc>
  overrides:                  # JSON Pointerごと
    "#/components/schemas/Id": uuid::Uuid
```

## クライアントなしで型だけを使う {#types-without-the-client}

`operations: false` では、`mod.rs` は `types`（と、`rust.mocks` のときは `mocks`）だけを宣言し、型は `client` フィーチャーなしのランタイムだけを必要とします。

```toml
[dependencies]
tsurara-client = { version = "0.1", default-features = false }
```

残るのは `Nullable`、`File`、`tagged_union!`、再exportされた `serde` と `serde_json` で、tokioもreqwestも使いません。型はただのserdeの型です。

```rust
let pet: api::types::Pet = tsurara_client::serde_json::from_str(r#"{"id":1,"name":"Pochi"}"#)?;
```

ランタイムのフィーチャー：`client`（クライアント、Result、リトライ、シーケンス。tokioを使います）、`reqwest`（デフォルトのトランスポート。`client` を有効にします）、`testing`（モックのトランスポート）。デフォルトは `client` と `reqwest` です。

## モック {#mocks}

`rust.mocks: true` にすると、モジュール `mocks` が `#[cfg(any(test, feature = "mocks"))]` の下で宣言されます。そのため、クレート自身のテストと、`tsurara-client/testing` を有効にするクレートのフィーチャー `mocks` でコンパイルされます。

- `mocks/schemas.rs`：`mock_pet() -> Pet` はサンプル値をデコードします。フィールドはstruct更新構文で変えられます（`Pet { name: "Tama".into(), ..mock_pet() }`）。
- `mocks/operations.rs`：操作ごとに、定義にあるステータスごとのバリアント（`Status200(Pet)`、`Default(u16, Error)`）を持つ `ShowPetByIdMockResponse` と、`MockTransport` にルートを追加する `show_pet_by_id(mock, respond)` があります。`routes(mock)` は、定義にある最初の成功レスポンスを返すルートをすべての操作について追加します。

## コンパイル時間 {#compile-time}

すべての型は `Serialize`、`Deserialize`、`Debug`、`Clone`、`PartialEq` をderiveし、それぞれ独自のモジュールにあります。Apple Siliconのノートパソコン（2026-11-17）で、呼び出し関数を含む出力の `cargo clippy` にかかる時間は、OpenAI（6,200型）で約40秒、GitHub 3.1（8,200型、1,270操作）で110秒、Stripe（11,400型）で100秒です。OpenAIの型だけの `cargo check` は14秒です。

各型のモジュールは、使う型を名前でimportします（`use super::{Owner, Tag};`）。以前のバージョンは親モジュールをglob（`use super::*`）でimportしていて、その `pub use` のglobはすべての型のモジュールに及んでいました。そのため名前解決が2乗の時間になり、OpenAIの `cargo check` の95秒のうち80秒を占めていました（`-Z time-passes`：`resolve_crate` 52秒、`compute_effective_visibilities` 29秒）。deriveの展開は23秒でした。Stripeは90分たっても終わりませんでした。修正後に残る時間は、型検査、借用検査、deriveの展開にほぼ等分にかかっています。

生成コードは利用者のクレートのモジュールです。独立したクレートに置けば、インクリメンタルな再ビルドの対象から外せます。出力をタグごとにフィーチャーへ分けることや、型が使われる方向の分だけをderiveすることは、修正後には効果が小さいため行っていません。
