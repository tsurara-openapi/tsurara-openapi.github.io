---
title: "Types"
sourcePath: docs/guide/types.md
sourceHash: 7a7d7e6677c5
---

How schemas become TypeScript types. The rules are fixed and each row is a test (design.md 6.4); Python has its own table in [docs/languages/python.md](../../languages/python/).

| Schema | TypeScript |
|---|---|
| `type: string`, `integer`, `number`, `boolean`, `null` | `string`, `number`, `number`, `boolean`, `null` |
| `format: date-time`, `uuid`, `int64`, ... | The base type (`string`, `number`); the format goes in JSDoc. `typeMappings` can name another type that JSON parsing produces (a branded string, for example) |
| `enum` | A union of literals (`'a' \| 'b'`); `enumStyle: const` adds an object of the values, keyed by `x-enum-varnames` or `x-enumNames` when the definition has them, in the case `naming.enumKeyCase` asks for |
| `const` | A literal type |
| `nullable: true` (3.0), `type: [string, "null"]` (3.1) | `string \| null` |
| `type: object` with `properties` | An object type; properties not in `required` are optional (`a?: T`) |
| `additionalProperties: { ... }` with properties | An index signature whose value is the union of that schema and every property type (TypeScript requires it) |
| `type: object` with no properties | `{ [key: string]: unknown }` |
| `additionalProperties: false` and no properties | `{ [key: string]: never }` |
| `type: array`, `items` | `T[]` |
| `prefixItems` | A tuple: elements up to `minItems` are required, the rest optional, `items` gives the rest element |
| `oneOf`, `anyOf` | A union |
| `allOf` | Inline objects merge into one object type; named members stay references, intersected with at most one object literal (`Base & { extra?: string }`) |
| `discriminator` | Each member intersected with its tag (`{ petType: 'cat' }`), so `switch (pet.petType)` narrows. A member that already requires the property as that `const` is not intersected |
| A `text/event-stream` response with `itemSchema` (3.2) or `x-itemSchema` | `AsyncIterable<StreamEvent>`, where `StreamEvent` is `{ event: 'note'; data: Note; id?: string; retry?: number } \| ...` ([Server-Sent Events](../client/#server-sent-events)) |
| An `application/jsonl`, `application/x-ndjson` or `application/json-seq` response with `itemSchema` or `x-itemSchema` | `AsyncIterable<ListItem>`, where `ListItem` is the item schema's type; the client parses each item |
| Other streams (`text/event-stream` or JSON Lines without an item schema, ...) | `ReadableStream<Uint8Array>` |
| `readOnly` / `writeOnly` | With `splitVisibility` (default), `Pet` for responses (no writeOnly properties) and `PetWritable` for requests (no readOnly properties) |
| `$ref` | The named type; cycles always go through a named type |
| `{}`, `true` | `unknown` |
| `false` | `never` |
| A binary body (`application/octet-stream`, images, ...) or a multipart part with `format: binary` | `Blob \| File` |
| `format: binary` inside a JSON value | `string` (a JSON string cannot hold bytes; warned about) |
| `x-tsurara-type` | The `typescript` entry |

## Exact, approximated, rejected

Types cannot express every constraint. For each keyword tsurara decides in advance how it is handled; one inexpressible keyword never turns the whole type into `unknown`.

| Handling | Keywords | What you get |
|---|---|---|
| Exact | `type`, `enum`, `const`, `required`, nullable, `properties`, `allOf` of objects, `prefixItems` | The type alone expresses the rule |
| Wider type | `oneOf` exclusivity, string and number constraints (`minLength`, `pattern`, `minimum`, ...), `uniqueItems`, `patternProperties` patterns, the long-tuple cases of `prefixItems` | The type also accepts some values the definition does not; the constraint is in JSDoc. No warning |
| Keyword dropped | `not`, `if`/`then`/`else`, `dependentSchemas`, references that do not resolve | The type is built from the other keywords, with a warning. `tsurara generate --strict` makes warnings errors |
| Rejected | Type mappings that change what JSON parsing produces (`Date`, `bigint`) | A configuration error |

## Operation types

Each operation file has the call function, its OperationDef, and types named after the function:

| Type | |
|---|---|
| `GetPetData` | The input: `path`, `query`, `headers`, `cookies`, `body` |
| `GetPetResponses` / `GetPetErrors` | Body types per documented status |
| `GetPetResult` | What the function returns: success members, documented errors, an undocumented-status member, and the transport failures |
| `GetPetResponseHeaders` | Typed response headers, when the definition has them |

When a schema already has one of these names, the operation's type moves aside (`GetPetOperationResult`) with a warning; the function keeps its name.

## Types without the client

`operations: false` emits the declarations only, for DTOs on a server, payloads of a message queue, or requests made with another HTTP library:

```yaml
input: openapi.yaml
output: src/types
operations: false
```

The output has the schemas, webhooks and event channels, and no `operations/`, OperationDefs or call functions. Each language then needs only the types layer of its runtime, with no HTTP client:

| Language | What the types need |
|---|---|
| TypeScript | Nothing: `schemas/` imports no module, and `index.ts` records no runtime version. Event channels (`channels/`, `zod/channels.ts`) import `decodeMessage` and `ChannelSchemas` from `@tsurara/client`, which send nothing |
| Python | `tsurara-client` without extras: `import tsurara_client` and the TypeDef codec work without httpx. Call functions need `tsurara-client[http]` |
| Rust | `tsurara-client = { version = "0.1", default-features = false }`: no tokio, no reqwest |
| Go | The runtime module; generated types use only its union helpers and do not import `net/http` |

The language pages show how to decode a value with the types alone.
