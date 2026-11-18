---
title: "Go"
sourcePath: docs/languages/go.md
sourceHash: cb0e62e7e125
---

The Go backend (`language: go`, crate `tsurara-lang-go`) generates structs, named types with constants, and one function per operation for the runtime module `github.com/tsurara-openapi/tsurara/runtimes/go` (package `tsurara`, `runtimes/go`). This document describes the mapping. The backend is experimental: `tsurara generate` says so, and its output may change.

Generated code and the runtime use the standard library only (`encoding/json`, `net/http`) and need Go 1.24 or later, for the `omitzero` struct tag option. Go is the first language near the minimal capability set: no unions, no inheritance, no native enums, no literal types, and only pointers to tell a missing value from a zero value.

## Capabilities

`tsurara_lang_go::CAPABILITIES` (design.md 18.5.2):

| Capability | Value | Notes |
|---|---|---|
| `inline_records` | no | Inline objects become structs named after their place (`PetOwner`) |
| `structural_unions` | no | Unions become wrapper structs (below) |
| `tagged_unions` | yes | Also a wrapper struct, decoded by the discriminator instead of by trying members |
| `intersections` | no | `allOf` becomes one struct with the fields copied |
| `inheritance` | none | Embedding was considered and rejected: promoted fields with the same JSON name are silently dropped by `encoding/json` |
| `literal_types` | no | A `const` is its scalar type |
| `enums` | none | A named type with constants (`EnumRepr::Constants`) |
| `tuples` | no | Lists |
| `strict_decoding` | no | A named string or integer type accepts any value, so enums are open without a fallback |
| `nullable_primitives` | yes | Pointers |
| `recursion_by_value` | no | A struct cannot contain itself: pointers on the fields that close a cycle (pass 10); slices and maps need none |

## Value conversion

Annotations (design.md 18.7): `encoding/json` struct tags. What tags cannot express (unions, additional properties, optional and nullable fields) gets generated `MarshalJSON` and `UnmarshalJSON` methods that only call generic helpers of the runtime (`tsurara.UnmarshalTagged`, `tsurara.UnmarshalUntagged`, `tsurara.MarshalUnion`, `tsurara.MarshalWithExtra`, `tsurara.UnmarshalWithExtra`); the algorithms live in the runtime and are covered by its tests. OperationDefs carry no TypeDef references.

`encoding/json/v2` (an experiment since Go 1.25) would remove some helpers (it tells missing from `null` with `omitzero` and has inline maps), but it is not stable in the oldest supported Go; the helpers keep the generated code the same when it can be used.

## Mapping

| Model | Go |
|---|---|
| Object | `type Pet struct { ... }` |
| Required property | `Name T `json:"name"`` |
| Optional property | `Name *T `json:"name,omitzero"`` (`nil` is missing); slices and maps without the pointer (`[]T`, `nil` is missing, an empty slice is sent as `[]`) |
| Nullable property | `Name *T `json:"name"`` (`nil` is `null`) |
| Optional and nullable | `Name tsurara.Nullable[T] `json:"name,omitzero"``, with `Missing`, `Null` and `Value` states (`tsurara.Value(v)`, `tsurara.Null[T]()`; Q3) |
| `additionalProperties` | `AdditionalProperties map[string]T `json:"-"`` with generated methods that call `tsurara.MarshalWithExtra` and `tsurara.UnmarshalWithExtra` |
| Object with only `additionalProperties` | `map[string]T` |
| String enum | `type Status string` with `const ( StatusAvailable Status = "available"; ... )`; any other string is kept |
| Integer enum | `type Level int64` with `const ( Level1 Level = 1; ... )` |
| Discriminated union | `type Pet struct { Cat *Cat; Dog *Dog; Unknown json.RawMessage }` with one pointer per member; `UnmarshalJSON` reads the discriminator and decodes the whole object into that member, `MarshalJSON` writes the member that is set. `Unknown` (where values are received) keeps the JSON of an unlisted tag; the `defaultMapping` member takes it instead when there is one |
| Other unions (`oneOf`, `anyOf`, type arrays) | The same wrapper (`Integer *int64; String *string`); `UnmarshalJSON` tries the members in order and keeps the first that decodes |
| `allOf` | One struct with the fields of every member |
| Alias | `type Name = T` |
| `$ref` cycles | A pointer on the fields that close the cycle |
| `integer` (`int32`, `int64`, none), `number`, `boolean` | `int32`, `int64`, `int64`, `float64`, `bool` |
| `string` (any format) | `string`; formats are in the docs, and type mappings can name other types (`time.Time`) |
| Array, map | `[]T`, `map[string]T` |
| `{}`, external without a `go` entry | `any` |
| Binary | `tsurara.File` (bytes, file name, media type) where sent (bodies, multipart parts); `[]byte` for responses |
| `x-tsurara-type` / type mappings | The `go` entry, or `go.typeMappings` and `go.overrides`: a type with the import path of its package (`{ type: uuid.UUID, import: { from: github.com/google/uuid } }`, `{ type: time.Time, import: { from: time } }`), checked like 073 |

### Approximations

| Construct | Approximation |
|---|---|
| Untagged unions | The first member that decodes wins; struct members are decoded with unknown fields disallowed, so that an object does not match every struct. Required fields are not checked |
| Required properties | Not checked when decoding: a missing one is the zero value |
| Nullable required properties | A missing value decodes as `nil` |
| `const` | Its scalar type |
| Tuples | `[]any` |
| String and number constraints, `oneOf` exclusivity | Not checked |
| Integers written with a fraction (`1.0`) | Rejected by `encoding/json` |
| Properties whose names a struct tag cannot hold (with `"`, `\\`, `,`, `'` or a backquote, or empty) | Left out, with a warning |
| Tagged unions | `Unknown` is added where values are received; enums need no fallback, since a named type keeps any value |

## Layout and naming

One package in the output directory (Go cannot split a package across directories without import cycles). One file per declaration (`pet_gen.go`) and per operation (`get_pet_by_id_op_gen.go`), and `tsurara_gen.go` with the package documentation and the runtime version. File names end in `_gen.go`, so that no name ends in a build constraint (`_linux.go`, `_test.go`). Every file starts with `// Code generated by tsurara. DO NOT EDIT.`, the line Go tools recognize, and is printed as `gofmt` would (aligned fields, tags and comments), since backends run no formatter (18.8). Descriptions become `//` comments without their indentation and blank lines, so that gofmt finds no code blocks, lists or headings to rewrite.

Everything is exported: types, fields, constants and functions are PascalCase with Go's initialisms (`ID`, `URL`, `HTTP`, `JSON`, `API`, ... as golint lists them, also in the plural: `PetID`, `PhotoURLs`, `GetPetByID`). A name whose first letter has no upper case gets `X` (`X日本語`), one that starts with a digit `V`. Enum constants are the type's name and the value (`PetStatusAvailable`). All of them share the package scope. Functions keep their operation's name: a schema with the same name moves aside, as `{Name}Body` when it is that operation's request body (`toggleAll` with the schema `ToggleAll` gives `ToggleAll(ctx, c, body ToggleAllBody, nil)`), otherwise as `{Name}Model`. Other collisions are numbered in claim order (types, constants, then functions). Go's keywords and predeclared identifiers are lower case, so exported names never collide with them; only names that would be empty or start with a digit change (`V1`). Fields are named per struct, after the names the struct uses itself (`AdditionalProperties`), and carry their JSON key in the tag.

## Call functions and results

```go
func GetPetByID(ctx context.Context, c *tsurara.Client, petID int64, opts *GetPetByIDOptions) (*tsurara.Success[Pet], error)
```

- The doc comment starts with the function's name (`// GetPetByID calls GET /pet/{petId}.`), followed by the summary and description.
- The context cancels the call and carries deadlines. Required parameters and a required body are arguments; everything optional is a pointer field of `{Operation}Options`, and `opts` may be `nil`.
- A body with several media types is a wrapper struct `{Operation}Body` with one pointer per media type (`JSON *Pet`, `Form *Pet`, `OctetStream *tsurara.File`); the field that is set picks the `Content-Type`.
- `*tsurara.Success[T]` has `Status`, `Data T`, `Headers` and `Operation`. `T` is the success body type: a response without content is `struct{}` (or the zero value of the other response's type), different types `any`; a response with a JSON media type is read as JSON (as in Rust). Binary responses are `[]byte`, text responses `string`.
- Server-Sent Events, JSON Lines and JSON text sequences with an item schema (`itemSchema`, or `x-itemSchema` before 3.2; design.md 8.5) are `*tsurara.Success[*tsurara.Items[T]]` when every success is read item by item: the function calls `tsurara.DoItems` and returns once the headers have arrived, and `for item, err := range s.Data.All()` reads them. Events are a union wrapper with one pointer per event (`StreamEvent{StreamNoteEvent *StreamNoteEvent; ...; Unknown json.RawMessage}`), selected by `event`; several names of one event are a named type with constants (`MixedPingEventNamePong`). Leaving the loop closes the response, `Close` closes it without reading, and the client's timeout does not cover reading the items (the context does). With a JSON media type next to the stream, the operation is read as JSON as above.
- The error is `*tsurara.Failure[E]` for every outcome of the contract except success, with `Kind` (`tsurara.KindHTTP`, `KindNetwork`, `KindTimeout`, `KindParse`, `KindUnexpected`, `KindAborted`), `Status`, `Documented` with the documented error body `E` when there is one, the raw body otherwise, and `Cause`. It unwraps to the cause, so `errors.Is(err, context.Canceled)` works. `errors.As(err, &failure)` with `var failure *tsurara.Failure[Problem]` gives the operation's documented body; `var f tsurara.AnyFailure` reads the failure of any operation, with `f.Info()` (`Kind`, `Status`, `Documented`, `Headers`, `Cause`, `Operation`).
- OperationDefs are the JSON of `spec/operation-def.schema.json`, embedded as a string and parsed once (`sync.OnceValue`).
- `tsurara_gen.go` records the runtime version the code needs (`// Requires github.com/tsurara-openapi/tsurara/runtimes/go v0.1.0`); `tsurara check` compares it with the requirement in the nearest `go.mod` (the same minor version), and only reports a module that a `replace` directive points elsewhere.
- Arguments are lower camel case (`petID`); names that Go reserves or the function uses (`type`, `string`, `ctx`, `opts`) are numbered (`type2`). Options fields are exported like struct fields.

## Options

```yaml
language: go
go:
  package: petstore                              # default: the output directory's name
  runtimeModule: github.com/tsurara-openapi/tsurara/runtimes/go
  typeMappings:                                  # per format
    date-time: { type: time.Time, import: { from: time } }
  overrides:                                     # per JSON Pointer
    "#/components/schemas/Id": int64
```

## Types without the client

With `operations: false` the package has only the declarations: no operation files, nothing that imports `net/http` or `context`. The runtime stays one package; generated types use only its union helpers (`types.go`, `value.go`), and the linker leaves out the client when nothing calls it. The types are plain `encoding/json` types:

```go
var pet petstore.Pet
err := json.Unmarshal([]byte(`{"id":1,"name":"Pochi"}`), &pet)
```

## Mocks

With `go.mocks: true`, `mocks_gen.go` is in the generated package with the build tag `tsurara_mocks`, so production builds leave it out and tests run with `go test -tags tsurara_mocks`:

- `Mock{Type}()` decodes the sample value of each declaration.
- Per operation, a constructor per documented status (`ShowPetByIDMock200(body Pet)`, `ShowPetByIDMockDefault(status int, body Error)`) and `ShowPetByIDRoute(respond)` for `tsuraratest` (nil: the first documented success); `MockRoutes()` lists every operation.

Its names are claimed after every other name of the package, so turning mocks on never renames generated code.

## Using it

Generate into a directory of your module (`output: internal/petstore`), require the runtime (`go get github.com/tsurara-openapi/tsurara/runtimes/go`), and call the functions:

```go
c := tsurara.NewClient("https://petstore3.swagger.io/api/v3")
pets, err := petstore.FindPetsByStatus(ctx, c, petstore.FindPetsByStatusStatusAvailable, nil)
if err != nil {
	return err
}
for _, pet := range pets.Data {
	fmt.Println(pet.Name)
}
```
