---
title: "tsurara design"
sourcePath: docs/design.md
sourceHash: faa01e846180
---

This document describes the design of tsurara, a tool that generates TypeScript types and API call functions from OpenAPI definitions.

- Status: in implementation
- Last updated: 2026-11-10

tsurara is being restructured to generate many languages, not only TypeScript. The target architecture is chapter 18; where it differs from chapters 4, 6, 7, 10 and 11, those chapters describe the current implementation.

## 1. Purpose

There is no de facto standard tool for generating TypeScript from OpenAPI. The established ones generate wrong types from complex schemas, slow down type checking on large definitions, and put serialization into generated code, among other problems (chapter 3); tsurara exists because of those problems in the output, not because of the state of other projects.

As of November 2026: openapi-typescript, whose structure is close to ideal, was put into maintenance mode by its maintainer on 2026-09-19 and will not be updated ([issue 2874](https://github.com/openapi-ts/openapi-typescript/issues/2874)); its 2026 roadmap of 2025-12-29 had already moved openapi-fetch and openapi-react-query to maintenance ([discussion 2559](https://github.com/openapi-ts/openapi-typescript/discussions/2559)). hey-api (`@hey-api/openapi-ts`), whose types are close to ideal, released about weekly until 0.99.0 on 2026-06-22 and has published only `next` prereleases since (the npm registry, checked 2026-11-11).

tsurara is built to replace them. The generator is written in Rust and shipped as a single binary, and the runtime library used by generated code is shipped as the npm package `@tsurara/client`.

## 2. Requirements

| # | Requirement |
|---|---|
| R1 | Implement the generator in Rust |
| R2 | In a pnpm workspace monorepo, multiple apps can share one generated output. Each app can vary its logging, tracing, connection headers, and so on |
| R3 | Generated code satisfies TypeScript's `erasableSyntaxOnly` |
| R4 | Split the output into multiple files to make Git conflicts unlikely |
| R5 | Cover the OpenAPI specification (3.0, 3.1, 3.2; 2.0 is converted to 3.0, see 5.4) |
| R6 | Definitions can be loaded from both local files and URLs |
| R7 | Generate a call function per operation, not just types |
| R8 | Generate other languages from the same definition, each with types first and then call functions and a runtime library (chapter 18) |

R7 means tsurara does not use the approach of inferring types through a generic function such as openapi-fetch's `client.GET('/pet/{id}', ...)`. That approach makes inference heavy, and it is hard to extract the return type. tsurara generates one function per operation with concrete parameter and return types.

## 3. Problems with existing tools and tsurara's approach

The main complaints about existing tools, matched with tsurara's approach to each. Details are in the chapters in parentheses.

| Problem with existing tools | tsurara's approach |
|---|---|
| Wrong or invalid types from `allOf`/`oneOf`/discriminator/nullable/cycles | Normalize in an intermediate representation (IR) before output (6.3). Fix the conversion rules as a mapping table and test every row (6.4, 13) |
| Unintended `unknown` or `Record<string, never>` | Decide the output with the mapping table, and report approximations as warnings (6.4, 6.8) |
| Output changes with order or placement. Intersections are hard to read | Flatten allOf, and make schemas with the same meaning produce the same output (6.3) |
| IntelliSense is slow on large definitions. "excessively deep" errors | Do not build structures that index into huge types. Emit the Result type as an expanded union (7.4) |
| `text/plain` and the like are parsed as JSON and crash at runtime | Decide how to parse responses (parseAs) automatically from the media type in the definition (8.5) |
| Generated code does not compile | Run tests in CI that pass output from large real-world definitions and edge-case definitions through `tsc` with several tsconfigs (13) |
| `@type` becomes `_type`. Reserved words produce invalid types. Casing settings change names unexpectedly | Do not transform property names; quote them. Pass identifiers through a single sanitizer. Do not transform schema names by default (6.6) |
| Bugs in generated multipart code, such as duplicate `formData.append` | Do not write multipart construction in generated code; keep it in the runtime library (8.5) |
| Post-processing with regular expressions after generation is the only option | Let plugins hook into the IR (11) |
| Results depend on plugin registration order | Plugins declare the stage they hook into and do not depend on registration order (11) |
| `throwOnError` throws raw JSON and loses the status | `unwrap()` throws an `ApiError` that extends `Error` (8.3) |
| bigint and Date types do not match runtime values | Reject type mappings that disagree with runtime values (10.4) |
| Drift from the specification cannot be detected at runtime | Validation is out of the initial scope, but detectable drift is returned as a Result (8.2). `kind: 'validation'` is reserved for future validation |
| Behavior changes with major version updates | State explicitly what is covered by stability promises, and change it only in semver majors (14) |

## 4. Overall structure

### 4.1 Repository layout

```
crates/
  tsurara-loader     Loading definitions, resolving $ref, normalizing Swagger 2.0
  tsurara-sem        Analyzing definitions into the model (pure transformation without I/O)
  tsurara-backend    The interface to code generators of each language, and plugins
  tsurara-lang-typescript  Generating TypeScript types, OperationDefs, and functions
  tsurara-config     Loading configuration files (extends, targets)
  tsurara-cli        The tsurara command (generate / check / init)
runtimes/
  typescript      @tsurara/client (runtime library used by generated TypeScript)
packages/
  tsurara            npm wrapper for distributing the CLI
spec/
  operation-def.schema.json  The OperationDef format shared by every runtime
  conformance/    Request and response vectors every runtime runs (18.9)
schema/
  tsurara.config.schema.json   JSON Schema of the configuration file (for editor completion)
examples/
  pnpm-monorepo   Example where apps/app-1 and app-2 share packages/openapi. Doubles as E2E tests
docs/
  design.md       This document
```

`packages/tsurara` ships per-platform binaries through `optionalDependencies`, the same way biome does.

### 4.2 Processing flow

```
Input (file / URL)
  → tsurara-loader: load, collect external $refs, convert Swagger 2.0 → 3.0
  → Plugins (document stage)
  → tsurara-sem, then a backend (tsurara-lang-typescript)
      ① Analysis: resolve $ref, discriminators, readOnly/writeOnly
      ② Build the normalized IR
      → Plugins (IR stage)
      ③ Output: code per file
  → Plugins (files stage)
  → tsurara-cli: write, delete stale generated files, afterWrite hooks
```

tsurara-sem and the backends do no I/O. Its input is a loaded `DocumentSet`, and its output is a list of path and content pairs. When embedded as a Rust library, it performs exactly the same transformation as the CLI.

## 5. Loading (tsurara-loader)

### 5.1 Input sources

Input is a local path, `http(s)://`, or `file://`. HTTP accepts authentication headers and a timeout. The headers are only sent to the origin of the root definition. The loader follows redirects itself (at most 10), drops the headers when a redirect leaves that origin, and refuses redirects to anything but `http(s)`.

Network access sits behind the `Fetcher` trait. The default implementation handles reading files and HTTP (ureq). When embedded as a Rust library, it can be replaced with a custom HTTP stack or cache. For users who do not need HTTP, HTTP support can be removed through a Cargo feature.

### 5.2 Format detection

If the body starts with `{` or `[`, it is read as JSON, and as YAML if that fails. Numeric YAML keys such as `200:` are converted to strings. YAML merge keys (`<<`) are expanded too. Aliases are expanded into copies, so the number of nodes they add is limited (one million, or 100 per YAML event if that is more); a document with nested aliases ("billion laughs") fails with a parse error that names the limit and the line of the alias.

### 5.3 $ref resolution

Starting from the root definition, `$ref`s are followed and every referenced external definition is loaded into the `DocumentSet`. A location in a definition is a pair of the document URL and a JSON Pointer (`Loc`). Relative references are resolved with the URL joining rules.

Following JSON Schema 2020-12 in 3.1, `$id`, `$anchor`, and `$dynamicAnchor` are indexed so they can be looked up as reference targets.

A definition fetched over HTTP cannot refer to local files: a `file://` document is loaded only when a local document refers to it, and a reference from a remote one (directly or through `$id`) fails at resolution with a message saying why. Otherwise a vendor's definition could put the contents of files on the generating machine into the output. Remote definitions can still refer to other HTTP addresses; there is no allowlist of hosts yet.

A failure to load an external definition is not an error at that point. It becomes an error when a reference to it is actually resolved. This keeps loading from stopping just because an example value contains a key named `$ref`.

### 5.4 Swagger 2.0 normalization

Swagger 2.0 definitions are converted to OpenAPI 3.0 before being passed to tsurara-sem, so tsurara-sem only has to handle 3.x. The conversion covers the following.

- Move `definitions` / `parameters` / `responses` under `components` and rewrite `$ref`s
- Convert `in: body` parameters to `requestBody`, and `in: formData` parameters to a multipart or urlencoded `requestBody`
- Decide media types from `produces` / `consumes`
- Build `servers` from `host` / `basePath` / `schemes`
- Convert `securityDefinitions` to `securitySchemes`
- Convert `x-nullable` to `nullable`, and `type: file` to `type: string, format: binary`

2.0 support is in the initial scope. Many existing definitions are still 2.0, and keeping the conversion inside the loader means it does not affect codegen.

## 6. Code generation (tsurara-sem and tsurara-lang-typescript)

### 6.1 Three stages

Writing OpenAPI schemas directly as TypeScript carries variations in how they are written straight into the output. Code generation is split into three stages: analysis, normalized IR, and output.

1. Analysis: resolve `$ref`, and find discriminator relationships and whether readOnly/writeOnly is present.
2. Normalized IR: build an intermediate representation close to TypeScript types, and bring schemas with the same meaning into the same shape.
3. Output: write types, OperationDefs, and functions from the IR, and assign them to files.

### 6.2 Supported specification

| Version | Main items |
|---|---|
| 3.0 | `nullable`, discriminator (both on the `oneOf` side and on the side inheriting through `allOf`), `readOnly`/`writeOnly` |
| 3.1 | `type` arrays, `const`, `prefixItems` (tuples), `$defs`, `$ref` with sibling keys, `contentMediaType`/`contentEncoding`, webhooks, `$dynamicRef` |
| 3.2 | The `query` method, `additionalOperations`, `in: querystring`, `itemSchema` (sequential media types), `discriminator.defaultMapping` |
| All | Parameters (path/query/header/cookie, merging with path-level parameters, given with `content`), multiple media types, response headers, `default` and `2XX`-style statuses, callbacks, servers, JSDoc (description, deprecated, default, example, format, and the various constraints) |
| Extension | `x-event-channels`: messages that are not responses of an operation, such as hub updates (8.8) |

In the initial version, `$dynamicRef` is resolved statically per reference site and emitted as a concrete type (such as `PetPage`). Emitting generic types like `Page<T>` is left for the future.

### 6.3 Normalization

The following happens while building the normalized IR.

- Flattening allOf: the members of unnamed objects are merged into one object literal. Named types (`$ref`) stay as an intersection, but an intersection contains at most one object literal. The output takes the shape `Base & { a: string; b: number }`. Only a property that appears with different types keeps an intersection on that property.
- Tidying unions: flatten nesting and remove duplicates. A union containing `unknown` becomes `unknown`, and `never` is removed.
- Unifying nullable: 3.0 `nullable: true`, 3.1 `type: [..., 'null']`, and `oneOf` containing `type: 'null'` all become `X | null`. `nullable: true` written as a sibling of `$ref` in 3.0 is ignored per the specification. Because this pattern is common in real-world definitions, a warning says it was ignored (6.8), and suggests rewriting it as `allOf: [{ $ref }]` with `nullable: true` to allow `null`.
- Order: properties keep their order in the definition, because that order matters for readability. On the other hand, the order of `required` and the order of allOf members do not affect the output.

### 6.4 Type mapping table

The conversion rules from schemas to types are fixed by the following table, and each row is a test.

| Schema | Output |
|---|---|
| `{}` / `true` | `unknown` |
| `false` | `never` |
| `type: object` with no properties and no `additionalProperties` | `{ [key: string]: unknown }` |
| `additionalProperties: false` with no properties | `{ [key: string]: never }` (only in this case) |
| Properties, no `additionalProperties` | No index signature |
| Properties, `additionalProperties` with a schema | The index value type is the union of that schema and the types of all properties |
| `patternProperties` | Index signature (the value is the union of the types per pattern) |
| `enum` | Union of literal types |
| `const` | Literal type |
| `prefixItems` | Tuple. Each element is optional (`[string?, number?]`), and elements up to `minItems` are required. If `items` has a schema, it is the type of the rest elements; without `items`, `...unknown[]` is appended; with `items: false`, no rest elements are allowed |
| A string with `format: binary`, or `contentMediaType` without `contentEncoding`, as the HTTP body itself or a multipart part value | `Blob \| File` |
| `type: string` inside a JSON value (even with `contentMediaType`, `contentEncoding`, or `format: binary`) | `string`. `contentMediaType` and the like go in JSDoc. `format: binary` cannot be represented inside JSON, so it is warned about when it appears inside a JSON value (not at the root of a declaration or a non-JSON body) |
| Cycles | Always go through a named type. Inline self-references are hoisted into named types |
| Keywords TypeScript cannot express (such as `not`) | Drop only that keyword and build the type from the remaining keywords, or `unknown` if none remain. Warn in either case |

The union is taken when there are both properties and `additionalProperties` because `{ a: string; [key: string]: number }` is a TypeScript error.

Elements of `prefixItems` are optional because in JSON Schema, `prefixItems` only decides "the types of the elements that are present, in order from the start", not how many elements there are. With only `prefixItems: [string, number]` and `items: false`, both `[]` and `["a"]` are valid values. So the output is `[string?, number?]`, and with `minItems: 2` it is `[string, number]`. If `maxItems` is less than the number of `prefixItems`, the elements are truncated to that number.

The following two can also be expressed exactly in TypeScript. When `minItems` exceeds the number of `prefixItems`, the rest element type can be added as required elements (`[string, number, boolean, ...boolean[]]`). When `items` has a schema and `maxItems` sets an upper bound, optional elements can be listed up to the bound (`[string?, boolean?, boolean?]`). However, large numbers make tuples long and increase output size and type-checking cost. So the initial version approximates both with the rest element type (`...T[]`) and keeps the constraint in JSDoc.

- When `minItems` exceeds the number of `prefixItems`
- When `items` has a schema and `maxItems` sets an upper bound

Combinations that no value can satisfy become `never`. These are `minItems` greater than `maxItems`, and `items: false` with `minItems` exceeding the number of `prefixItems`.

The IR tuple holds the number of required elements in addition to the list of element types (work in 028).

Whether a value is binary depends on where it appears. A value declared as `type: string` inside JSON arrives as a JSON string, so it is `string` even with `contentMediaType: text/html` or `format: binary`. Only the request or response body itself (`application/octet-stream` and so on) and multipart part values become `Blob | File`. Part values are the top-level properties of a multipart body schema and the items of arrays among them, following `$ref`s. A named object schema whose only uses (every `$ref` and discriminator mapping in every document) are multipart request bodies is declared with part values, and those bodies refer to it. Any other named schema is converted as a JSON value, so its type is true wherever it is used inside JSON. When a multipart body refers to such a schema and it has binary part values, the body type expands it inline with `Blob | File` for those parts instead of referring to it; the named type is not changed and no false type is emitted (decided in 029).

#### 6.4.1 What is exact, what is approximated, and what is rejected

TypeScript types cannot express every constraint. For each keyword, tsurara decides in advance which of the following four ways it is handled. A single inexpressible constraint never makes the whole type `unknown` and throws away the known parts.

| Handling | Examples | Output and notification |
|---|---|---|
| Expressed exactly | `type`, `enum`, `const`, `required`, nullable, `properties`, property composition in `allOf`, `prefixItems` (the rules in 6.4, except when `minItems` exceeds the number of `prefixItems` and the combination of an `items` schema with `maxItems`) | Expressed by the type alone |
| Approximated with a wider type | The two `prefixItems` length constraints that 6.4 approximates, exclusivity of `oneOf` (TypeScript unions also accept values matching several members), `patternProperties` patterns, the combination of properties and `additionalProperties` (6.4), string and number constraints (`minLength`, `pattern`, `minimum`, and so on), `uniqueItems` | The type also accepts some values the definition does not allow. This happens routinely, so there is no warning; the constraint goes in JSDoc, and this document's tables state that it is an approximation |
| Approximated by dropping the keyword | `not`, `if`/`then`/`else`, `dependentSchemas`, unresolvable references, statically resolved `$dynamicRef`, ignored `$ref` siblings | Warns (6.8). CI can treat warnings as errors |
| Rejected | Type mappings that disagree with runtime values (10.4) | Generation stops with an error |

The correctness of types is checked not only by the output passing `tsc`, but also by accepting values the definition allows and rejecting values it does not (chapter 13). Values that are accepted because of an approximation are marked as approximations in the tests.

### 6.5 discriminator and readOnly/writeOnly

discriminator: when `oneOf`/`anyOf` has a discriminator, each member gets the discriminating property as a literal type (`({ petType: 'cat' } & Cat) | ...`). The value comes from `mapping`, or the schema name if it is not in `mapping`. A member that already requires the property with only those values (a required `const`) is left as it is, since the intersection would change nothing. When a child schema references its parent with `allOf` and the parent has a discriminator, the child type gets the same literal. In the cycle where the parent lists children in `oneOf` and each child references the parent with `allOf`, the child side expands only the parent without its `oneOf`, avoiding a circular type reference error.

A discriminator does not change the validation result (the Discriminator Object in OpenAPI 3.1.1), and validating the parent schema does not go looking for child schemas. So tsurara only adds literal types to the discriminating property and does not replace the parent type with a union of its children. In a definition where the parent has a discriminator and children merely reference the parent with `allOf`, the response type stays the parent type and cannot be narrowed to a child type. To narrow it, list the children in `oneOf` on the parent in the definition.

readOnly/writeOnly: for a schema that has either (including through reference targets), `PetWritable` is generated in addition to the original type. The original type is used in responses and drops writeOnly properties. The `Writable` type is used in requests and drops readOnly properties. Schemas with neither get no `Writable` type. The split can be disabled in the configuration, in which case readOnly/writeOnly are ignored and only one type is emitted.

Whether a schema has readOnly/writeOnly is decided over the whole reference graph. For mutual references, such as A referencing B and B referencing A, the computation iterates per strongly connected component until the results stop changing. A provisional result from the middle of a check must not be treated as final. Settling on a provisional result leaves readOnly properties from the other side of a mutual reference in request types (work in 030).

Adding a single readOnly property to a schema changes the request-side type name for references to it from `X` to `XWritable`. This follows the naming rules, but is a breaking change for user code (chapter 14).

### 6.6 Naming

- Property names: not transformed. Names that cannot be identifiers are quoted (`'@type'`).
- Type and function names: all go through a single sanitizer. Collisions with reserved words and with the TypeScript globals used by generated code (`Date`, `Error`, `Blob`, `File`, `Record`, and so on) are avoided with fixed rules. Names that differ only in case also count as collisions, to prevent file names from clashing on case-insensitive macOS file systems.
- Schema names: kept unchanged if they are valid identifiers. Conversions such as camel-casing are opt-in.
- Function names: built from `operationId`, or from the method and path if there is no `operationId`.
- Resolving collisions: names are assigned in the order of the definition, so the same definition always yields the same names. Automatically chosen names can be pinned with `naming.overrides` in the configuration.

Backends that turn inline schemas into named types (not TypeScript) derive their names from the owner and the path, as described in 18.4.2; adding an inline schema never renames a declaration, because candidates are named last.

Names that collide with reserved words or globals get the suffix `Model` (`Error` → `ErrorModel`, `Date` → `DateModel`). If the suffixed name still collides with another name, `2`, `3`, and so on are appended. Avoided collisions are reported as warnings (6.8), and the names can be pinned to something else with `naming.overrides`.

When a type name derived from an operation (`{P}Data`, `{P}Responses`, `{P}Errors`, `{P}Result`, `{P}ResponseHeaders`, `{}Def`, and the webhook and callback types) is already taken, usually by a schema, the schema keeps its name and only that derived name moves aside: `Operation` goes before its suffix (`ListPetsOperationResult`), then a number if that is taken too. The function name and the other derived names stay, so adding a schema named `ListPetsResult` never changes the function `listPets` to `listPets2`. A `renamed` warning names both sides, and `naming.overrides` can choose another name. This follows kubb's collision detection (semantic suffixes across kinds, numbers within one kind). The first policy stopped generation with an error; the OpenAI definition has ten such collisions (`UsageCompletionsResult` is both a schema and the result of `usageCompletions`), so it changed in 064.

For names, determinism and stability are considered separately.

- Determinism: the same definition and configuration always yield the same names. tsurara always guarantees this.
- Stability: existing names do not change when items are added to the definition. The `Model` suffix for reserved words and globals depends only on the name itself, so it is stable. Numbers appended to names that differ only in case or to duplicate names, on the other hand, depend on the order of the definition. Adding items can change existing names, and in that case a warning says so. Names that should stay fixed are specified with `naming.overrides`. A lock file that records assigned names remains an option (chapter 16).

### 6.7 Type-checking performance

Type computation is done in the generator, not left to the TypeScript type system.

- Do not build structures that index into huge types, such as `paths['/x']['get']['responses'][200]['content']['application/json']`.
- Emit the Result type as an expanded union instead of building it with generics. It reads well on hover and costs nothing to instantiate.
- Give every function an explicit return type. This satisfies `isolatedDeclarations` and also speeds up type checking with project references.
- Do not generate conditional types or recursive mapped types.

### 6.8 Warnings

`tsurara generate` reports approximately converted places (`unknown` substituted, an unresolvable `$dynamicRef` resolved statically, ignored `$ref` siblings, and so on) with JSON Pointers. This tells users where in the definition to look to find out why a type became `unknown`. Which approximations produce warnings follows the table in 6.4.1.

| Code | Meaning |
|---|---|
| `unsupported` | A keyword the model cannot represent was dropped, or a value cannot be what the definition says |
| `dynamic-ref` | `$dynamicRef` was resolved statically per reference site |
| `renamed` | A name was changed to avoid a collision |
| `unresolved-ref` | A reference could not be resolved and became `unknown` |
| `invalid-definition` | The definition has an unexpected shape and was interpreted as far as possible |
| `ignored-sibling` | A keyword next to `$ref` was ignored (OpenAPI 3.0) |
| `wildcard-media-type` | A wildcard media type with a schema that is not binary |
| `unmapped-type` | A mapped type has no entry for the language |
| `sample-cycle` | Sample values (18.7.1): a required property refers back to its own declaration |
| `sample-pattern` | Sample values: a `pattern` without an `example` |

`tsurara inspect warning <code>` prints what each code means and how to resolve it; the explanations live in `WarningKind::explanation`, and a test checks that every code is in this table.

## 7. Output

### 7.1 File layout

```
src/generated/
  schemas/Pet.ts               One file per schema (types only)
  operations/getPetById.ts     One file per operation (types, OperationDef, function)
  webhooks/newPet.ts           One file per webhook
  client.ts                    ClientOptions (the baseUrl type built from servers)
  index.ts                     Barrel (one line per file)
  zod/Pet.ts                   With `typescript.validators: zod` (8.7); not in the barrel
  query/getPetById.ts          With `typescript.query: tanstack` (9.4); not in the barrel
  channels/board.ts            One file per event channel of `x-event-channels` (8.8); not in the barrel
  mocks/                       With `typescript.mocks: msw | fetch` (8.9); not in the barrel
  _runtime/                    With `runtime: vendor` (7.5): a copy of `@tsurara/client`
```

Callbacks are emitted in the same file as the operation that has them.

Optionally, the `tags` layout puts operations in one file per tag, and the `single` layout puts everything in one file. The default is the `split` layout above. Aggregate maps for generic clients (`paths.ts`, `operations.ts`) can also be emitted, but are not by default.

### 7.2 Making conflicts unlikely

- Schemas and operations each get their own file, so changes to different APIs do not land in the same file.
- Files listing several items, such as the barrel, have one item per line in a fixed order.
- No timestamps or generator versions in the output.
- The same definition and configuration always yield byte-identical output.

On regeneration, only old files that carry the generated-file header and were not produced this time are deleted.

### 7.3 Supporting erasableSyntaxOnly

- Do not emit `enum`, `namespace`, or constructor parameter properties.
- Enums are unions of string literals by default. Optionally, the pair `export const PetStatus = { ... } as const` and `export type PetStatus = (typeof PetStatus)[keyof typeof PetStatus]` can be emitted.
- Type imports use `import type`, so they also pass with `verbatimModuleSyntax`.
- The barrel re-exports type-only files with `export type *` and files with values with `export *`.
- The import extension can be `.js`, `.ts`, or none. The default is `.js`. Choose `.ts` to run directly with Node type stripping, because Node does not map `.js` specifiers to `.ts` files.

Satisfying `erasableSyntaxOnly` is only a necessary condition for running directly in Node. Running directly also requires `.ts` import extensions and Node 22.18 or later (Node's TypeScript documentation). Recommended settings for shared packages are in 9.2.

### 7.4 Example operation file

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

- The first parameter of a function is the client, and it is always passed explicitly. There is no implicit global client, because global state inside a shared package mixes settings between apps and requests.
- For operations without required parameters, `options` can be omitted.
- For operations whose request body has several media types, `body` and `contentType` in the `Data` type are tied together with a discriminated union. The first media type in the definition is the default, and only that member can omit `contentType`. If the body is optional, each member can omit `body`. When `body` is omitted, no body is sent even if `contentType` is given.

  ```ts
  export type UploadPetData =
    | { contentType?: 'application/json'; body: PetWritable }
    | { contentType: 'multipart/form-data'; body: UploadPetForm };
  ```
- The function body is just a call to `client.request(def, options)`. Path expansion, query serialization, request body construction, and response parsing are done by `@tsurara/client`, reading the OperationDef.
- The `OperationDef` holds a value, but it is a plain object literal, so it does not violate erasableSyntaxOnly.
- The OperationDef does not get `satisfies OperationDef`, because it prevents `isolatedDeclarations` from inferring the type (TS9010). The shape is checked by the parameter type of `client.request`.

### 7.5 Vendored runtime

`runtime: vendor` (default `package`) writes a copy of the runtime's sources into the output, and generated code imports the copy instead of the package. It is for projects that cannot add a runtime package (restricted dependency policies, offline builds, game engines that ship dependencies as assets). The copy is the source that passes `spec/conformance`: serialization stays in the runtime.

| Language | The copy | How generated code reaches it |
|---|---|---|
| TypeScript | `_runtime/` (with the target's import extension) | Relative specifiers instead of `@tsurara/client` |
| Python | The subpackage `_runtime` | Relative imports (`from .._runtime import Client`) |
| Rust | The module `runtime` (`pub mod runtime;` in `mod.rs`) | `rust.runtimeCrate`, required: the module's path in the user's crate (`crate::api::runtime`) |
| Go | The package `internal/tsurara` of the output | `go.runtimeModule`, computed from the nearest `go.mod` when not set |

- The sources are embedded in the binary at build time (`tsurara-runtimes`, a build script over `runtimes/`, tests left out), so the copy always matches the generator.
- Every copied file starts with the generated-file marker and a line naming the MIT license. Stale-file deletion and `tsurara check` cover the copy like generated code: an edit fails `check`, `generate` restores it, and leaving vendoring deletes it. The runtime version marker is not written, and the version check of `check` does not apply (the copy is the version).
- The copy is adapted only where the language requires it: TypeScript's relative imports take the import extension; Rust's `crate::`, `$crate::` and `tsurara_client::` paths become `runtimeCrate`, `#[macro_export]` macros are re-exported by path, the cargo features are resolved (the client layer only with operations, the mock transport only with `rust.mocks`, under `cfg(any(test, feature = "mocks"))`), and `clippy::collapsible_if` is allowed because the runtime keeps Rust 1.85; Go's imports of the runtime and `tsuraratest` take the vendored path.
- Third-party dependencies are not copied: `generate` names them (httpx for Python; serde, serde_json and indexmap, and with operations tokio, fastrand, httpdate and reqwest for Rust, also listed in `mod.rs`). TypeScript and Go have none.
- With `operations: false`, Rust copies the types layer only (18.9); TypeScript copies nothing when no file imports the runtime.
- Each target gets its own copy. A shared location for several targets is not offered: targets of one repository that share a runtime are better served by the package.

## 8. Runtime library (@tsurara/client)

### 8.1 Creating a client

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

| Option | Description |
|---|---|
| `baseUrl` | Where to connect |
| `headers` | Headers added to every request. Async functions are allowed |
| `middleware` | Functions that intercept requests and responses (8.4) |
| `onResult` | Observation hook that receives the final Result (8.4) |
| `onUndocumentedStatus` | Observation hook called for responses whose status the definition does not document (8.2) |
| `auth` | Returns the credential for a security scheme of the operation (below) |
| `fetch` | The fetch implementation. For replacing it in tests or using it on the server |
| `timeout` | Default timeout (milliseconds) |
| `validate` | Validates JSON response bodies; `validateResponses(schemas)` builds one from Standard Schema schemas (8.7) |

Optional options, here and in `RequestOptions`, accept `undefined` as "not set", so with `exactOptionalPropertyTypes` they can still be set conditionally (`onUndocumentedStatus: dev ? log : undefined`).

Authentication follows the definition. Each OperationDef carries the operation's security requirements (its own `security`, or the root's), with what is needed to place each credential. `auth(scheme, info)` returns the credential for a scheme, or `undefined`; the client uses the first alternative for which every scheme has one, and places the credentials by scheme: API keys in their header, query parameter or cookie, `http` `bearer`, OAuth 2 and OpenID Connect tokens as `Authorization: Bearer`, `basic` as `Authorization: Basic` (the hook returns `user:password`, which the client encodes). Operations with `security: []` send nothing, and an alternative that is not complete is skipped. `mutualTLS` belongs to the transport (`fetch`). Generated code exports `SecuritySchemeName`, the union of the scheme names. Obtaining tokens (OAuth flows) stays outside the client; the hook can call whatever does it.

The type parameter `Ctx` is the type of the context passed per call, used for things like passing a per-request trace ID in SSR. Module augmentation is not used, so apps can have different types without interfering with each other.

`signal`, `headers`, `timeout`, `baseUrl`, and `context` can be overridden per call through `RequestOptions`.

### 8.2 Result

The Promise returned by `client.request` never rejects. HTTP errors, network failures, and aborts are all returned as Result values.

| `kind` | `ok` | When | Main fields |
|---|---|---|---|
| `success` | true | A success status from the definition was returned | `status`, `data`, `response` |
| `http` | false | An error status, or a status not in the definition, was returned. Statuses not in the definition get `documented: false` and `error: unknown`. When other success statuses are defined, an undefined 2xx (such as 201 for an operation that only defines 200) also lands here | `status`, `error`, `documented`, `response` |
| `network` | false | fetch itself failed (DNS, dropped connection, CORS, and so on) | `cause` |
| `timeout` | false | The time given by `timeout` was exceeded | `cause` |
| `aborted` | false | Aborted by the caller's `signal` | `cause` |
| `parse` | false | Parsing the body failed, including when the Content-Type is not what was expected | `cause`, `response`, `contentType` |
| `unexpected` | false | User code such as middleware threw an exception | `cause` |
| `validation` | false | `validate` found issues in a success or documented error body (8.7) | `status`, `value`, `issues`, `response` |

Internally, `timeout` and `aborted` are both aborts through AbortSignal. They are still separate because logging and retries treat them differently. `unexpected` is separate from `network` for the same reason: to not mix bugs in user code with network failures.

`validation` is reserved from the start so that adding validation later does not break user code that branches on `kind`.

A status that is not in the definition is a failure even when the server meant success, so drift between the server and the definition (a server answering 201 where the definition says 200) only shows up as an unexpected failure. `onUndocumentedStatus({ operation, context, status, response })` is called for every such response, before `onResult`; logging it during development makes the drift visible at the place it happens. Like `onResult`, its exceptions do not change the Result.

The `default` response has the type `status: number`. TypeScript cannot express "a number other than 404", so narrowing with `status === 404` leaves the `default` member in the union. In practice this is fine if the statuses stated in the definition are checked first.

### 8.3 unwrap and ApiError

For places where exceptions are easier to write, there is `unwrap(result)`. It returns `data` on success and throws an `ApiError` on failure. `ApiError` extends `Error` and has `kind`, `status`, `operationId`, the original `result`, and `cause`. The stack trace is kept too.

`ApiError` takes the operation's Result type as a type parameter. `ApiError<GetPetResult>` narrows `result` to that operation's failures, so `result.kind === 'http' && result.documented` gives the documented error body its schema type. The thrown value cannot carry a static type, so this is for places that know the operation, such as `useQuery<Pet, ApiError<GetPetResult>>` in TanStack Query. The default `ApiError` has the generic failure with `error: unknown`.

`new ApiError(result)` names the operation that returned `result`, like `unwrap` does.

`isHttpError(result, 422)` narrows a Result to the documented error of a status: its own member when the status is documented on its own, otherwise the `default` (or range) member with `status` set to it. Checking `status` alone cannot narrow it, because the member for undocumented statuses has `status: number`.

A value that is not a Result throws a `TypeError` instead. The common case is a forgotten `await` (`unwrap(getPet(api, …))`): type checking rejects it, but code run with type stripping alone does not, so the error says to await the call.

### 8.4 Middleware and onResult

Middleware is a function of the shape `(req, next) => Promise<Response>`. Middleware is called from the outermost first and passes control inward with `next`. Through `req.operation`, it can see the operation's `id`, `method`, path template (`/pet/{petId}`), and `tags`. Use these for trace span names and log keys.

Middleware may throw. `@tsurara/client` catches it on the outside and turns it into a Result.

`onResult` receives the Result after all processing is done. Logging and metrics often want the final outcome, including failures before HTTP (such as timeouts). Middleware alone has trouble catching these, so this is a separate hook.

Both runtimes bundle retries with the same defaults: `retry()` middleware in `@tsurara/client`, the `retry=Retry()` client option in `tsurara-client`. They retry network failures and the statuses 408, 429, 500, 502, 503, and 504, only for idempotent methods (GET, HEAD, OPTIONS, PUT, DELETE), up to 2 times. The wait is `Retry-After` when the response has it (seconds or an HTTP date), and otherwise exponential backoff with full jitter (a random wait up to 100 ms doubled per retry); both are capped at 30 seconds (`maxDelay` / `max_delay`). The client's `timeout` covers all attempts together: a wait that would end after it is not started and the last response is returned, and nothing is retried after a timeout or an abort. The request is rebuilt on every attempt, and stream bodies, which cannot be sent again, are not retried.

`bindClient(client, { getPet, listPets })` returns the functions with the client bound as the first argument (`api.getPet(options)`). The `context` type of the bound functions comes from the client.

### 8.5 Serialization and response parsing

All request and response conversion is done by `@tsurara/client` based on the OperationDef. Generated code contains no conversion logic. With the conversion logic in one place in the library, it can be tested as a whole.

- Path and query: follow OpenAPI `style` (form, spaceDelimited, pipeDelimited, deepObject, and so on) and `explode`. A path parameter that is missing, or whose value would make a whole path segment empty, `.` or `..`, fails before sending (`kind: 'unexpected'`): URL parsing removes dot segments, so `id: '..'` in `/users/{id}/profile` would otherwise call `/profile`. Values are percent-encoded, `%` included, so a value such as `%2e` is sent as `%252e`. The path template must start with `/`: it is appended to the base URL as text, so `@evil.example/x` or `:8443/x` after `https://api.example.com` would change the host or the port. The model leaves out path keys without a leading `/` with an `invalid-definition` warning (webhook names and callback expressions are not paths), and every runtime refuses such an OperationDef before sending (`unexpected`).
- Request body: JSON, `multipart/form-data`, `application/x-www-form-urlencoded`, and binary are supported. Multipart follows `encoding`: arrays are `append`ed per element, and objects are serialized with the given Content-Type.
- Response: the generator decides `parseAs` from the media type and writes it into the OperationDef.

The following table is checked from the top, and the first matching row decides.

| Order | Media type and schema | parseAs | Type of data |
|---|---|---|---|
| 1 | No body (204 and so on) | `none` | `undefined` |
| 2 | `text/event-stream` with an item schema (`itemSchema` from 3.2, or `x-itemSchema`) | `events` | `AsyncIterable<{P}Event>` |
| 2a | JSON Lines (`application/jsonl`, `application/x-ndjson`) and JSON text sequences (`application/json-seq`) with an item schema | `jsonLines`, `jsonSeq` | `AsyncIterable<{P}Item>` |
| 2b | Other sequential formats (the above without an item schema) | `stream` | `ReadableStream<Uint8Array>` |
| 3 | `application/json`, `*/*+json` | `json` | The schema type in the JSON context (6.4). Even with `format: binary` or `contentMediaType` on `type: string`, it stays `string` and is not changed to `blob` |
| 4 | String formats such as `text/*` | `text` | `string` |
| 5 | Wildcards such as `*/*` and `application/*`, with a binary schema (6.4: `format: binary`, or `contentMediaType` without `contentEncoding`) | `blob` | `Blob` |
| 6 | Wildcards with a non-binary schema | `auto` | Schema type \| `string` \| `Blob` |
| 7 | Anything else (`application/octet-stream`, images, and so on) | `blob` | `Blob` |

With `auto`, the parse method is decided by the actual Content-Type of the response: JSON media types are parsed as JSON, `text/*` is read as a string, and anything else as a `Blob`. Which one comes back is not known until runtime, so the type of data is the union of all possible values. This avoids giving a false type to values the definition allows. Wildcards are warned about, and for APIs that actually only return JSON, wildcards can be treated as JSON through configuration (work in 031, configuration in 016). If an operation treated as JSON returns a non-JSON Content-Type, the result is `kind: 'parse'`.

Server-Sent Events: an item schema describes one event as an object with the properties `event`, `data`, `id` and `retry`. Each entry of its `oneOf` or `anyOf` is one event, completed with the properties written next to the keyword; without them the schema is the only event. `{P}Event` is the union of the events, `{ event: 'note'; data: Note; id?: string; retry?: number } | ...`, so `switch (e.event)` narrows `data`. `event` is the union of the event's names (`const` or `enum` of `event`), or `string` for an event without one, which stands for any other name; in languages with tagged unions the events are a union tagged by `event`, named after the operation (`StreamNoteEvent`), and an event without a name is its default member. `data` whose schema has a JSON `contentMediaType` has the type of its `contentSchema` (`unknown` without one) and is parsed by the runtime; any other `data` is a `string`. The OperationDef says which events to parse: the names (`const` or `enum` of `event`) of those that are JSON, so that events the definition does not list keep their text; `jsonEvents: true` only when every event is JSON and one of them has no name, which stands for any other name. An event with JSON data but no name among events with text cannot be told apart at runtime, so its data stays a `string`, with a warning. `data` is always required, because an event without data is not dispatched (as in `EventSource`); `id` and `retry` are optional unless `required` lists them. The runtime parses the stream as the HTML standard describes and hands over an async iterable that can be read once; leaving the loop cancels the stream. Invalid JSON in an event throws from the iteration, since the Result was already returned. Events the definition does not list arrive as they are, with `data` as a string. The semantic model keeps the body kind `stream` and carries the events next to it (`MediaContent::events`); tsurara-lower marks such responses (`OperationTypes::sequences`) with the type of one item. Every runtime reads events and JSON items: `@tsurara/client` and Python hand over (async) iterators, Rust `Items<T>` with `next().await`, Go `*Items[T]` with `All()`; their timeouts cover sending and the headers but not the items, and Python, Rust and Go read every response through a streaming transport so that the items arrive as the server writes them. `parseEventStream` of `@tsurara/client` reads a byte stream without a schema the same way.

JSON Lines and JSON text sequences: the item schema is the schema of one item in the JSON context, and `{P}Item` is its type. The runtime reads one JSON text per line (`jsonLines`; blank lines are skipped, and CR, LF and CRLF end lines) or per record starting with U+001E (`jsonSeq`; text before the first separator and empty records are skipped), and throws from the iteration on invalid JSON. The model keeps the body kind `stream` and carries the item type next to it (`MediaContent::items`).

Request bodies are also built according to the media type and schema.

- For JSON media types, the value of the schema type in the JSON context is sent as JSON. Even with `format: binary` or `contentMediaType`, it is not switched to sending the value as is.
- For binary bodies (`application/octet-stream` and so on) and for wildcards with a binary schema, the value is sent as is. For wildcards, the `Blob`'s `type` becomes the Content-Type, and without a `type` no Content-Type is set.
- For wildcards with a non-binary schema, the value is sent as JSON with the Content-Type `application/json`. The generator warns.
- `Blob`, `ArrayBuffer`, `Uint8Array`, `ReadableStream`, and `FormData` are never passed to `JSON.stringify`. When one of them is passed as a JSON body, a Result with `kind: 'unexpected'` is returned instead of silently turning the data into `{}`.

### 8.7 Response validation

Validation is optional, and nothing changes without it. `@tsurara/client` validates through the [Standard Schema](https://standardschema.dev) interface (`~standard.validate`), which Zod (3.24 and later, 4), Valibot and ArkType implement, so it depends on none of them. The `validate` option is a function of the parsed body and the operation, status and media type, returning issues or nothing; `validateResponses(schemas)` builds one from schemas per operation id, status (also `2XX` and `default`) and media type. A call can pass another validator or `validate: false`. Success bodies and documented error bodies read as JSON are validated (not text, binary or streams); a body with issues becomes `{ ok: false, kind: 'validation', status, value, issues, response }`, and `unwrap` throws an `ApiError` of that kind. Asynchronous validators are awaited.

`typescript.validators: zod` emits Zod 4 schemas: `zod/Pet.ts` exports `PetSchema: z.ZodType` (annotated for `isolatedDeclarations`, references through `z.lazy`, so cycles and module order do not matter), and `zod/operations.ts` exports `responseSchemas` for `validateResponses`. Types and call functions never import the Zod files, so apps that do not validate do not load `zod`.

The schemas check types, `enum`, `const` and the formats `uuid`, `email` and `date-time`. `typescript.validatorConstraints: true` adds the definition's constraints, read from the model's documentation tags through `Doc::constraints()`: `minLength`, `maxLength` and `pattern` on strings, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum` (3.0's booleans folded into the bounds) and `multipleOf` on numbers, `minItems`, `maxItems` and `uniqueItems` (a refinement by JSON text) on arrays, `minProperties` and `maxProperties` on objects, and the formats `uri`, `ipv4`, `ipv6`, `date`, `time` and `duration`. On a nullable value they apply to the other members. They are off by default because servers often send values that break them harmlessly (a long description, a date-time without an offset), and turning them on makes such responses `kind: 'validation'`; the option is for apps that reuse the schemas for input, such as forms. `pattern` is an ECMA-262 regular expression by the specification, but definitions written for other engines exist: each pattern is compiled at generation time with ECMAScript rules and the `u` flag (the `regress` crate), and one that does not compile is an `unsupported` warning and is left out, instead of a module that throws when it loads. Constraints on a `$ref` and on array items inside other arrays apply where the model keeps the schema's documentation (declarations and properties); nested item schemas keep their types only. Requests are not validated before sending yet.

```ts
import { createClient, validateResponses } from '@tsurara/client';
import { responseSchemas } from './generated/zod/operations.ts';

const api = createClient({ baseUrl, validate: validateResponses(responseSchemas) });
```

The schemas check what the TypeScript types say, and never more than the definition:

| Schema | Zod |
|---|---|
| `string`, `integer`, `number`, `boolean`, `null` | `z.string()`, `z.number().int()`, `z.number()`, `z.boolean()`, `z.null()` |
| `format: uuid`, `email`, `date-time` | `z.uuid()`, `z.email()`, `z.iso.datetime({ offset: true })`; other formats are plain strings |
| `enum`, `const` | `z.enum([...])` (strings) or a union of `z.literal`; closed, as the TypeScript types (18.5.3) |
| Object | `z.object({...})` with `.optional()` for optional properties; unlisted properties are allowed, `additionalProperties` becomes `.catchall(...)`, `false` with no properties `.strict()` |
| Array, tuple | `z.array(...)`; a fixed-length tuple `z.tuple([...])`, other tuples `z.array(z.unknown())` |
| `oneOf`, `anyOf`, discriminator | `z.union([...])` (`oneOf` exclusivity is not checked) |
| `allOf` | `z.intersection(...)` |
| `$ref` | `z.lazy(() => PetSchema)` |
| readOnly / writeOnly | The response type (writeOnly properties left out) |
| External types (`x-tsurara-type`, type mappings), binary | `z.unknown()` (with a warning for external types) |
| String and number constraints (`minLength`, `pattern`, `minimum`, ...) | Not checked yet: the types approximate them too |

Zod schemas are expensive to type-check: with them, `tsc` on the GitHub, Stripe, Kubernetes and OpenAI output takes 0.9 to 1.4 s instead of 0.1 to 0.2 s, with 1.3 to 2.7 million type instantiations instead of 13 to 36 thousand (TypeScript 7.0.2, 2026-11-11). The corpus tests check the Zod output with `tsc`. The Python runtime decodes values with TypeDefs, which already rejects bodies whose types do not match; it has no separate validation option.

### 8.8 Event channels

Some messages are not responses: a server publishes updates to a hub (Mercure) after a commit, and the browser receives them through `EventSource` from the hub, another server. `x-event-channels` describes them at the root of the document:

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

The wire format: one message is one JSON document (`MessageEvent.data`); the kind of event is a property inside it (`type`, values such as `card.added`), not the SSE `event` field, so every message reaches `onmessage` and the same format works over a WebSocket; ordering data such as `seq` is a payload property; the SSE `id` stays the hub's (`Last-Event-ID`).

The model holds them as `Model::channels` (name, doc, template, parameters, payload contents), after the webhooks, with a `channel` name request. A template variable without a parameter becomes a string, and a parameter not in the template is dropped, both with `invalid-definition` warnings. The TypeScript backend writes `channels/{name}.ts` per channel: `{Channel}Message` (the payload type: a JSON media type, else `string` for text, else `unknown` with an `unsupported` warning when the content has neither), `{Channel}TopicParams` and `{channel}Topic(params)` (each value percent-encoded), `{channel}ChannelDef`, and `decode{Channel}(data, options?)`, which calls `decodeMessage` of `@tsurara/client` and returns a `MessageResult`: `{ ok: true, value }`, `{ ok: false, kind: 'parse', data, cause }` or `{ ok: false, kind: 'validation', value, issues }`. With `typescript.validators: zod`, `zod/channels.ts` exports `channelSchemas` for `validateChannels`, which validates synchronously (asynchronous schemas throw). The decoder takes a string, so it works with `EventSource`, `parseEventStream` over `fetch` and WebSockets; the client does not own the connection. The Zod schemas stay annotated as `z.ZodType`: the decoder trusts the validated value as the message type, since Zod's inferred optional properties do not satisfy `exactOptionalPropertyTypes`. Other languages ignore channels for now; reading `webhooks` as channels is not done.

### 8.9 Mocks

`typescript.mocks: msw | fetch` writes `mocks/`, which nothing else imports: `mocks/schemas/{Name}.ts` with `mock{Name}()` (the sample value of 18.7.1; objects with properties take `overrides?: Partial<T>`; a named type whose value is its own sample is built by its factory, which keeps cycles finite because samples cut them), `mocks/operations/{function}.ts` with `{Op}MockResponse` (a union of the documented statuses with their body types: literal codes, `number` for ranges and `default`) and `{function}Handler(response?, options?)`, `mocks/support.ts` with the conversion of a response to its media type, and `mocks/index.ts` with every operation answered by its first documented success. With `msw`, handlers are `HttpHandler`s of MSW 2 and 3 (`*/pets/:petId`, a RegExp when a parameter is inside a segment, `http.all` with a method check for methods MSW has no helper for); with `fetch`, they are routes for `mockFetch` (18.9).

Factories are type-checked field by field, except where a type contains a construct whose TypeScript type a sample may not follow: discriminated unions (real definitions have mappings that contradict the members' constants, which gives `never`), inherited tags, `allOf` intersections and external types. Those values are written as JSON and asserted (`as unknown as T`). Request validation in handlers and streamed answers item by item are not generated.

### 8.6 Distribution and compatibility

`@tsurara/client` is ESM only and ships built JS and `.d.ts`. It depends only on the standard `fetch`, `Request`, `Response`, and `AbortSignal`. Node does not apply type stripping to `.ts` under node_modules, so this package is built before shipping.

The OperationDef format carries a version number. Generated code records the compatible `@tsurara/client` version range, and `tsurara check` detects mismatches with the installed version. This makes it noticeable when the generator and the library are updated separately and drift apart.

## 9. Using it in a pnpm workspace

### 9.1 Layout

```
packages/openapi/                  Shared package
  package.json                     name: @acme/openapi, "sideEffects": false
  tsurara.config.yaml
  src/generated/...                tsurara output
  src/index.ts                     Re-exports generated and @tsurara/client
apps/app-1/src/api.ts              Client for app-1
apps/app-2/src/api.ts              Client for app-2
```

Generation happens once, in `packages/openapi`. app-1 and app-2 each create their own client and pass it to the generated functions. Differences in logging, tracing, and headers live in the client configuration, so the generated output knows nothing about individual apps.

| Kind of customization | Where | Examples |
|---|---|---|
| At generation time (shared by all apps) | `packages/openapi/tsurara.config.yaml`, plugins | Type mappings, patches to the definition, filtering by tag |
| At runtime (per app) | Each app's `createClient()` | baseUrl, auth headers, logging, tracing, retries, replacing fetch |

### 9.2 Handling the shared package

`packages/openapi` is not built; it is an internal package whose `package.json` `exports` point directly at `.ts` files. To share one generated output between apps that use a bundler (Vite and so on) and apps run directly by Node, the following settings are recommended.

- Set the import extension to `.ts` in the generation settings (7.3). Node does not map `.js` specifiers to `.ts`.
- In every tsconfig that compiles code importing the shared package, enable `allowImportingTsExtensions` (together with `noEmit`) or `rewriteRelativeImportExtensions`: each app, and also test packages and tools. The generated files import each other with `.ts` extensions, and TypeScript checks them as part of the importing project, so a project without the setting reports TS5097 ("An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled") inside the shared package's files, not in its own code. When that is not possible, generate with `.js` import extensions and build the shared package to `.js` and `.d.ts` instead, like any published package; apps run by Node then use the built files.
- Apps run directly by Node use Node 22.18 or later. pnpm symlinks resolve to their real paths, so Node's "no type stripping under node_modules" restriction should not apply.
- Besides the barrel, give the shared package's `exports` the subpaths `operations/*` and `schemas/*`.

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

This setup was checked with three apps sharing one package: React with Vite (dev server and production build, with the strict tsconfig and barrel imports), plain TypeScript with Vite (a lenient tsconfig, subpath imports, custom middleware and `retry()`), and a CLI run by Node 26 with type stripping (`nodenext`). Editing a generated file reloads the Vite page, Node runs the package through pnpm's symlinks, tree-shaking drops unused operations even through the barrel, and the workspace has one `@tsurara/client`. `examples/pnpm-monorepo` is this setup in the repository, checked in CI: a Vite app whose bundle keeps only the operations it uses, and a Node app with end-to-end tests against a local server. A Next.js app in the example (App Router, a server and a client component) builds with Turbopack and with webpack without `transpilePackages`: Next.js 16.4 compiles the `.ts` files of a linked workspace package. Its tsconfig needs `allowImportingTsExtensions` like any other consumer; without it, `next build` fails with TS5097 in the shared package. The minimum Node and TypeScript versions are checked in 034, and the two apps are checked as acceptance criteria of 024.

Each operation has its own file and `sideEffects: false` is set, so production bundles include only the functions used, even when importing from the barrel. However, that is about tree-shaking in production builds. Running directly in Node or in the Vite dev server loads every module the barrel references. `tsc` and editors also read every file when going through the barrel. For definitions with many operations, import directly from subpaths.

```ts
import { getPetById } from '@acme/openapi/operations/getPetById';
import type { Pet } from '@acme/openapi/schemas/Pet';
```

Load times through the barrel and with direct imports are measured in 025.

When one shared package generates several definitions (`targets`), expose each target through its own subpath (`@acme/openapi/public`, `@acme/openapi/admin`, and so on). Each target's output has the same names, such as `BaseUrl` and `servers`, so combining them into one barrel with `export *` causes name collisions.

Make `@tsurara/client` a dependency of `packages/openapi`. Apps use it through the re-exports of `@acme/openapi`, so the workspace ends up with a single version of `@tsurara/client`.

### 9.3 Example app code

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

Apps that want it can bundle functions with a client into an object with `bindClient(api, { getPetById, ... })` (optional).

### 9.4 TanStack Query

`typescript.query: tanstack` emits `query/{function}.ts` per operation, imported by nothing else (not the types, the functions or the barrel), so apps without TanStack Query never load it:

- Reads (`GET`, `HEAD`, `QUERY`): `{function}QueryKey(data, scope?)` returns `[operationId, data]`, or `[{ scope }, operationId, data]` with a scope, typed with `DataTag` so that `getQueryData`, `setQueryData` and `cancelQueries` know the data and error types; `{function}QueryOptions(client, data)` returns `{ queryKey, queryFn }`, whose `queryFn` calls the function with the query's `signal` and `unwrap`s it. `data` can be left out (it is then `{}`) when the operation has no required input. `skipToken` in place of `data` returns options whose `queryFn` is `skipToken` (an overload, `{P}SkippableQueryOptions`), so a query whose input is not known yet is typed without a condition at the call site; `useSuspenseQuery` rejects them, as TanStack requires. `{function}QueryFilter(scope?)` returns `{ queryKey }` for every query of the operation (`[operationId]` or `[{ scope }, operationId]`), typed with `DataTag`, for `invalidateQueries`, `cancelQueries`, `removeQueries` and `setQueriesData`. TanStack's `setQueriesData` and `getQueriesData` do not infer the data from a filter (5.108 neither), so `set{P}QueriesData(queryClient, updater, scope?)` and `get{P}QueriesData(queryClient, scope?)` call them with the data type and a filter that only matches the operation's queries, not its infinite queries, whose data is pages.
- Other methods: `{function}MutationOptions(client)` returns `{ mutationKey: [operationId], mutationFn }` (`[{ scope }, operationId]` with a scope), whose variables are the operation's `Data`.
- Errors are `ApiError<{P}Result>`, so `onError` and `error` see the documented error bodies and `isHttpError(error.result, status)` narrows them; data is `SuccessData<{P}Result>`. `queryRetry()` from `@tsurara/client` is the `retry` option for TanStack Query that retries what the `retry()` middleware retries (network failures and `RETRY_STATUSES`, shared by both) and nothing else; the generated options do not set it, since the `QueryClient` defaults are where an app chooses one retrying layer. `retry()` records how many times it sent a request it gave up on (a `WeakMap` keyed by the last response or the cause of the last network failure, so no Result type changes), and `queryRetry()` does not retry such a failure, so the two layers do not multiply when both are configured.
- Operations whose success is a stream get neither (`streamedQuery` may come later).
- Infinite queries: OpenAPI does not describe pagination and names such as `cursor` are not guessed from, so a read gets `{function}InfiniteQueryOptions(client, data)` and `{function}InfiniteQueryKey(data, scope?)` only when its pagination is written down: `x-tsurara-pagination` on the operation (read by the model into `Operation::pagination`, language-neutral) or `typescript.infiniteQueries.<operationId>`, which wins. Both take `param` (the parameter's `in` and name, `query.cursor`), `initial` (the first page; without it the first request leaves the parameter out, so a required parameter needs it), and `next` and `previous` (JSON Pointers into a success body; absent or `null` there ends the query). The `queryFn` sets the parameter from `pageParam`; `getNextPageParam` and `getPreviousPageParam` read the pointers, and without `next` the options type leaves `getNextPageParam` to the app (formats a pointer cannot describe: Link headers, offsets from totals). `{P}PageParam` is the parameter's type, so `data.pageParams` and the pointers' values are checked against it. A pagination that names no parameter of the operation, a pointer that is not a JSON Pointer, a non-read, or a configured operation id that does not exist is an `invalid-definition` warning, and the operation gets no infinite options.

The key shape is the contract apps rely on for optimistic updates and Mercure-driven cache patches: the operation id, then the request data (`path`, `query`, `headers`, `cookies`, and `body` for `QUERY`). Two equal requests have equal keys, keys of different operations never share their first element, and `['getPet']` matches every `getPet` query for `invalidateQueries`. The base URL and the credentials are not part of the key. A client created with `queryScope` (a JSON value naming who may share results: a tenant, an API, an environment; never a credential) puts `{ scope }` first in the keys of its options, so that clients with different scopes on one `QueryClient` keep separate entries; the key factories take the scope as an argument, since keys are also built where no client is at hand (a server-sent event patching the cache, server rendering). Unscoped keys start with the operation id, a string, and scoped keys with an object, so the two never match each other. `queryScopeFilter(scope)` from `@tsurara/client` matches every query and mutation of a scope, for logout and tenant switches. Keys hold only JSON values, so they hash the same after `dehydrate` on the server and `hydrate` in the browser. Infinite query keys append a marker after the data (`[..., operationId, data, { infinite: true }]`): never equal to the plain key, and still matched by the operation's filter. In the infinite options type every key is the wide `DataTag<QueryKey, InfiniteData<…>>`, not the precise union: Vue's `useInfiniteQuery` maps keys deeply and rejected a union of tuples of different lengths; `{function}InfiniteQueryKey` keeps the precise type. Which mutation affects which query is not in OpenAPI and is not inferred; the typed keys and filters are the parts an app combines in `onSuccess`.

The types come from `@tanstack/query-core` (`QueryObserverOptions`, `DataTag`, `QueryFunctionContext`, `MutationOptions`), which every adapter re-exports, so the objects work with `useQuery`, `useSuspenseQuery`, `useQueries`, `prefetchQuery`, `ensureQueryData`, `fetchQuery` and `useMutation` of React and the other adapters without generating per framework. Every key in the options type (the key type parameter of `QueryObserverOptions`, `queryKey`, the context of `queryFn`) is the same `DataTag` key: with the plain key in one place, `useQueries` (React) and `useQuery` (Vue) inferred two key types and rejected the options. Spreading the options keeps the adapters' inference: `select` decides `data`, `initialData` makes it defined, and the value `onMutate` returns is the typed context of `onError`. They are written as explicit types for `isolatedDeclarations`. The factories take no per-call request options: `RequestOptions` shares `headers` and `contentType` with the request data, so settings per call belong in the client's options or middleware. Checked with TypeScript 5.8 and 7 against `@tanstack/react-query` and `@tanstack/vue-query` 5.107.

## 10. Configuration file

### 10.1 Example

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

The format can be YAML, JSON, or TOML. `schema/tsurara.config.schema.json` is shipped for editor completion.

Settings that depend on the language (`layout`, `importExtension`, `enumStyle`, `aggregateMaps`, `clientModule`, `typeMappings`, `overrides`, `naming.schemaCase`, and `naming.overrides` of final identifiers) go in the section named after the target's `language` (18.10). The common `naming.overrides` are preferred names that each language's rules still apply to.

### 10.2 extends and merging

`extends` takes one or more files. Objects are deep-merged and arrays are replaced. Entries written at the top level become the defaults for every entry in `targets`. Without `targets`, the top level is the only target, named `default`. With several targets, each needs a unique `name`.

### 10.3 Paths and environment variables

Relative paths are resolved against the location of the configuration file they are written in. Paths written in a base configuration loaded through `extends` are also resolved against that base file. Hook commands run in the directory of the configuration file they are written in.

Environment variables can be expanded as `${VAR}`, so auth tokens do not have to be written in the configuration file.

### 10.4 Constraints on type mappings

`typeMappings` replaces the emitted type per format. However, the replacement type must match the runtime value read from JSON.

Mapping `date-time` to `Date` or `int64` to `bigint` makes the type a lie unless the value is converted at runtime. The initial version makes these two configuration errors, with defaults of `string` and `number` respectively. Runtime conversion can be added later by having the OperationDef carry the paths to convert.

Mappings that do not change the runtime value, such as branded types (`string & { __brand: 'Uuid' }` and so on), are allowed.

`import.from` in `typeMappings` and `x-tsurara-type` is handled as follows (work in 016).

- Relative paths starting with `.` are resolved against the configuration file they are written in, following 10.3. The generator rewrites the resolved path as a specifier relative to each generated file that uses the type.
- Non-relative specifiers such as package names are written as is.
- Extensions written by the user are kept. Mechanically rewriting them to match the import extension setting (7.3) could break specifiers of external modules. When running directly in Node, users write the `.ts` extension themselves.

### 10.5 Filter

`filter` narrows the operations to generate by tag or `operationId`: `tags` and `operationIds` include, `excludeTags` and `excludeOperationIds` leave out, and an exclusion wins over an inclusion. When filtered, schemas not referenced by any operation are not emitted. This keeps the output small when the shared package as a whole only uses part of the definition. If apps merely use different functions, do not split targets per app; leave it to tree-shaking of production bundles (9.2). Splitting targets duplicates the same types in separate files, and apps can no longer share types.

## 11. Extensions

There are three ways to extend tsurara.

1. Declarative settings: `typeMappings`, `naming.overrides`, and `overrides` (a type per JSON Pointer) in the configuration, and extension fields such as `x-tsurara-type` in the definition.
2. External command hooks, which can be written in any language.

   | Hook | Input and output |
   |---|---|
   | `transformDocument` | Receives the root definition as JSON on stdin and returns the transformed definition on stdout |
   | `transformModel` | Receives the model as JSON (18.4.6) on stdin and returns the transformed model on stdout. The result must keep `semVersion` |
   | `extend` | Receives `{ language, model, manifest, common, marker }` as JSON on stdin and returns files to add (`[{ path, contents }]`) on stdout (11.1) |
   | `transformFiles` | Receives the list of output files (paths and contents) as JSON and returns the transformed list |
   | `afterWrite` | Runs after writing. `{output}` is replaced with the output directory |

3. The Rust `Plugin` trait, for users who embed tsurara as a library. External command hooks are also implementations of this trait internally.

External types (`x-tsurara-type` in the definition, `typeMappings` and `overrides` in the configuration) are printed into the generated code, so each backend checks them first. The type must be a type expression of a restricted grammar for its language: for TypeScript identifiers, qualified names, type arguments, arrays and tuples, parentheses, `|`, `&`, string and template literal types without escapes (each `${...}` checked the same way) and numbers; for Python names, dotted names, subscripts, `|`, string literals and numbers. Semicolons, braces, `=`, comments and line breaks outside literals are rejected. The import name must be an identifier, and the module a specifier without quotes or backslashes (TypeScript) or a dotted module path (Python). An entry from a definition that fails the check is ignored with an `invalid-definition` warning and the schema's own type is used; one from the configuration is a configuration error. Definitions are honored by default: with the grammar they can only name types, and imports are type-only (`import type` in TypeScript, under `if TYPE_CHECKING:` in Python), so they run nothing.

A plugin declares the stage it hooks into (document, model, extend, files). Each stage has a fixed input, so results do not depend on plugin registration order. Multiple plugins on the same stage are applied in the order written in the configuration.

### 11.1 The manifest and the extend stage

Every backend returns a manifest with its files: what it generated, by name, so that plugins can write files that refer to generated code without re-deriving names that collisions, reserved words and `naming.overrides` change.

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

`file` is the output file that declares the identifier; a plugin turns it into an import as its language needs (a relative specifier with the configured extension in TypeScript, a module path in Python, `crate::…::types` or `…::operations` in Rust, nothing in Go, whose output is one package). The roles in `types` are per language:

| Language | Roles | `operationDef` |
|---|---|---|
| TypeScript | `data`, `responses`, `errors`, `result`, `responseHeaders`, `event`, `item`; webhooks `request`, `responses` | `{name}Def` |
| Python | `result` | `DEF` |
| Rust | `options`, `body` (with several body media types) | none (private) |
| Go | `options`, `body` | none (unexported) |

Declarations a backend adds on its own (hoisted inline schemas) are not listed in the first version, nor is every identifier a file exports: plugins put their files in their own directory (TypeScript, Python, Rust) or use a distinct prefix (Go, one package) to stay clear of generated names. The manifest is versioned by `manifestVersion` like the model.

The extend stage runs after the backend and before `transformFiles`. It receives the model (after model plugins), the manifest, the common options and the generated-file marker, and returns files to add. Each added file must start with the marker, so that stale-file deletion and `tsurara check` cover it; a file without it, or with the path of a generated file, is an error. External backends return a manifest from protocol 2 (18.11); with protocol 1 the manifest is `null`. The input also carries the language's options (`options`, `Backend::options_json`: for TypeScript the import extension, layout and client module), so that added files match the generated ones.

### 11.2 Plugin modules

`plugins:` lists modules that take part in several stages from one process per run, unlike hooks, which start a command per stage. tsurara starts each module once (`node` by default, through the runner of `@tsurara/plugin`; another `runtime` command for other SDKs), in the directory of the file that lists it, and speaks the session protocol of `tsurara_backend::session` over stdio: one JSON message per line, `hello` (with the protocol version; a different one stops the run naming both), then a `call` per stage the plugin declared, answered with `result` or `error`. Plugin modules run after the hooks of each stage, in the order listed. The messages are in `spec/plugin-protocol.schema.json` (`SessionRequest`, `SessionResponse`).

`@tsurara/plugin` (`packages/plugin`) is the TypeScript SDK: `definePlugin({ name, transformDocument, transformModel, extend, transformFiles })`, the types of the model, the manifest and the inputs (generated by tsurara itself from the protocol schema, `src/generated/protocol.ts`), `ts.file` (a writer that imports from the manifest with the target's extension and renders the marker), and `runPlugin` (`@tsurara/plugin/testing`) for plugin authors' tests. Plugin modules are TypeScript run by Node 22.18 or later with type stripping, so there is no build step. `tsurara init --plugin` writes a skeleton; `examples/plugin-swr` writes SWR hooks.

The other SDKs speak the same session: `tsurara-plugin` for Python (`packages/plugin-python`, run as `python -m tsurara_plugin <module>`), `github.com/tsurara-openapi/tsurara/packages/plugin-go` (`packages/plugin-go`) and the `tsurara-plugin` crate (`crates/tsurara-plugin`). The Python and Go types are generated by tsurara's own Python and Go backends from the protocol schema, which exercises their JSON Schema support; the Rust crate uses the real types.

## 12. CLI

| Command | Description |
|---|---|
| `tsurara generate [--config <path>] [--target <name>] [--strict] [--format json]` | Generate and write files |
| `tsurara check [--format json]` | Compare the generated output with the files on disk (a vendored runtime included, 7.5), and exit with code 1 if they differ. Also detects `@tsurara/client` version mismatches, except for vendored runtimes. For CI |
| `tsurara init` | Create a configuration file template |
| `tsurara inspect operations [--tag t] [--search text]` | The operations: id, method, path, summary, and the generated function and file |
| `tsurara inspect operation <id or "METHOD /path">` | Parameters, request body, responses, the generated function and types, the other generated values (`helpers` of the manifest: query options, keys, filters, mock handlers), and a call example in the target language |
| `tsurara inspect schema <name>` | The generated name, file and declaration of a schema (by its name in the definition or its generated name) |
| `tsurara inspect warning <code>` | What a warning code means and how to resolve it (6.8) |

`--format json` prints one JSON object on stdout instead of lines, for scripts and coding agents: for `generate`, the files written, unchanged and deleted and the warnings (code, document, JSON Pointer, message) per target; for `check`, the differences and runtime problems per target; failures as `error` with exit code 1. `spec/cli-output.schema.json` is generated from the Rust types (`tsurara_cli::output`). `inspect` subcommands take `--target` (required with several targets) and `--format json|text`, read the model, the manifest (11.1) and the generated files without writing anything, and build call examples with `Backend::example` from the sample values (18.7.1): a file that compiles next to the generated code (`example.ts` at the output root; `example.py` in the package; `example.rs` next to `mod.rs`, declared with `mod example;`; `example.go` in the package), with each language's Result handling. Arguments that are not plain scalars are decoded from JSON in Rust and Go, and through the TypeDef codec in Python; non-JSON request bodies are left for the app to fill.

### 12.1 MCP server

`tsurara mcp` is a Model Context Protocol server over stdio in the same binary: JSON-RPC 2.0, one message per line, implemented in `tsurara-cli/src/mcp.rs` without an SDK (the Rust SDKs need a newer compiler than the MSRV). Its tools are thin layers over `inspect`, `generate` and `check` and return both a short text and the JSON of the CLI (`structuredContent`): `list_targets`, `search_operations` (every word of the query must start a word of the id, method, path, summary or tags; `offset` and `limit`, default 50), `describe_operation` (with the call example of 107), `describe_schema`, `generate` (writes only into the configured output directories, like the CLI), `check` (drift is a result, not a tool error) and `explain_warning`. The guides (`docs/guide/*`, `docs/languages/*`) are embedded at build time and listed as resources (`tsurara://docs/guide/configuration.md`). Setup for clients is in `docs/guide/ai.md`; `.claude-plugin/plugin.json` registers the server as a Claude Code plugin, which also carries the skill `skills/tsurara` (its code blocks are type-checked against generated code). `tsurara init --agents` writes the rules for agents into `AGENTS.md` or `CLAUDE.md`, and `llms.txt`/`llms-full.txt` at the repository root index the documentation.

`tsurara check` finds drift between the definition and the generated files (forgetting to regenerate, editing generated files by hand) and version drift between the generated code and `@tsurara/client`. Preventing drift between the server's actual responses and the definition is the responsibility of backend contract tests and the like.

## 13. Quality assurance

- Corpus tests: generate from large real-world definitions (GitHub, Stripe, Kubernetes, OpenAI, and so on) and from definitions that collect edge cases, and pass the output through `tsc --noEmit`. The following tsconfig combinations are checked.
  - `strict`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `isolatedDeclarations`
  - `moduleResolution` set to `nodenext` and `bundler`
- Mapping table tests: each row of the table in 6.4 is a test with an input and the expected output. The expected output is checked against the meaning of the JSON Schema. Comparing printed type strings alone cannot catch mistakes in the expected values themselves (such as the mistake of making `prefixItems` tuples fixed-length).
- Assignability tests: check that values the definition allows can be assigned to the generated types, and that `@ts-expect-error` holds when assigning values it does not allow (work in 035). There is no promise that TypeScript can check every constraint. For constraints approximated in 6.4.1, the tests state that values are accepted as an approximation.
- Type stripping check: check in CI that the output can be imported and run with Node type stripping, and that it passes `tsc` with both the minimum supported TypeScript version (5.8) and the version used for development (`crates/tsurara-lang-typescript/tests/type_stripping.rs`; every tsc test runs both versions).
- Property-based tests: generate from randomly built schemas and check that `tsc` passes. `crates/tsurara-cli/tests/properties.rs` builds definitions with proptest (compositions, nullable values, references with cycles, readOnly and writeOnly, discriminators, names that stress naming), checks all cases in one run of `tsc` (strictest tsconfig) and pyright, and shrinks a failing case one checker run per step; the smallest definition is saved in `target/proptest-failures` to be added to `corpus/edge-cases`. CI runs 48 cases with a fixed seed, and a weekly workflow 2000 with a new seed (`TSURARA_PROPTEST_CASES`, `TSURARA_PROPTEST_SEED`). It found the aliases that refer to themselves through references, which now become `unknown` or lose those references with a warning.
- Snapshot tests: save the full output and detect unintended changes.
- Runtime library tests: test serialization and response parsing per OpenAPI style. Simulate failures to check that each Result `kind` is returned correctly.
- E2E tests: run `examples/pnpm-monorepo` from generation to calls in two apps.
- Performance measurement: record generation time and `tsc` time for large definitions in CI and detect regressions. Compare Node startup time, dev server loading, and `tsc` time between barrel imports and direct imports. `pnpm bench` (`scripts/bench.mjs`) measures, for GitHub (3.1), Stripe, Kubernetes and OpenAI from the corpus, the generation time of the release binary, `tsc --extendedDiagnostics` on the whole output (time and type instantiations), and one operation imported through the barrel and through its subpath (`tsc` and Node startup with type stripping). The `bench` CI job compares each push to main with the previous results (instantiations beyond +5%, times beyond +50%) and keeps them as an artifact. The Vite dev server is not measured yet.

  Results on 2026-11-11 (Apple silicon, TypeScript 7.0.2, Node 26):

  | Definition | Generation | `tsc` on the output | Instantiations | Node startup, barrel / subpath |
  |---|---|---|---|---|
  | GitHub 3.1 | 704 ms | 184 ms | 22 933 | 212 / 54 ms |
  | Stripe | 390 ms | 130 ms | 24 718 | 151 / 54 ms |
  | Kubernetes | 397 ms | 156 ms | 35 748 | 229 / 53 ms |
  | OpenAI | 313 ms | 107 ms | 13 313 | 115 / 53 ms |

  Importing through the barrel makes Node load every operation module (2 to 4 times the startup of one subpath import), as 9.2 expects; `tsc` time stays low either way.

### 13.1 Test corpus

| Definition | Source | Main things to check |
|---|---|---|
| Petstore (2.0, 3.0, 3.1) | Official examples from the OpenAPI Initiative and Swagger | Basic conversion, Swagger 2.0 normalization |
| GitHub REST API | github/rest-api-description | Large definitions, `oneOf`/`anyOf`, nullable |
| Stripe | stripe/openapi | `anyOf` and expandable fields, urlencoded bodies |
| Kubernetes | `api/openapi-spec` in kubernetes/kubernetes | Deep references, `x-kubernetes-*` extensions |
| OpenAI | openai/openai-openapi | discriminator, sequential formats (`text/event-stream`), multipart |
| Edge cases | Written in this repository | Cycles, reserved words, unusual property names, each discriminator pattern |

Sources are pinned to a commit hash or tag and checked by sha256 (`corpus/sources.json`): GitHub in both its 3.0 and 3.1 descriptions, Stripe, Kubernetes (Swagger 2.0), OpenAI (3.1), and Petstore 2.0. `pnpm corpus:fetch` downloads them into `target/corpus`, and `crates/tsurara-cli/tests/corpus.rs` generates each with the `tsurara` binary in every language, checking the TypeScript output with the tsconfig matrix on TypeScript 7.0.2 and 5.8 and the Python output with pyright. The edge cases are in `corpus/edge-cases`; each bug found in a real-world definition gets one there, so that it is checked without the download. A reference that does not resolve fails the test, because in these definitions it is a bug in tsurara.

## 14. Stability and versioning

The following five items are covered by stability promises and change only in semver major versions.

1. The rules for generated names
2. The shape of Result
3. The OperationDef format
4. The configuration file schema
5. The JSON that programs outside tsurara exchange with it: the model, the manifest and the plugin and external backend protocol (`spec/sem-model.schema.json`, `spec/manifest.schema.json`, `spec/plugin-protocol.schema.json`)

Item 1 promises the naming rules, not that individual names never change when the definition changes. For example, adding a readOnly property changes the request-side type name (6.5), and numbers in names can change with the order of the definition (6.6). Such changes are made noticeable through the diff from `tsurara check` and through warnings.

Item 5 has its own version fields, so that plugins and backends in other repositories can check what they receive:

- Compatible changes keep the version: a new optional field, or a field that becomes optional. Consumers ignore fields they do not know; the Rust types do, and the SDKs of 105 and 106 must.
- Everything else changes the version (`semVersion`, `manifestVersion`, `protocol`): a field removed, renamed, made required or given another type, and a new variant of an enum (a new kind of type or warning code), because consumers match enums exhaustively.
- The CLI produces one model and manifest version. It rejects an external backend that does not list the current `semVersion`, naming both versions, rather than converting the model down; the protocol keeps older versions where they differ only by optional parts (protocols 1 and 2, 18.11).
- Every change to the three schemas, compatible or not, is recorded in `spec/CHANGELOG.md` with the new schema's hash; a test fails when a schema changes without an entry. From the first release, the schema of each superseded version is kept as `spec/versions/<schema>-<version>.json`.

Before the first release, `semVersion` and `manifestVersion` stay at 1 and the changelog records changes without bumping them; the protocol, which external backends already negotiate, is versioned from the start.

Dependencies are kept to a minimum. The generator is a single binary, and `@tsurara/client` depends only on standard APIs.

A vendored runtime (7.5) is part of the generated output, not a library: its sources change with the generator like generated code does, and the promises above apply to what generated code uses of it (the Result shape, the OperationDef format), not to its internal files.

## 15. Out of scope

The initial version does not handle the following. Each is structured so it can be added later as a plugin or a feature of `@tsurara/client`.

- Runtime conversion from `date-time` to `Date` and from `int64` to `bigint`
- Generating generic types from `$dynamicRef`

Validation responsibilities are divided as follows. tsurara generates types and call functions, and the types assume responses match the definition.

- Validating that API responses match the definition: optional, through the `validate` option and the generated Zod schemas (8.7). Drift between the server implementation and the definition is still best prevented by backend contract tests (chapter 12).
- Validating UI forms: outside tsurara's scope. Request types (`Writable` types) can serve as the contract for the values a form finally submits, but validating values mid-input and displaying error messages are the app's responsibility.
- Generating schemas for Zod: `typescript.validators: zod` (8.7), as files separate from the types.

## 16. Open questions

| # | Question | Why it remains |
|---|---|---|
| 1 | Add definitions used at work (or ones with a similar structure) to the test corpus | To be added once such definitions are provided. Public definitions were decided as in 13.1 |
| 3 | Whether to introduce a lock file that records assigned names (`tsurara.names.json` or similar) | An option to complement name stability (6.6). Decide after seeing whether moving colliding derived names aside with a warning is enough |
| 4 | Whether to provide a mode that emits only types, without call functions | A proposal from the integration review, not part of the requirements. If adopted, it becomes a separate issue |

### 16.1 Decisions

| Question | Decision | Reflected in |
|---|---|---|
| Schema names that collide with global names | Append the suffix `Model`, and a number if it still collides | 6.6 |
| Settings Next.js needs to read the shared package | Only `allowImportingTsExtensions` in its tsconfig; no `transpilePackages` (Next.js 16.4, Turbopack and webpack) | 9.2 |
| How to split by readOnly/writeOnly | The original type drops writeOnly, and the `Writable` type drops readOnly | 6.5 |
| Whether Swagger 2.0 is in the initial scope | It is | 5.4 |
| Default for `date-time` | `string`. `Date` will be added later together with runtime conversion | 10.4 |
| Test corpus | The definitions in 13.1 | 13.1 |
| Minimum TypeScript and Node versions | TypeScript 5.8 or later, Node 22 or later | Chapter 17 |
| Whether to make a parent with a discriminator a union of the children that inherit it through allOf | No. A discriminator does not change the validation result, so only the discriminating literal is added | 6.5 |
| `nullable` written as a sibling of `$ref` in 3.0 | Ignore it per the specification and warn. There is no compatibility mode that honors siblings | 6.3 |
| When a derived type name collides with another name | The other name keeps it; the derived name gets `Operation` before its suffix, with a warning (following kubb) | 6.6 |
| A named schema used both inside JSON and as a multipart body, with binary parts | The named type follows JSON (`string`); the multipart body expands the schema inline with `Blob \| File` for its binary parts | 6.4 |
| Handling wildcard media types | Parse by the actual Content-Type (`auto`), and make the type the union of possible values. Can be treated as JSON through configuration | 8.5 |
| Generating languages other than TypeScript | A language-neutral semantic model, shared naming, lowering and runtime contract, and one backend per language; TypeScript first, Python second | 18 |
| Open questions of the multi-language design (Q1 to Q7) | See 18.16 | 18.16 |

## 17. Supported environments

| Target | Minimum version | Reason |
|---|---|---|
| TypeScript | 5.8 | The version that introduced `erasableSyntaxOnly`. Development uses 7.0.2; CI type-checks with both |
| Node | 22 | Node 20 support ended in April 2026. Running generated code directly with type stripping requires 22.18 or later |
| Rust (building the generator) | 1.85 | Uses edition 2024 |
| Python (generated code and `tsurara-client`) | 3.11 | 18.16, Q2 |

`@tsurara/client` needs `fetch`, `Request`, `Response`, `Headers`, `AbortController` and `URL` (only its constructor). `ReadableStream`, `Blob`, `FormData`, `URLSearchParams`, `AbortSignal.any` and `DOMException` are used when they exist, so the client also runs where some are missing, as in React Native: requests, timeouts and aborts work without them, and React Native file objects (`{ uri, name, type }`, passed through `reactNativeFile`) are uploaded as file parts. Streaming responses need a `fetch` with streaming bodies (`expo/fetch` in Expo); without one, `parseAs: 'stream'` returns `kind: 'parse'`. On Hermes, `runtimes/typescript/hermes` (`@tsurara/hermes-check`) bundles the client with React Native's own `fetch`, `FormData` and `URL` polyfills and its Babel preset, as Metro does: React Native 0.88's `hermesc` compiles it, and the VM of the last Hermes CLI release (v0.13.0, from the time of React Native 0.75) runs JSON calls, basic authentication, multipart uploads with `reactNativeFile`, timeouts, aborts and the `parse` failure of a stream without a streaming `fetch`. React Native and Expo have not been checked on a device yet.

## 18. Multiple languages

tsurara generates code for many languages from one OpenAPI definition: TypeScript today, and Python, Rust, C#, Go, PHP, Ruby, Kotlin, Java, Swift and GDScript next, with more to come. This chapter describes the architecture that makes each new language mostly a matter of rules and a printer, not a new generator. Where it differs from chapters 4, 6, 7, 10 and 11, which describe the current TypeScript-only implementation, this chapter is the target.

### 18.1 Goals and non-goals

Goals:

- G1. A language is added as a backend without touching the analysis of OpenAPI documents.
- G2. Every language gets types first, then call functions and a runtime library that implements the shared runtime contract (18.9).
- G3. Most of a backend is shared machinery: naming (18.6), lowering (18.5), value conversion metadata (18.7) and pretty printing (18.8). The language-specific part is a naming policy, a capability set, and a printer.
- G4. The semantic model is language-neutral, serializable and versioned. It is the input of IR plugins and of backends written as external programs (18.11).
- G5. Alternative outputs for the same language (Zod schemas, MSW handlers, pydantic models) are backends or backend flavors, built on the same machinery.

Non-goals:

- Compatibility with the current crate API, configuration keys, OperationDef shape or generated names. tsurara is at 0.x and has a single developer, so breaking changes are allowed between releases (decided 2026-11-09). The only compatibility rule is internal: refactoring steps keep the TypeScript output byte-identical as a safety net, and deliberate output changes are separate, reviewed steps.
- Implementing every language now. TypeScript and Python come first (18.14).

### 18.2 Language survey

What each language needs from the generator. The capability sets in 18.5 and the conversion strategies in 18.7 come from this table.

| Language | Type system | Value conversion (18.7) | Main constraints |
|---|---|---|---|
| TypeScript | Structural: unions, literals, intersections, index signatures | None: parsed JSON is the typed value | `erasableSyntaxOnly`, `isolatedDeclarations` |
| Rust | Nominal; enums with data, no inheritance | Annotations (serde) | Recursion needs `Box`; missing versus `null`; snake_case fields with renames |
| C# | Nominal; single inheritance, no unions | Annotations (System.Text.Json) | Polymorphism only through attributes on a class hierarchy; nullable reference types |
| Go | Nominal; no unions, no inheritance, embedding | Annotations (struct tags) plus runtime helpers for unions | Optional values through pointers; exported names and initialisms (`ID`, `URL`); one package per directory |
| Kotlin | Nominal; sealed classes | Annotations (kotlinx.serialization) | Class discriminator conventions |
| Java | Nominal; records, sealed interfaces, no unions | Annotations (Jackson) | Package equals directory; file name equals class name |
| Swift | Nominal; enums with associated values | Annotations (Codable) | Missing versus `null`; recursive structs need indirection |
| Python | Structural (TypedDict) or nominal (dataclass) | TypeDef metadata (18.7); annotations for a pydantic flavor | Sync and async clients; keywords as field names |
| PHP | Nominal classes; limited unions; no generics, element types only in PHPDoc | TypeDef metadata | Types split between native declarations and PHPDoc; PSR-4 namespaces |
| Ruby | No static types; RBS signatures | TypeDef metadata | Two files per unit (`.rb` and `.rbs`) |
| GDScript | Nominal; no unions, no nullable primitives, no generics beyond typed `Array`/`Dictionary`, integer enums only, global `class_name` | TypeDef metadata | JSON numbers parse as floats; no exceptions; HTTP through signals and `await`; `.uid` sidecar files |

### 18.3 Architecture

```
input
  → tsurara-loader: DocumentSet
  → plugins (document stage)
  → tsurara-sem: analysis → sem::Model (serializable, versioned)
  → plugins (model stage: Rust trait or `transformModel` command)
  → backend (built-in crate, or an external program; 18.11)
      a. naming: tsurara-naming with the language's NamingPolicy          (18.6)
      b. lowering: tsurara-lower with the language's Capabilities → tir   (18.5)
      c. runtime metadata: OperationDefs and TypeDefs                  (18.7, 18.9)
      d. printing with tsurara-pretty, file layout, markers               (18.8)
  → plugins (files stage)
  → tsurara-cli: write, delete stale files, check
```

#### 18.3.1 Crates

| Crate | Contents |
|---|---|
| `tsurara-loader` | Unchanged |
| `tsurara-sem` | The semantic model, its construction from a `DocumentSet`, shared normalization, semantic warnings, serde serialization |
| `tsurara-naming` | Scoped name allocation and the `NamingPolicy` trait |
| `tsurara-lower` | The lowered type IR (`tir`), `Capabilities`, the lowering passes and the validator |
| `tsurara-pretty` | A Wadler-style document printer shared by all printers |
| `tsurara-backend` | Interfaces only: the `Backend` trait, `Output`, `Markers`, and the external backend protocol types. It depends on no language crate |
| `tsurara-lang-<language>` | One crate per language: naming policy, capabilities, language-specific passes, printer, layout, options |
| `tsurara-config` | Configuration; each language's options come from its backend crate |
| `tsurara-cli` | The `tsurara` command. It depends on every built-in `tsurara-lang-<language>` crate and owns the registry that maps `language` values to backends, so no crate below it depends on a language crate |
| `tsurara-testkit` | Per-language checkers (18.12) |

The former `tsurara-codegen` crate is gone: its analysis moved to `tsurara-sem` and `emit.rs` to `tsurara-lang-typescript`. Naming moved to `tsurara-naming` and the TypeScript backend. `ir.rs` is the language-neutral type IR of the model, used by `tsurara-lower` and every backend; only its variants `Undefined`, `Ref`, `External` and `Builtin` belong to the TypeScript lowering (they never appear in the model and are not serialized). `print.rs` (TypeScript type printing, which normalization also uses for a stable member order) and `options.rs` (the common options) stay in `tsurara-sem` as well; 043 to 045 moved the TypeScript-only options and naming out and left these.

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

### 18.4 Semantic model

The semantic model keeps what the definition means. It is not the union of all languages' type systems, and it contains no identifiers chosen for a language.

#### 18.4.1 Schemas

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

Rules for what belongs in `tsurara-sem`:

- Only normalization that is exact under JSON Schema semantics stays here: merging the inline objects among `allOf` members, flattening nested `anyOf` and removing duplicate `anyOf` members (`anyOf` is associative and idempotent), unifying the three spellings of nullable into `Nullable`, resolving `$dynamicRef` statically, the readOnly/writeOnly analysis.
- `oneOf` keeps its structure and multiplicity. `oneOf: [A, A]` rejects every value that matches `A`, and nested `oneOf` is not associative, so flattening or deduplicating it would change which values are valid. A backend whose unions are inclusive anyway (TypeScript) flattens and deduplicates in its own passes.
- `allOf` members that are not objects (a scalar, an array, a union) stay as members of `AllOf`. TypeScript keeps intersecting them as today; other backends handle them in lowering (18.5.3, pass 2).
- Anything that exists because of one language's type system moves to that language's passes: absorbing a union into `unknown`, widening the index signature, discriminators as intersections with literal objects, `Nullable(X)` as `X | null`, enums as literal unions.
- The inherited discriminator (a child that refers to its parent with `allOf`) is kept as a tag (`Tag { property, values }`) among the child's `allOf` members, not pre-applied as a literal object.

In the implementation, `Union` is called `Choice` (`tsurara_sem::ir::Choice`), and `AllOf` is still the intersection node of the shared IR; it keeps every member and merges only inline objects.
- Values from the definition (`const`, `enum`, `default`, `example`) are kept as JSON values, not as strings.

#### 18.4.2 Declarations and inline candidates

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

Every inline object, enum and union is a hoisting candidate with its own `SchemaId`, a preferred name derived from its location, and a JSON Pointer:

- the owner's preferred name followed by the property name in PascalCase (`Pet` + `owner` → `PetOwner`),
- `Item` for array items, `Value` for map values, the member index for union members (`PetKind1`),
- for operations, the operation's preferred name followed by the role (`GetPetByIdQuery`, `GetPetById200`).

In the implementation, a candidate is `Type::Inline { preferred_name, loc, ty }`, wrapped around inline objects, enums and unions (also the non-null member of a nullable one) in nested positions: property values, items, map values, union members, and body, parameter and header schemas. `allOf` members are not candidates, because they merge into their owner. The preferred name is the owner's preferred name (the declaration, or the operation's id in PascalCase) followed by the path: a property name or header name in PascalCase, `Item` for items (`Item1`, `Item2` for `prefixItems`), `Value` for map values, the 1-based member index for `oneOf`/`anyOf`, `Body` for a request body, the status (`200`, `Default`) for a response, and a parameter's `name` (not its index). `tsurara_backend::hoist::claim_candidates` names them after declarations and operations, in model order, and honors `naming.overrides` by JSON Pointer.

Which candidates become named types is decided by lowering (18.5). The TypeScript backend names exactly what it names today: components, every non-component schema reached through `$ref` (such as `#/components/schemas/Pet/properties/owner`, cyclic or not, see `Converter::ref_type`), and the derived operation types. Every other candidate stays inline.

#### 18.4.3 Operations

`Operation`, `Param`, `Body`, `Response` and `Status` keep their current meaning, with these changes:

- Types inside them are `Schema`; response headers are `Property` values.
- Operations carry `preferred_name`, `OpKind` and a pointer; function names and derived type names are assigned by the backend.
- `ParseAs` becomes `BodyKind` (json, text, binary, stream, none), describing the HTTP payload.
- Servers, tags and the security requirements and schemes are kept for runtimes (Q4).

#### 18.4.4 External types

`x-tsurara-type` and type mappings are per language. In the semantic model a mapped schema keeps its own schema plus an `ExternalId`; a backend with no entry for that id uses the schema and warns.

```yaml
# In the definition
x-tsurara-type:
  typescript: { type: Uuid, import: { from: ./uuid, name: Uuid } }
  rust: { type: uuid::Uuid }
  go: { type: github.com/google/uuid.UUID }
```

#### 18.4.5 Docs and warnings

`Doc` keeps a description and structured tags (`deprecated`, `default`, `example`, `format`, constraints as values, not strings). Each printer renders them in its own syntax (JSDoc, rustdoc, XML docs, docstrings, PHPDoc, `##`).

Semantic warnings (unresolvable references, ignored `$ref` siblings, dropped `not`/`if`/`then`/`else`, statically resolved `$dynamicRef`) never mention a language. Lowering and printing produce backend warnings that name the language.

#### 18.4.6 Serialization and invariants

`sem::Model` implements `Serialize` and `Deserialize`, and carries `sem_version`. Its JSON Schema is `spec/sem-model.schema.json`, generated from the Rust types, next to the schemas of the manifest and the plugin protocol. The JSON form is serde's: field and variant names in camelCase, enums externally tagged (`{ "scalar": { "kind": "integer", "format": "int64" } }`, unit variants as strings such as `"unknown"`), locations as `{ "doc": url, "pointer": pointer }`, and doc tags as `[name, value]` pairs whose values are JSON as written in the definition. `semVersion` (`tsurara_sem::SEM_VERSION`, currently 1) changes only when the form changes incompatibly; consumers reject versions they do not know. Types that only backends produce (`Builtin`) never appear in it. The JSON form is what external backends and the `transformModel` hook receive (18.11), and what semantic case tests compare (18.12).

Ordering is part of the model: components in document order, then hoisting candidates in discovery order, then operations, then webhooks. Name allocation follows this order (18.6), so it is a documented invariant.

### 18.5 Lowering

Lowering turns the semantic model into `tir`, a type IR that can express every construct some language has. A backend declares which constructs it accepts, and shared passes rewrite the rest. After lowering, a validator checks that no construct outside the capability set remains; a violation is a bug in a pass.

#### 18.5.1 The lowered type IR

`tir` has named declarations and type expressions.

- Declarations: `Record` (fields with wire name, member name, presence and optional base), `Enum` (values, open or closed), `TaggedUnion` (discriminator property, variants), `UntaggedUnion` (members, decoded by trying in order), `Alias`.
- Expressions: `Scalar` (bool, integer with width and signedness, float with width, decimal, string, bytes, date, date-time, uuid, ...), `List`, `Map`, `Tuple`, `Optional`, `Nullable`, `Any`, `Named`, `External`, and the structural forms `InlineRecord`, `Union`, `Intersection` and `Literal` for languages that have them.

#### 18.5.2 Capabilities

| Capability | Meaning | Example values |
|---|---|---|
| `inline_records` | Anonymous object types inside other types | TS, Go: yes (the Go backend may still hoist by policy, for readable public API); Python (TypedDict needs a named declaration, dataclasses are classes), Java, C#: no |
| `structural_unions` | Unions of arbitrary types | TS, Python: yes; Rust, Swift: no (tagged only); Go, Java, C#, GDScript: no |
| `tagged_unions` | Sum types with data, or a sealed hierarchy with a discriminator | Rust, Swift, Kotlin, Java, C#: yes; Go, GDScript: no |
| `intersections` | `A & B` | TS only |
| `inheritance` | none, single, or multiple (interfaces) | C#, Kotlin: single; Go, Rust: none |
| `literal_types` | Literal and const types | TS, Python |
| `enums` | string-valued, integer-only, or none | GDScript: integer-only |
| `tuples` | Fixed and variadic tuples | TS, Python, Rust, Swift |
| `presence` | How "missing" and `null` are told apart | TS: `?` and `\| null`; Rust: `Option<Option<T>>`; Go: pointer plus runtime wrapper |
| `nullable_primitives` | Whether `int` and similar can hold `null` | GDScript: no |
| `recursion_by_value` | Whether a type can contain itself without indirection | Rust, Swift: no |
| `integer_widths` | Which integer and float widths exist | TS: none (all `number`); Java: 32/64 |
| `maps` | Maps with typed values, and records with an extra map field | GDScript before 4.4: untyped only |

#### 18.5.3 Passes

The passes run in this order. Each pass is skipped when the capability makes it unnecessary.

1. Hoist inline candidates that the language cannot write inline, using their preferred names.
2. `allOf`: an intersection if `intersections`. Otherwise, when every member is an object or a reference to one: a base type if there is one reference and `inheritance` allows it, else copy the properties of the referenced declarations. When some member is not an object (`allOf: [{ type: string }, { anyOf: [...] }]`), use the most specific member the language can express and warn that the other constraints were dropped.
3. Unions with a discriminator: a tagged union if `tagged_unions`; otherwise an untagged union decoded by a runtime helper (18.7).
4. Unions without a discriminator: a structural union if `structural_unions`; otherwise an untagged union, or `Any` with a warning when members cannot be told apart.
5. Enums: native enums where allowed, constants otherwise. Openness is decided per use site by direction, not per declaration, and does not depend on `splitVisibility` or readOnly/writeOnly. Lowering marks every use site as sent (request bodies and parameters, webhook responses) or received (responses, webhook requests). Where values are received, enums are open in languages whose deserializer would fail on an unlisted value: the value is kept in a fallback (an `Unknown(String)` variant or a string-backed value type), and the `strictEnums` option turns this off. Where values are sent, enums are closed. A component enum used in both directions gets both representations: a closed type, and an open type used at received sites (or one open type whose constructors only accept listed values, where the language allows it).
6. Discriminated unions get the same fallback, by the same direction rules, for unlisted discriminator values.

TypeScript keeps closed literal unions in both directions (decided 2026-11-09). A received value outside the union makes the type inaccurate but never fails at run time, and the output stays byte-identical. Open enums are the default only for languages where an unlisted value would make decoding fail (Python and the languages after it).
7. Literals and `const`: literal types where allowed; otherwise the underlying scalar, with the value in the docs.
8. Presence: optional and nullable become the language's representation. A wrapper type that tells missing from `null` is used only for properties that are both optional and nullable (Q3).
9. Tuples: tuples where allowed; otherwise a list of the members' union, or of `Any`.
10. Recursion: indirection where `recursion_by_value` is false.
11. Properties plus `additionalProperties`: an extra map field, flattened when serialized.
12. Scalars: widths from `format`; formats the language has no type for fall back to the base type.

In the implementation, `tsurara-lower` has `tir` (`tir.rs`), `Capabilities` (with the presets `ALL` and `MINIMAL`), `lower` and `validate`. Directions are computed per declaration from the operations (webhooks and callbacks reversed; declarations no operation reaches count as both), and every reference carries its `Site`, so that a backend emits the closed form where values are sent and the open form where they are received. Pass 12 keeps the scalar with its `format`; each backend maps formats to its own types. TypeScript keeps its own lowering (`tsurara-lang-typescript/src/lower.rs`), because its IR is the structural subset of `tir` with every capability on.

Language-specific passes run after the shared ones, for example the TypeScript widening of index signatures and discriminator intersections. Each language documents its approximations in `docs/languages/<language>.md`, in the form of 6.4.1.

### 18.6 Naming

#### 18.6.1 Contexts and scopes

Every identifier belongs to a context, and every context has a scope in which names must be unique:

| Context | Scope | Examples |
|---|---|---|
| Type | Namespace (the whole output for most languages) | `Pet`, `PetWritable`, `PetOwner` |
| Function | Namespace | `getPetById`, `get_pet_by_id` |
| Member | One declaration | Fields, enum members, union variants |
| Parameter | One function | Path and query parameter names, where a language uses them |
| Constant | Namespace | OperationDefs, TypeDefs, server lists |
| File | Directory; case-folded where the language or file system requires it | `pet.go`, `Pet.java`, `pet_owner.py` |

Snake-casing and similar conversions make names collide inside one scope (`fooBar` and `foo_bar` both become `foo_bar`), so members are allocated per declaration with the same rules as types.

#### 18.6.2 NamingPolicy

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

In the implementation, the model records name requests (`tsurara_sem::naming::NameRequest`) in the order the analysis needs names, and each backend replays them with `tsurara_naming::Names` and its policy; `Type::Named` refers to a request. The allocation algorithm in `tsurara-naming` is shared: claims follow the model order (18.4.6); reserved names get the suffix; remaining collisions get numbers; derived names (`{P}Data`, `{P}Result`, ...) that are taken move aside to `{P}Operation…` without changing the function name (6.6). Hoisted names are claimed after declarations and operations in every language except TypeScript, which keeps its current order.

#### 18.6.3 Wire names and overrides

Members keep their wire name (18.4.1). When the member name differs, the printer emits the language's rename (`#[serde(rename)]`, `[JsonPropertyName]`, struct tags, `CodingKeys`) or the TypeDef records it (18.7). TypeScript keeps property names unchanged and quotes them when needed.

- `naming.overrides` (common) maps a JSON Pointer to a preferred name. It applies to every language before its policy converts the name.
- `<language>.naming.overrides` maps a JSON Pointer to a final identifier for that language only.

Pointers can name schemas, properties, operations and hoisting candidates.

### 18.7 Value conversion

Generated code contains declarations, annotations and registrations, never conversion algorithms. Each language uses one of three strategies:

| Strategy | Languages | How JSON becomes typed values |
|---|---|---|
| None | TypeScript | Parsed JSON is the value |
| Annotations | Rust, C#, Go, Kotlin, Java, Swift, Python (pydantic flavor) | The language's serialization library, driven by annotations the printer emits. Constructs the library cannot express (untagged unions, open enums) use generic helpers from the runtime, which generated code registers but does not implement |
| TypeDef | Python (default flavor), PHP, Ruby, GDScript | The generator emits a TypeDef per declaration, and the runtime converts values generically: renames, nested records, enums with fallback, unions, number coercion (GDScript parses all JSON numbers as floats), dates |

A TypeDef is to values what an OperationDef is to requests. Its format is defined by `spec/type-def.schema.json` and is shared by every TypeDef runtime. It covers every `tir` construct a TypeDef language can receive from lowering: records (fields with wire name, member name, type, presence, base), enums (with direction-dependent fallback), tagged and untagged unions, tuples, scalars with format, lists, maps, external types (resolved through converters the user registers with the runtime by name), and references to other TypeDefs.

A TypeDef runtime converts in both directions:

- Decoding (JSON to values): renames, nested records, enum and discriminator fallbacks, union selection, number coercion, dates.
- Encoding (values to JSON): the inverse renames and conversions. A missing optional field is omitted; `null` is written only for a value that is explicitly null (the presence rules of pass 8). Unlisted enum values held in a fallback are written back as received.

Operations select their root TypeDefs through the OperationDef: for TypeDef languages, the backend adds a type reference per request body media type, per response status and media type, and per parameter that is not a scalar. The references are optional fields of the OperationDef format, so runtimes that do not need them (TypeScript) ignore them.

#### 18.7.1 Sample values

Mocks in every language print the same values, computed once from the model by `tsurara-sample`: one JSON value per declaration, and per operation one per parameter, request body (the first media type with a value) and response body (by status and media type; streams have none). Backends print them as literals. The values are deterministic: they come from the definition and from JSON Pointers, never from a clock or a random source.

For a schema, in order:

1. Its `example` (or the first of `examples`), then its `default`, when the value has the schema's JSON type (and is one of its enum or literal values). Constraints are not checked against examples.
2. `const` and the first `enum` value; the first value of a discriminator tag.
3. From the type: `true`; `1` for integers and `1.5` for numbers, moved into `minimum`/`maximum` (inclusive or exclusive, 3.0 booleans included) and up to a `multipleOf`; strings by `format` (`date-time` `2024-01-01T00:00:00Z`, `date`, `time`, `duration`, `uuid` derived from the JSON Pointer, `email`, `uri`, `uri-reference`, `hostname`, `ipv4`, `ipv6`, `byte`, `binary`), otherwise the property or parameter name (`string` where there is none), padded with `x` to `minLength` and cut at `maxLength`; arrays with one item, or `minItems` copies; tuples with their required items and rest items up to `minItems`; objects with every property that has a value, optional ones included; maps empty; `{}` for values of any type.
4. Unions take the first member that is not `null` and has a value (`null` when it is the only one). `oneOf` is not kept exclusive, as in the types. A discriminated union takes the first member with a tag value and sets the tag, unless the member's own property does not allow it.
5. `allOf` merges the members' objects, leaving out properties another member's `additionalProperties` rejects; arrays that differ meet in `[]`; an object and another JSON type have no sample. Contradictory compositions are not solved.
6. A declaration is entered at most twice per value. An optional property or array item that would enter it again is left out; a required one becomes `{}` with a `sample-cycle` warning (such a schema has no finite value).
7. A string with `pattern` and no example cannot be generated in general: the placeholder above with a `sample-pattern` warning.

Direction follows the types: request bodies use the `Writable` declarations (no readOnly properties), responses the original ones (no writeOnly properties, even required ones, which OpenAPI requires in requests only).

### 18.8 Output

- Layout belongs to the backend: one file per declaration or per module, directory structure, index files (`index.ts`, `__init__.py`, `mod.rs`), and how files refer to each other.
- Languages that need a namespace (Go module path, Java/Kotlin package, C# namespace, PHP namespace, Swift module, GDScript `class_name` prefix) get a required option in their language section.
- Project manifests (`Cargo.toml`, `.csproj`, `go.mod`, `composer.json`, `pyproject.toml`, `Package.swift`) are not generated by default (Q5).
- A vendored runtime (7.5) is a directory of the output the backend chooses, reached by the reference the language already has (a relative import, `runtimeCrate`, `runtimeModule`).
- Markers: the backend provides the line that marks a generated file in its comment syntax, the file and line that record the required runtime version, and sidecar extensions the CLI deletes together with stale generated files (`.uid` for Godot).
- Printers use `tsurara-pretty` and write final, deterministic output. Backends do not call external formatters, because `tsurara check` compares bytes.

### 18.9 Runtime contract

Every runtime implements the same contract, so that generated code in any language stays thin:

- OperationDef: the format of request and response metadata, defined by `spec/operation-def.schema.json`. A backend emits it as a literal of its language; converted to JSON, it validates against the schema.
- TypeDef: 18.7, for runtimes with the TypeDef strategy.
- Result kinds: `success`, `http`, `network`, `timeout`, `aborted`, `parse`, `unexpected`, and the reserved `validation`, with the meanings in 8.2. Each language represents them idiomatically: a discriminated union in TypeScript, an enum in Rust and Swift, a sealed hierarchy in Kotlin, Java and C#, `(T, error)` with typed errors in Go, a result object in GDScript (which has no exceptions). Python, PHP and Ruby return result objects and offer an `unwrap` that raises. The contract does not assume promises; each runtime picks sync, async, or both.
- Serialization and parsing: parameter styles, `explode`, `allowReserved`, `deepObject`, `content` parameters, request bodies by media type including multipart `encoding`, and the body kind table (8.5).
- Runtime capabilities: a runtime declares the body kinds, parameter styles and media types it supports. The backend warns about and leaves out the call functions of operations the runtime cannot perform, instead of generating code that fails at run time.
- Versions: `OPERATION_DEF_VERSION` and the TypeDef version are shared. The runtime version range required by generated code is per runtime and recorded through the backend's markers.

Every runtime has two layers. The types layer is what generated declarations need to be declared, encoded and decoded: optional and nullable markers, union helpers, file values, and the TypeDef codec where the language uses TypeDefs. It depends on no HTTP client and no async runtime. The client layer is everything else: the client, OperationDefs at run time, Results, retries, sequences. Output generated with `operations: false` (18.10) uses the types layer only. Per language:

| Language | Types layer | Client layer |
|---|---|---|
| TypeScript | Empty: declarations import nothing (channel decoders use `decodeMessage`, which sends nothing) | `@tsurara/client` |
| Python | `TypeDefs`, `File`, `MISSING`, `OperationDef`, `SecurityScheme`: `import tsurara_client` with only the standard library | The rest, imported on first use; httpx comes with the `http` extra (`tsurara-client[http]`) |
| Rust | `Nullable`, `File`, `tagged_union!`, `serde`/`serde_json` (`default-features = false`) | The `client` feature (tokio), with `reqwest` for the default transport |
| Go | `types.go` and `value.go` of the one package `tsurara`; generated types without operations import no `net/http` | The rest of the package. A subpackage would only move names: the module has no dependencies, and the linker drops what types do not use |

Later runtimes (Swift, Kotlin, C#, GDScript, ...) keep the same split from the start, and can be vendored (7.5): their sources must work as a directory of the user's project as well as a package. The TypeDef decode and encode vectors are the conformance of the types layer: Python runs them without httpx.

Every runtime also has a mock transport for tests: `@tsurara/client/testing`, `tsurara_client.testing`, the Rust `testing` feature and the Go package `tsuraratest`. It answers at the transport seam from handlers routed by method and path template, with the routing rules and vectors of `spec/README.md` (Mock transports) and `spec/conformance/mock-routing.json`, so generated mocks and hand-written tests work the same way in every language.

Conformance vectors in `spec/conformance/` are data. Request vectors give an OperationDef and an input, and expect a method, URL, headers and body. Response vectors give an OperationDef, status, headers and body, and expect a Result kind and data. Decode vectors give a TypeDef and JSON, and expect the decoded value in a neutral form; encode vectors give a TypeDef and a neutral value, and expect JSON, including the omitted-versus-null cases. Values that are not JSON use a tagged form. A runtime must pass all vectors for the features it declares before its backend emits call functions.

Runtimes live in `runtimes/<language>/`. `@tsurara/client` moves to `runtimes/typescript/`.

### 18.10 Configuration

One target produces one language. Two languages from one definition are two targets with the same `input`.

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

- Common keys: `name`, `input`, `output`, `language`, `filter`, `splitVisibility`, `naming`, `hooks`.
- Everything that depends on the language, including `typeMappings`, `overrides` and `naming.overrides` by final identifier, goes in the section named after the language. A section for a language other than the selected one is an error.
- The configuration JSON Schema is assembled from the common part and every built-in backend's options.
- The current top-level TypeScript keys (`importExtension`, `enumStyle`, `aggregateMaps`, `clientModule`, flat `typeMappings` and `overrides`) are removed.

### 18.11 Plugins and external backends

- The model stage of plugins receives `sem::Model`. Besides the Rust `Plugin` trait, a `transformModel` hook passes the model as JSON on stdin and reads the transformed model from stdout, like `transformDocument`.
- An external backend is a program selected with `language: { command: [tsurara-backend-elm] }`. The CLI runs it twice:
  1. `describe`: the program writes `{ protocol, semVersions, markers }` to stdout. `semVersions` lists the model versions it accepts, and `markers` has the same content as `Backend::markers` (generated-file marker, runtime version marker, sidecar extensions). The CLI stops with an error when the current model version is not listed.
  2. `generate`: the program receives `{ protocol, semVersion, model, common, options }` on stdin and writes `{ files, warnings }` to stdout.

  The CLI treats the result like a built-in backend's: stale-file deletion, sidecars and `tsurara check` use the described markers. Protocol 1 gives the program the semantic model only; the shared naming and lowering are offered as below (Q6).

  Protocol 2 adds an optional `manifest` (11.1) to `generate`'s answer; the CLI speaks protocols 1 and 2, and sends `generate` the protocol the program described.

  Shared lowering and naming, in either protocol and only for programs that ask:

  - `describe` may add `lowering: { capabilities }` (the flags of `tsurara_lower::Capabilities`, camelCase) and `naming`, a naming policy as data (`tsurara_naming::data::DataPolicy`): per context (`type`, `function`, `member`, `parameter`, `constant`, `file`; a missing one uses `type`'s) the `case` (`pascal`, `camel`, `snake`, `screamingSnake`, `kebab`, `preserve`), `digitPrefix`, `upperPrefix` (Go's `X`), `fallback`, `ascii` (file names), `reserved` and `reservedSuffix`, and the `initialisms` the Pascal and camel cases write in capitals. `naming` needs `lowering`.
  - `generate` then also receives `lowered`, the model lowered to `tir` for those capabilities (its JSON form is part of `spec/plugin-protocol.schema.json`, under `semVersion`), and `names` (`tsurara_lower::AllocatedNames`): per declaration of `lowered` its type name, file name and member names (record fields or enum values), and per operation its function name, allocated by `Names` with the policy. Lowering warnings are added to the program's.
  - The vocabulary covers Go's policy (a test compares the data form with `GoPolicy` on the edge-case corpus); built-in backends keep their Rust policies, which also allocate derived names (`{P}Options`) and more scopes than `names` has. Rules beyond the vocabulary need the crates.
  - Backends written in Rust use the crates instead: `tsurara-loader`, `tsurara-sem`, `tsurara-naming`, `tsurara-pretty`, `tsurara-lower`, `tsurara-sample` and `tsurara-backend` are published with one version, released with the CLI; each crate's documentation names its stable API. `examples/backend-rust` builds against them as packaged, and `examples/backend-typescript` uses the protocol.

  In the implementation: the target says `language: { command: [program, ...args], options: {...} }`; the command runs in the directory of the configuration file, with `describe` or `generate` appended. `describe` prints `{ "protocol": 1, "semVersions": [1], "markers": { "generated": "# Generated by ...", "version": { "file", "prefix" }, "sidecars": [".uid"] } }` (`version` and `sidecars` are optional). `generate` reads `{ "protocol", "semVersion", "model", "common", "options" }` (the model and the common options in their JSON forms, 18.4.6) and prints `{ "files": [{ "path", "contents" }], "warnings": [...] }`, where warnings use the model's warning form and get the language `external`. The types are in `tsurara_backend::external`.

### 18.12 Testing

- Semantic tests: the mapping table in 6.4 is checked once, against the JSON form of the semantic model.
- Case files: `expect` is a map from language to printed output; a case can cover several languages.
- Lowering tests: each pass is tested on `tir` with small capability sets, and the validator runs on every test output.
- Checkers: `tsurara-testkit` has a checker per language (`tsc`, `cargo check`, `dotnet build`, `go vet`, `kotlinc`, `javac`, `swiftc`, `mypy`/`pyright`, PHPStan, `steep`, `godot --headless --check-only`). A checker whose toolchain is missing skips its tests unless `TSURARA_REQUIRE_CHECKERS` lists it. CI runs one job per language.
- Corpus: the definitions in 13.1 are generated and checked for every language.
- Runtimes: every runtime runs all conformance vectors.
- Backends outside this repository: `tsurara test-backend --backend <command> --check <command>` runs a backend on the edge-case corpus, embedded in the binary, and on directories of definitions (`--definitions`, for the real-world corpus), and runs the checker command in each output directory; a failing definition is named and its directory kept. `tsurara spec <dir>` writes the runtime contract of the version (`spec/`: schemas, `README.md`, conformance vectors), so runtimes elsewhere take the vectors from the binary they test with, not from a checkout. The property tests stay in this repository: their definition generator is test code built on proptest. CI runs the command on `examples/backend-typescript`.

### 18.13 Adding a language

1. Add a row to the survey (18.2).
2. Write `docs/languages/<language>.md`: capabilities, approximation table, conversion strategy, layout, options.
3. Implement the `NamingPolicy`: casing, initialisms, reserved words per context, suffixes, file names.
4. Implement the printer with `tsurara-pretty`, the layout and the markers.
5. Add the checker to `tsurara-testkit` and a CI job; run the corpus.
6. Ship types-only behind an experimental flag.
7. Implement the runtime in `runtimes/<language>/` and pass the conformance vectors.
8. Emit call functions.

A backend in another repository follows the same steps through the protocol (18.11): `describe` with its capabilities and naming policy as data (or the crates, in Rust), `tsurara test-backend` with its checker in place of the corpus tests, and `tsurara spec` for the vectors. `docs/guide/backends.md` is the guide, with a repository layout and a list of known backends; `examples/backend-typescript` is the template.

### 18.14 Roadmap

| Language | Backend | Runtime | Notes |
|---|---|---|---|
| TypeScript | Exists; moves to `tsurara-lang-typescript` | `@tsurara/client` | First |
| Python | Types and call functions; `docs/languages/python.md` | `tsurara-client` in `runtimes/python`: httpx, sync and async clients, TypeDef codec | Second |
| Rust | Types and call functions, experimental; `docs/languages/rust.md` | `tsurara-client` in `runtimes/rust`: reqwest behind a `Transport` trait, `tagged_union!` | Third |
| Go | Types (experimental) and call functions; `docs/languages/go.md` | The `tsurara` package in `runtimes/go`: standard library only, `(T, error)` with `*Failure[E]` | With Rust; the first language without unions |
| C#, Kotlin, Java, Swift, PHP, Ruby, GDScript | Filed later, using 18.13 | Later | |

TypeScript comes first: it is rebuilt on the shared crates and stays the reference output. Python comes second. It exercises the parts TypeScript does not: hoisting into named types (dataclasses), scoped member names (snake_case with wire names), open enums by direction, the TypeDef strategy in both directions, and keywords as field names.

Python has structural unions and multiple inheritance, so it does not exercise the fallbacks for languages without unions or inheritance (Go, Java, C#, GDScript). Those passes are covered by lowering tests with small capability sets until such a language is added.

### 18.15 Migration plan

Refactoring steps keep the TypeScript output byte-identical (every existing snapshot unchanged). Steps that change it on purpose say so. 041 depends on 029 because today a `contentMediaType` string inside JSON becomes `Blob | File` (`table.yaml` expects it); 029 changes those snapshots on purpose and is reviewed on its own, so that 041 can keep the rest unchanged.

| Issue | Change | Depends on |
|---|---|---|
| 036 | Decide the open questions; merge this document into design.md | — |
| 037 | Split into crates; `Backend` trait and registry; TypeScript moves to `tsurara-lang-typescript` | 036 |
| 038 | Integer, number and format in the model | 037 |
| 039 | Explicit enum node | 037 |
| 040 | Structured discriminator; `allOf` structure kept | 037 |
| 041 | `Binary`, `BodyKind`, per-language external types | 037, 016, 029 |
| 042 | `tsurara-naming`: contexts, scopes, `NamingPolicy`, wire names; the model holds no identifiers | 038–041, 032 |
| 043 | Semantic and backend warnings | 042, 015 |
| 044 | Configuration: `language`, language sections, removed top-level keys | 042, 016 |
| 045 | Serializable, versioned semantic model | 042 |
| 047 | Runtime contract: OperationDef schema, Result kinds, runtime capabilities, conformance vectors; move `@tsurara/client` | 036 |
| 048 | Hoisting candidates with preferred names | 042 |
| 049 | Backend markers and sidecars in the CLI | 037 |
| 050 | Semantic case tests, per-language expectations, checker framework | 045 |
| 051 | `tsurara-lower`: `tir`, capabilities, shared passes, validator | 048 |
| 052 | TypeDef format, operation bindings, decode and encode vectors | 047, 051 |
| 053 | `tsurara-pretty`; port the TypeScript printer | 037 |
| 054 | External backend protocol with `describe` | 045, 044, 049 |
| 055 | Python backend, types only | 043, 044, 049, 050, 051, 052, 053 |
| 056 | `transformModel` hook | 045, 017 |

### 18.16 Decisions

Decided on 2026-11-10 (the proposals of the earlier draft were adopted).

| # | Question | Decision |
|---|---|---|
| Q1 | Default Python flavor | Dataclasses with TypeDefs; TypedDict and pydantic as flavors later |
| Q2 | Minimum Python version of generated code | 3.11, the oldest version still supported after 3.10 reached end of life in October 2026. The `type` statement (3.12) is not used until the minimum is raised |
| Q3 | When to tell a missing property from `null` | Only for properties that are optional and nullable; everything else uses the language's single optional form |
| Q4 | Security schemes in the model and the runtime contract | Kept in the model and in OperationDefs; runtimes ask an `auth` hook for credentials (8.1) |
| Q5 | Generating project manifests | Off by default; a per-language option later if users ask |
| Q6 | Shared naming and lowering for external backends | Decided: the published crates, and `lowering`/`naming` in `describe` with `lowered`/`names` in `generate` (18.11) |
| Q7 | May the TypeScript output change to follow shared rules (pretty printer, scoped naming)? | Yes, but only as separate steps whose snapshot diffs are reviewed |

Decided on 2026-11-09: TypeScript keeps closed enums and discriminators in both directions; open enums are the default for languages whose decoding would fail on unlisted values (18.5.3).
