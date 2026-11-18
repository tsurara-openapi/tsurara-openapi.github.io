---
title: "Configuration"
sourcePath: docs/guide/configuration.md
sourceHash: c1fc416b2bd0
---

tsurara reads `tsurara.config.yaml` (or `.yml`, `.json`, `.toml`) from the current directory or the nearest parent, or the file given with `--config`. The npm package `tsurara` includes `schema/tsurara.config.schema.json`, which describes every key for editor completion:

```yaml
# yaml-language-server: $schema=./node_modules/tsurara/schema/tsurara.config.schema.json
```

## A target

The top level is one target, unless there is `targets`.

```yaml
input: ./openapi.yaml            # a path relative to this file, or a URL
output: ./src/generated          # relative to this file
language: typescript             # typescript (default) or python
```

| Key | Default | |
|---|---|---|
| `name` | `default` | Name of the target, for `tsurara generate --target`. Required when there are several targets |
| `input` | required | The definition: a path relative to this file, or a URL. Or an object: `url`, and `headers` sent only to that URL's origin (`Authorization: "Bearer ${TOKEN}"`) |
| `output` | required | The output directory. tsurara writes only changed files and deletes stale files that start with its generated-file marker |
| `language` | `typescript` | `typescript`, `python`, `rust` (experimental), `go` (experimental), or a backend program: `{ command: [program, args...], options: {...} }` |
| `filter` | | `tags` and `operationIds`: only these operations. `excludeTags` and `excludeOperationIds`: all but these, also among the included ones. With any of them, only the schemas the remaining operations use are emitted, and webhooks are left out |
| `naming.overrides` | | Preferred names per JSON Pointer, for every language: `"#/components/schemas/Error": ApiError`. Each language's naming rules still apply |
| `splitVisibility` | `true` | Emit `XWritable` types (TypeScript) for schemas with `readOnly`/`writeOnly`: the plain type for responses, the writable one for requests |
| `wildcardAsJson` | `false` | Treat wildcard media types (`*/*`, `application/*`) as JSON, for APIs that only answer JSON. By default they are parsed by the actual Content-Type |
| `operations` | `true` | Generate the operations. With `false`, only the types of the schemas, webhooks and channels are emitted, and the output needs only the types layer of the runtime (no HTTP client; see [Types without the client](../types/#types-without-the-client)) |
| `runtime` | `package` | Where generated code finds its runtime: `package` (`@tsurara/client`, `tsurara-client`, ...) or `vendor`, a copy of the runtime written into the output (see [A vendored runtime](../client/#a-vendored-runtime)) |
| `hooks` | | Commands run at stages of generation (below) |
| `typescript` | | Options of the TypeScript backend (below); only with `language: typescript` |
| `python` | | Options of the Python backend (below); only with `language: python` |
| `rust` | | Options of the Rust backend (below); only with `language: rust` |
| `go` | | Options of the Go backend (below); only with `language: go` |
| `extends` | | One file or a list: their settings are the defaults of this file (below) |

Writing the section of another language (`python:` with `language: typescript`) is an error.

## TypeScript options

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

| Key | Default | |
|---|---|---|
| `importExtension` | `js` | Extension of relative imports in generated code: `js` (for `tsc` builds and bundlers), `ts` (to run with Node type stripping; consumers need `allowImportingTsExtensions` or `rewriteRelativeImportExtensions`), or `none` (Metro, some bundlers) |
| `layout` | `split` | `split`: one file per operation (`operations/getPet.ts`) and per schema (`schemas/Pet.ts`); `tags`: one file per tag; `single`: one file |
| `enumStyle` | `union` | `union`: string literal unions; `const`: also an object keyed by the values (`Status.available`), with the type derived from it |
| `aggregateMaps` | `false` | Also emit `paths.ts` and `operations.ts`, maps of every operation for generic clients |
| `clientModule` | `@tsurara/client` | The module generated code imports the runtime from |
| `mocks` | | `msw` or `fetch`: also emit mock factories (`mockPet()`, from the sample values of the definition) and one request handler per operation under `mocks/`, as MSW handlers or as routes for `mockFetch` of `@tsurara/client/testing` ([Mocks](../mocks/)). Nothing else imports them, and without the option nothing mentions `msw` |
| `query` | | `tanstack`: also emit TanStack Query 5 options under `query/`: per read (`GET`, `HEAD`, `QUERY`) a typed query key factory and query options, per other operation mutation options ([The client](../client/#tanstack-query)). Nothing else imports them, and without the option nothing mentions `@tanstack` |
| `infiniteQueries` | | Pagination per operation id for infinite query options (with `query: tanstack`): `param` (the parameter that carries the page, `query.cursor`), `initial` (the first page; default: left out), `next` and `previous` (JSON Pointers into a success body, `/nextCursor`; absent or `null` ends the query; without `next` the app gives `getNextPageParam`). Wins over `x-tsurara-pagination` on the operation in the definition, which takes the same fields. |
| `validators` | | `zod`: also emit Zod 4 schemas under `zod/` and `zod/operations.ts` with `responseSchemas`, for response validation with `validateResponses` ([The client](../client/#validation)). Without it nothing mentions `zod` |
| `validatorConstraints` | `false` | With `validators: zod`, also check the definition's constraints (`minLength`, `maxLength`, `pattern`, `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf`, `minItems`, `maxItems`, `uniqueItems`, `minProperties`, `maxProperties`) and the formats `uri`, `ipv4`, `ipv6`, `date`, `time` and `duration`. Off by default: response validation would reject values that break them. A `pattern` that is not a JavaScript regular expression is left out with a warning |
| `typeMappings` | | A type per `format` (`uuid`, `date`, ...): a type expression, or `{ type, import: { from, name } }`. Paths in `from` that start with `.` are relative to this file. A mapping must not change what JSON parsing produces: `Date` for `date-time` and `bigint` for `int64` are errors |
| `overrides` | | A type per JSON Pointer, in the same form as `typeMappings` |
| `naming.schemaCase` | `preserve` | `preserve` keeps component names that are identifiers; `pascal` makes every type name PascalCase |
| `naming.overrides` | | Final TypeScript identifiers per JSON Pointer, used as they are |

Types in `typeMappings`, `overrides` and `x-tsurara-type` must be type expressions (names, type arguments, arrays, `|`, `&`, literals); anything else is an error in the configuration and ignored with a warning in a definition.

## Python options

| Key | Default | |
|---|---|---|
| `strictEnums` | `false` | Enums and discriminators reject values the definition does not list. By default they keep them where values are received (`Status | str`) |
| `mocks` | `false` | Also emit `mocks/`: `mock_{name}()` factories from the sample values and per operation a route for `MockRouter` of `tsurara_client.testing` ([Python](../../languages/python/#mocks)) |

## Rust options

The Rust backend is experimental ([docs/languages/rust.md](../../languages/rust/)).

| Key | Default | |
|---|---|---|
| `runtimeCrate` | `tsurara_client` | The path generated code uses for the runtime crate. Required with `runtime: vendor`: the path of the generated module `runtime` in your crate (`crate::api::runtime`) |
| `mocks` | `false` | Also emit the module `mocks` (compiled for tests and with a crate feature `mocks` that enables `tsurara-client/testing`): factories and routes for `MockTransport` ([Rust](../../languages/rust/#mocks)) |
| `typeMappings` | | Types per `format`, as type paths: `date-time: chrono::DateTime<chrono::Utc>` |
| `overrides` | | Types per JSON Pointer: `"#/components/schemas/Id": uuid::Uuid` |

## Go options

The Go backend is experimental ([docs/languages/go.md](../../languages/go/)). It writes one package into `output`.

```yaml
language: go
go:
  package: petstore
```

| Key | Default | |
|---|---|---|
| `package` | The output directory's name | The package name of the generated files; the directory name is lower-cased without other characters (`pet-store` → `petstore`), with `api` appended to a Go keyword (`go` → `goapi`), or `api` |
| `runtimeModule` | `github.com/tsurara-openapi/tsurara/runtimes/go` | The import path of the runtime module (`runtimes/go`). With `runtime: vendor`, the import path of `internal/tsurara` in the output, computed from the nearest `go.mod` |
| `mocks` | `false` | Also emit `mocks_gen.go`, built with the tag `tsurara_mocks`: `Mock{Type}()` factories and routes for `tsuraratest` ([Go](../../languages/go/#mocks)) |
| `typeMappings` | | Types per `format`, with the import path of their package: `date-time: { type: time.Time, import: { from: time } }` |
| `overrides` | | Types per JSON Pointer: `"#/components/schemas/Id": int64` |

## Targets

```yaml
extends: ../../tsurara.base.yaml
typescript:
  importExtension: ts           # the default of every target below
targets:
  - name: public
    input: https://api.example.com/openapi.json
    output: src/generated/public
  - name: admin
    input: ./admin.yaml
    output: src/generated/admin
    filter: { tags: [users] }
```

Keys at the top level are the defaults of every entry of `targets`. Each target needs a unique `name`.

## extends

`extends` takes one file or a list. Objects are merged deeply, and arrays and other values are replaced; the file that extends wins. Every file is read and checked on its own first, so a relative path stays relative to the file it is written in, and hooks run in the directory of their file.

## Plugins

```yaml
plugins:
  - ./tsurara.plugin.ts                         # run with Node through @tsurara/plugin
  - { module: ./other.py, runtime: [python, -m, tsurara_plugin] }
```

Each module runs once per `tsurara generate` and takes part in the stages it declares (design.md 11.2, [Plugins](../plugins/#plugins-in-typescript)). Paths are relative to the file they are written in.

## Environment variables

`${VAR}` in any string is replaced with the environment variable, so tokens stay out of the file. An unset variable is an error.

## Hooks

Hooks and plugins are commands that `tsurara generate` runs (and `generate` of the MCP server, for coding agents), with your permissions. A configuration file is code: generate only with configurations you trust, as you would run only scripts you trust. The paths of the files that hooks and plugins return must stay inside the output directory (relative, no `..`); tsurara refuses others.

| Hook | Runs | Input and output |
|---|---|---|
| `transformDocument` | Before analysis | The root definition as JSON on stdin; the transformed definition on stdout |
| `transformModel` | After analysis | The model as JSON (versioned by `semVersion`) on stdin and stdout |
| `extend` | After generating | `{ language, model, manifest, common, marker }` as JSON on stdin; files to add (`[{ path, contents }]`) on stdout, each starting with `marker` ([plugins](../plugins/)) |
| `transformFiles` | Before writing | The output files (`path`, `contents`) as JSON on stdin and stdout |
| `afterWrite` | After writing | A list of commands; `{output}` is replaced with the output directory |

```yaml
hooks:
  transformDocument: [node, scripts/patch-openapi.mjs]
  afterWrite:
    - [biome, format, --write, "{output}"]
```

A hook is a command as a list (`[program, args...]`). A failing hook stops generation.

## Extension fields in definitions

| Field | |
|---|---|
| `x-tsurara-type` | A type per language for a schema: `{ typescript: "Brand<'Uuid'>", python: UUID }`, or with an import: `{ typescript: { type: Uuid, import: { from: ./ids.ts, name: Uuid } } }` |
