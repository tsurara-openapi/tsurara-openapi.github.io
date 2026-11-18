---
title: "Rust"
sourcePath: docs/languages/rust.md
sourceHash: f5fc7d1552f6
---

The Rust backend (`language: rust`, crate `tsurara-lang-rust`) generates structs and enums with serde derives, and async call functions for the runtime crate `tsurara-client` (`runtimes/rust`). This document describes the mapping. The backend is experimental: `tsurara generate` says so, and its output may change.

Generated code compiles with Rust 1.85 (the generator's MSRV) and depends only on `tsurara-client`, which re-exports `serde` and `serde_json`: derives name the crate with `#[serde(crate = "tsurara_client::serde")]`, so users add one dependency.

## Capabilities

`tsurara_lang_rust::CAPABILITIES` (design.md 18.5.2):

| Capability | Value | Notes |
|---|---|---|
| `inline_records` | no | Inline objects become structs named after their place (`PetOwner`) |
| `structural_unions` | no | Unions become enums |
| `tagged_unions` | yes | Enums selected by the discriminator |
| `intersections` | no | `allOf` becomes one struct with the fields copied (Rust has no inheritance) |
| `inheritance` | none | |
| `literal_types` | no | A `const` is its scalar type |
| `enums` | any | String enums are Rust enums; integer and mixed enums become constants of their scalar type |
| `tuples` | yes | Fixed-length tuples `(A, B)`; other tuples `Vec<serde_json::Value>` |
| `strict_decoding` | yes | serde fails on unlisted values, so received enums and discriminators are open |
| `nullable_primitives` | yes | `Option<T>` |
| `recursion_by_value` | no | `Box<T>` on fields that close a cycle (pass 10), also cycles through unions |

## Value conversion

Annotations (design.md 18.7): serde derives and attributes. Constructs serde's derives cannot express go through macros of `tsurara-client`, which generated code invokes but does not implement. OperationDefs carry no TypeDef references.

## Mapping

| Model | Rust |
|---|---|
| Object | `#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)] pub struct Pet { ... }` |
| Required property | `pub name: T`, with `#[serde(rename = "...")]` when the JSON key differs from the field name |
| Optional property | `#[serde(default, skip_serializing_if = "Option::is_none")] pub name: Option<T>` |
| Nullable property | `pub name: Option<T>` (`null` is `None`; a missing value is accepted too, a wider type) |
| Optional and nullable | `#[serde(default, skip_serializing_if = "Nullable::is_missing")] pub name: tsurara_client::Nullable<T>`, an enum of `Missing`, `Null` and `Value(T)` (Q3) |
| `additionalProperties` | `#[serde(flatten)] pub additional_properties: BTreeMap<String, T>` |
| String enum | `pub enum Status { #[serde(rename = "available")] Available, ... }`; where values are received, also `#[serde(untagged)] Unknown(String)`, which keeps an unlisted value and writes it back |
| Integer or mixed enum | `pub type Level = i64;` with `pub const LEVEL_1: Level = 1;` |
| Discriminated union | `pub enum Pet { Cat(Cat), Dog(Dog) }` with `tsurara_client::tagged_union!`, which reads the discriminator and decodes the member from the whole object (the member keeps its tag field); the `defaultMapping` member takes unlisted values, and otherwise, where received, `Unknown(serde_json::Value)` does |
| Other unions (`oneOf`, `anyOf`, type arrays) | `#[serde(untagged)] pub enum Id { Integer(i64), String(String) }`, members tried in order; variant names from the member types |
| `allOf` | One struct with the fields of every member |
| Alias | `pub type Name = T;`; an alias that contains itself (`Tree: { type: array, items: { $ref: Tree } }`) is a newtype, `#[serde(transparent)] pub struct Tree(pub Vec<Tree>);` |
| `$ref` cycles | `Box<T>` on the fields that close the cycle |
| `integer` (`int32`, `int64`, none) | `i32`, `i64`, `i64` |
| `number` | `f64` |
| `string` (any format), `boolean` | `String`, `bool`; formats are in the docs, and type mappings can name other types |
| Array, map | `Vec<T>`, `BTreeMap<String, T>` |
| `{}`, external without a `rust` entry | `serde_json::Value` |
| Binary | `tsurara_client::File` where sent (bodies, multipart parts); `Vec<u8>` for responses |
| `x-tsurara-type` / type mappings | The `rust` entry, a path with generics (`uuid::Uuid`, `chrono::DateTime<chrono::Utc>`), checked like 073 |

### Approximations

| Construct | Approximation |
|---|---|
| Nullable required properties | A missing value decodes as `None` |
| `const` | Its scalar type |
| Tuples with optional or rest elements | `Vec<serde_json::Value>` |
| Untagged unions | The first member that decodes wins, as in every TypeDef runtime |
| Discriminated unions with a member no value selects | An untagged union with the same members (an inline member selects by its property's `const` or `enum`; without one, nothing names it) |
| Integer enums | Not checked: any integer decodes |
| Integers written with a fraction (`1.0`) | Rejected, where the TypeDef runtimes coerce them |
| String and number constraints, `oneOf` exclusivity | Not checked |

## Layout and naming

The output directory is a module: `mod.rs` declares `pub mod types;` and `pub mod operations;`, `types/mod.rs` declares one module per declaration (`types/pet.rs`) and re-exports every type, and each type module starts with `use super::*;`. Users include it with `mod api;` (or `#[path = "..."]`). No `Cargo.toml` is generated (Q5).

Types are PascalCase, fields, functions and modules snake_case, enum variants and constants as their case requires. Keywords become raw identifiers for fields and functions (`r#type`), and get `Model` as types; names the generated code uses (`Option`, `Result`, `String`, `Vec`, `Box`, `BTreeMap`, `Nullable`, `File`, `Value`) get `Model` too. A field whose JSON key differs gets `#[serde(rename = "...")]`.

## Call functions and results

One async function per operation in `operations/` (`operations/get_pet_by_id.rs`, re-exported from `operations`):

```rust
pub async fn get_pet_by_id(
    client: &tsurara_client::Client,
    pet_id: i64,                    // required parameters, in definition order
    options: GetPetByIdOptions,     // optional parameters, an optional body, and `timeout`
) -> tsurara_client::ApiResult<Pet, Problem>
```

- Required parameters and a required body are arguments. Everything optional is a field of the operation's `{Operation}Options`, which derives `Default` (`get_pet_by_id(&client, 1, Default::default())`). For an optional parameter that allows `null`, `None` leaves it out; `null` cannot be sent on its own.
- A body with several media types is an enum `{Operation}Body` with one variant per media type (`Json(Pet)`, `Form(Pet)`, `OctetStream(tsurara_client::File)`, `Multipart(...)`); the variant picks the `Content-Type`.
- Binary bodies and multipart file parts are `tsurara_client::File`: bytes with an optional file name and media type. A multipart body is a struct whose fields become parts in order; a list of files becomes one part per file.
- `ApiResult<S, E> = Result<Success<S>, Failure<E>>`. `S` is the success body type and `E` the documented error body type. A response without content is `()`. When the responses have one type and no content, it is `Option<T>`; when they have different types, `serde_json::Value`. Binary responses are `Vec<u8>`, text responses `String`.
- Server-Sent Events, JSON Lines and JSON text sequences with an item schema (`itemSchema`, or `x-itemSchema` before 3.2; design.md 8.5) are `tsurara_client::Items<T>` when every success is read item by item: the function calls `Client::request_items` and returns once the headers have arrived, and `items.next().await` gives each item as `Result<T, ItemError>`. Events are a union tagged by `event` (`StreamEvent::StreamNoteEvent(StreamNoteEvent)` and so on, and `Unknown` for names the definition does not list). Dropping `Items` closes the response, and the client's timeout does not cover reading the items. With a JSON media type next to the stream, the operation is read as JSON as below.
- A response with a JSON media type is read as JSON, and a body in its other media types is a `Parse` failure. tsurara sends no `Accept`, so servers answer with their default media type, which is JSON for every corpus definition.
- `Failure` has the contract's kinds (`Http` with a documented or undocumented body, `Network`, `Timeout`, `Parse`, `Unexpected`) and implements `std::error::Error`, so `?` works. Dropping the future cancels the call; there is no `aborted` result, as in Python.
- OperationDefs are the JSON of `spec/operation-def.schema.json`, embedded as a raw string and parsed once (`LazyLock`).
- `mod.rs` records the runtime version the code needs (`// Requires tsurara-client ^0.1.0`); `tsurara check` compares it with `tsurara-client` in the nearest `Cargo.lock`.

### Using it

Generate into a directory of your crate (`output: src/api`), add the runtime (`cargo add tsurara-client`) and `mod api;`:

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

## Options

```yaml
language: rust
rust:
  runtimeCrate: tsurara_client   # the path generated code uses for the runtime
  typeMappings:               # per format
    date-time: chrono::DateTime<chrono::Utc>
  overrides:                  # per JSON Pointer
    "#/components/schemas/Id": uuid::Uuid
```

## Types without the client

With `operations: false`, `mod.rs` declares only `types` (and `mocks` with `rust.mocks`), and the types need the runtime without its `client` feature:

```toml
[dependencies]
tsurara-client = { version = "0.1", default-features = false }
```

That leaves `Nullable`, `File`, `tagged_union!` and the re-exported `serde` and `serde_json`: no tokio, no reqwest. The types are plain serde types:

```rust
let pet: api::types::Pet = tsurara_client::serde_json::from_str(r#"{"id":1,"name":"Pochi"}"#)?;
```

The runtime's features: `client` (the client, Results, retries, sequences; tokio), `reqwest` (the default transport, enables `client`), `testing` (the mock transport). The default is `client` and `reqwest`.

## Mocks

With `rust.mocks: true`, the module `mocks` is declared under `#[cfg(any(test, feature = "mocks"))]`, so it is compiled for the crate's own tests and with a crate feature `mocks` that enables `tsurara-client/testing`:

- `mocks/schemas.rs`: `mock_pet() -> Pet` decodes the sample value; change fields with struct update syntax (`Pet { name: "Tama".into(), ..mock_pet() }`).
- `mocks/operations.rs`: per operation, `ShowPetByIdMockResponse` with a variant per documented status (`Status200(Pet)`, `Default(u16, Error)`) and `show_pet_by_id(mock, respond)`, which adds the route to a `MockTransport`; `routes(mock)` adds every operation with its first documented success.

## Compile time

Every type derives `Serialize`, `Deserialize`, `Debug`, `Clone` and `PartialEq`, and lives in its own module. On an Apple Silicon laptop (2026-11-17), `cargo clippy` of the output with call functions takes about 40 seconds for OpenAI (6,200 types), 110 seconds for GitHub 3.1 (8,200 types, 1,270 operations) and 100 seconds for Stripe (11,400 types); `cargo check` of OpenAI's types alone takes 14 seconds.

Each type module imports the types it uses by name (`use super::{Owner, Tag};`). Earlier versions imported their parent with a glob (`use super::*`), whose `pub use` globs cover every type module: name resolution became quadratic, and took 80 of OpenAI's 95 seconds of `cargo check` (`-Z time-passes`: `resolve_crate` 52 s, `compute_effective_visibilities` 29 s) while derive expansion took 23. Stripe did not finish in 90 minutes. What remains is spent in type checking, borrow checking and derive expansion, in about equal parts.

Generated code is a module of the user's crate; putting it in a crate of its own keeps it out of incremental rebuilds. Splitting the output by tag into features, and deriving only the direction a type is used in, would save little after the fix, and are not done.
