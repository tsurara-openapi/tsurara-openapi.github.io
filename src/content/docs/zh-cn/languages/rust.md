---
title: "Rust"
sourcePath: docs/languages/rust.md
sourceHash: 6f0956554b27
---

Rust 后端（`language: rust`，crate `tsurara-lang-rust`）生成带有 serde derive 的 struct 和 enum，以及使用运行时 crate `tsurara-client`（`runtimes/rust`）的异步调用函数。本页说明映射关系。该后端是实验性的：`tsurara generate` 会这样提示，其输出可能会改变。

生成的代码可用 Rust 1.85（生成器的 MSRV）编译，并且只依赖 `tsurara-client`，它重新导出了 `serde` 和 `serde_json`：derive 通过 `#[serde(crate = "tsurara_client::serde")]` 指定 crate，因此用户只需添加一个依赖。

## 能力 {#capabilities}

`tsurara_lang_rust::CAPABILITIES`（design.md 18.5.2）：

| 能力 | 值 | 说明 |
|---|---|---|
| `inline_records` | no | 内联对象变为以其所在位置命名的 struct（`PetOwner`） |
| `structural_unions` | no | 联合类型变为 enum |
| `tagged_unions` | yes | 由判别字段选择的 enum |
| `intersections` | no | `allOf` 变为一个复制了字段的 struct（Rust 没有继承） |
| `inheritance` | none | |
| `literal_types` | no | `const` 使用其标量类型 |
| `enums` | any | 字符串枚举是 Rust enum；整数和混合枚举变为其标量类型的常量 |
| `tuples` | yes | 定长元组为 `(A, B)`；其他元组为 `Vec<serde_json::Value>` |
| `strict_decoding` | yes | serde 遇到未列出的值会失败，因此接收的枚举和判别字段是开放的 |
| `nullable_primitives` | yes | `Option<T>` |
| `recursion_by_value` | no | 在闭合循环的字段上使用 `Box<T>`（pass 10），经过联合类型的循环也是如此 |

## 值的转换 {#value-conversion}

注解（design.md 18.7）：serde 的 derive 和属性。serde derive 无法表达的结构通过 `tsurara-client` 的宏处理，生成的代码只调用这些宏而不实现它们。OperationDef 中不包含 TypeDef 引用。

## 映射 {#mapping}

| 模型 | Rust |
|---|---|
| 对象 | `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] pub struct Pet { ... }` |
| 必需属性 | `pub name: T`，当 JSON 键与字段名不同时加上 `#[serde(rename = "...")]` |
| 可选属性 | `#[serde(default, skip_serializing_if = "Option::is_none")] pub name: Option<T>` |
| 可空属性 | `pub name: Option<T>`（`null` 为 `None`；也接受缺失的值，是更宽的类型） |
| 可选且可空 | `#[serde(default, skip_serializing_if = "Nullable::is_missing")] pub name: tsurara_client::Nullable<T>`，一个由 `Missing`、`Null` 和 `Value(T)` 组成的 enum（Q3） |
| `additionalProperties` | `#[serde(flatten)] pub additional_properties: BTreeMap<String, T>` |
| 字符串枚举 | `pub enum Status { #[serde(rename = "available")] Available, ... }`，定义中有 `x-enum-varnames` 或 `x-enumNames` 时变体名由它们生成；在接收值的位置还有 `#[serde(untagged)] Unknown(String)`，它保留未列出的值并原样写回 |
| 整数或混合枚举 | `pub type Level = i64;` 以及 `pub const LEVEL_1: Level = 1;` |
| 带判别字段的联合类型 | 使用 `tsurara_client::tagged_union!` 的 `pub enum Pet { Cat(Cat), Dog(Dog) }`，它读取判别字段并从整个对象解码成员（成员保留其标签字段）；未列出的值由 `defaultMapping` 成员接收，没有时在接收值的位置由 `Unknown(serde_json::Value)` 接收 |
| 其他联合类型（`oneOf`、`anyOf`、类型数组） | `#[serde(untagged)] pub enum Id { Integer(i64), String(String) }`，按顺序尝试成员；变体名来自成员类型 |
| `allOf` | 一个包含所有成员字段的 struct |
| 别名 | `pub type Name = T;`；包含自身的别名（`Tree: { type: array, items: { $ref: Tree } }`）是 newtype：`#[serde(transparent)] pub struct Tree(pub Vec<Tree>);` |
| `$ref` 循环 | 在闭合循环的字段上使用 `Box<T>` |
| `integer`（`int32`、`int64`、无） | `i32`、`i64`、`i64` |
| `number` | `f64` |
| `string`（任意格式）、`boolean` | `String`、`bool`；格式写在文档注释中，类型映射可以指定其他类型 |
| 数组、映射 | `Vec<T>`、`BTreeMap<String, T>` |
| `{}`、没有 `rust` 条目的外部类型 | `serde_json::Value` |
| 二进制 | 发送的位置（请求体、multipart 部分）为 `tsurara_client::File`；响应为 `Vec<u8>` |
| `x-tsurara-type` / 类型映射 | 其中的 `rust` 条目，一个可带泛型的路径（`uuid::Uuid`、`chrono::DateTime<chrono::Utc>`），与 073 一样会被检查 |

### 近似 {#approximations}

| 结构 | 近似方式 |
|---|---|
| 可空的必需属性 | 缺失的值解码为 `None` |
| `const` | 其标量类型 |
| 带可选元素或剩余元素的元组 | `Vec<serde_json::Value>` |
| 不带标签的联合类型 | 与所有 TypeDef 运行时一样，第一个能解码的成员胜出 |
| 含有任何值都无法选中的成员的带判别字段联合类型 | 具有相同成员的不带标签联合类型（内联成员通过其属性的 `const` 或 `enum` 选中；没有时，没有任何值指向它） |
| 整数枚举 | 不检查：任何整数都能解码 |
| 带小数写法的整数（`1.0`） | 拒绝，而 TypeDef 运行时会将其转换 |
| 字符串和数字约束、`oneOf` 的互斥性 | 不检查 |

## 布局与命名 {#layout-and-naming}

输出目录是一个模块：`mod.rs` 声明 `pub mod types;` 和 `pub mod operations;`，`types/mod.rs` 为每个声明声明一个模块（`types/pet.rs`）并重新导出所有类型，每个类型模块以 `use super::*;` 开头。用户通过 `mod api;`（或 `#[path = "..."]`）引入它。不会生成 `Cargo.toml`（Q5）。

类型使用 PascalCase，字段、函数和模块使用 snake_case，枚举变体和常量按各自的规则使用相应的大小写。关键字在字段和函数中变为原始标识符（`r#type`），在类型中加上 `Model`；生成的代码所使用的名称（`Option`、`Result`、`String`、`Vec`、`Box`、`BTreeMap`、`Nullable`、`File`、`Value`）也会加上 `Model`。JSON 键与名称不同的字段会带上 `#[serde(rename = "...")]`。

## 调用函数与结果 {#call-functions-and-results}

`operations/` 中每个操作一个异步函数（`operations/get_pet_by_id.rs`，从 `operations` 重新导出）：

```rust
pub async fn get_pet_by_id(
    client: &tsurara_client::Client,
    pet_id: i64,                    // 必需参数，按定义中的顺序
    options: GetPetByIdOptions,     // 可选参数、可选的请求体以及 `timeout`
) -> tsurara_client::ApiResult<Pet, Problem>
```

- 必需参数和必需的请求体是函数参数。所有可选内容都是该操作的 `{Operation}Options` 的字段，它派生了 `Default`（`get_pet_by_id(&client, 1, Default::default())`）。对于允许 `null` 的可选参数，`None` 表示不发送；无法单独发送 `null`。
- 有多种媒体类型的请求体是一个 enum `{Operation}Body`，每种媒体类型对应一个变体（`Json(Pet)`、`Form(Pet)`、`OctetStream(tsurara_client::File)`、`Multipart(...)`）；变体决定 `Content-Type`。
- 二进制请求体和 multipart 文件部分为 `tsurara_client::File`：字节，以及可选的文件名和媒体类型。multipart 请求体是一个 struct，其字段按顺序成为各个部分；文件列表中的每个文件各成为一个部分。
- `ApiResult<S, E> = Result<Success<S>, Failure<E>>`。`S` 是成功响应体的类型，`E` 是定义中声明的错误响应体的类型。没有内容的响应为 `()`。当响应中有一个类型和一个无内容的响应时，为 `Option<T>`；类型不同时，为 `serde_json::Value`。二进制响应为 `Vec<u8>`，文本响应为 `String`。
- 带有条目 schema（`itemSchema`，或 3.2 之前的 `x-itemSchema`；design.md 8.5）的 Server-Sent Events、JSON Lines 和 JSON text sequences，在所有成功响应都逐条读取时为 `tsurara_client::Items<T>`：函数调用 `Client::request_items`，并在响应头到达后返回，`items.next().await` 以 `Result<T, ItemError>` 的形式给出每个条目。事件是以 `event` 为标签的联合类型（`StreamEvent::StreamNoteEvent(StreamNoteEvent)` 等，定义中未列出的名称为 `Unknown`）。drop `Items` 会关闭响应，客户端的超时不覆盖读取条目的过程。当流旁边还有 JSON 媒体类型时，该操作按下一条所述以 JSON 读取。
- 带 JSON 媒体类型的响应以 JSON 读取，其他媒体类型的响应体为 `Parse` 失败。tsurara 不发送 `Accept`，因此服务器以其默认媒体类型作答，对语料库中的每个定义来说都是 JSON。
- `Failure` 具有契约中的种类（带有已声明或未声明响应体的 `Http`、`Network`、`Timeout`、`Parse`、`Unexpected`），并实现了 `std::error::Error`，因此可以使用 `?`。drop future 会取消调用；与 Python 一样，没有 `aborted` 结果。
- OperationDef 是 `spec/operation-def.schema.json` 的 JSON，以原始字符串嵌入，并只解析一次（`LazyLock`）。
- `mod.rs` 记录了代码所需的运行时版本（`// Requires tsurara-client ^0.1.0`）；`tsurara check` 会将其与最近的 `Cargo.lock` 中的 `tsurara-client` 进行比较。

### 使用方法 {#using-it}

生成到你的 crate 的某个目录中（`output: src/api`），添加运行时（`cargo add tsurara-client`），并写上 `mod api;`：

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

## 选项 {#options}

```yaml
language: rust
rust:
  runtimeCrate: tsurara_client   # 生成的代码引用运行时所用的路径
  typeMappings:               # 按格式
    date-time: chrono::DateTime<chrono::Utc>
  overrides:                  # 按 JSON Pointer
    "#/components/schemas/Id": uuid::Uuid
```

## 不使用客户端的类型 {#types-without-the-client}

使用 `operations: false` 时，`mod.rs` 只声明 `types`（使用 `rust.mocks` 时还有 `mocks`），类型只需要不带 `client` 特性的运行时：

```toml
[dependencies]
tsurara-client = { version = "0.1", default-features = false }
```

剩下的是 `Nullable`、`File`、`tagged_union!` 以及重新导出的 `serde` 和 `serde_json`：不需要 tokio 和 reqwest。这些类型就是普通的 serde 类型：

```rust
let pet: api::types::Pet = tsurara_client::serde_json::from_str(r#"{"id":1,"name":"Pochi"}"#)?;
```

运行时的特性：`client`（客户端、Result、重试、序列；使用 tokio）、`reqwest`（默认的传输层，会启用 `client`）、`testing`（Mock 传输层）。默认为 `client` 和 `reqwest`。

## Mock {#mocks}

使用 `rust.mocks: true` 时，模块 `mocks` 在 `#[cfg(any(test, feature = "mocks"))]` 下声明，因此会在 crate 自身的测试中，以及启用会开启 `tsurara-client/testing` 的 crate 特性 `mocks` 时编译：

- `mocks/schemas.rs`：`mock_pet() -> Pet` 解码示例值；可用结构体更新语法修改字段（`Pet { name: "Tama".into(), ..mock_pet() }`）。
- `mocks/operations.rs`：每个操作都有 `ShowPetByIdMockResponse`，其中每个定义中声明的状态码对应一个变体（`Status200(Pet)`、`Default(u16, Error)`），以及 `show_pet_by_id(mock, respond)`，它把路由添加到 `MockTransport`；`routes(mock)` 为每个操作添加返回其第一个成功响应的路由。

## 编译时间 {#compile-time}

每个类型都派生 `Serialize`、`Deserialize`、`Debug`、`Clone` 和 `PartialEq`，并位于自己的模块中。在一台 Apple Silicon 笔记本（2026-11-17）上，对包含调用函数的输出运行 `cargo clippy`，OpenAI（6,200 个类型）约需 40 秒，GitHub 3.1（8,200 个类型，1,270 个操作）需 110 秒，Stripe（11,400 个类型）需 100 秒；仅 OpenAI 类型的 `cargo check` 需 14 秒。

每个类型模块按名称导入它用到的类型（`use super::{Owner, Tag};`）。早期版本用 glob（`use super::*`）导入父模块，而父模块的 `pub use` glob 覆盖了所有类型模块：名称解析变成了平方级复杂度，占用了 OpenAI 的 `cargo check` 95 秒中的 80 秒（`-Z time-passes`：`resolve_crate` 52 秒，`compute_effective_visibilities` 29 秒），而 derive 展开占 23 秒。Stripe 在 90 分钟内都没有完成。修复后剩余的时间大致平均地花在类型检查、借用检查和 derive 展开上。

生成的代码是用户 crate 中的一个模块；把它放在单独的 crate 中，可以使其不参与增量重建。按标签把输出拆分为不同特性，以及只派生类型被使用方向所需的 trait，在修复之后收益很小，因此没有这样做。
