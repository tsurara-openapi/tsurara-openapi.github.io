---
title: "Python"
sourcePath: docs/languages/python.md
sourceHash: 4b9a4fa99df1
---

The Python backend (`language: python`, crate `tsurara-lang-python`) generates dataclasses, enums and type aliases, with TypeDefs for a runtime that converts JSON generically (design.md 18.7). Generated code uses the runtime `tsurara-client` (`runtimes/python`): sync and async clients over httpx, Results, and the TypeDef codec; it passes the conformance vectors in `spec/`. Each operation gets a call function.

Generated code requires Python 3.11 or later (design.md 18.16, Q2) and is checked with pyright as Python 3.11.

## Quick start

Install the generator (`npm install --save-dev tsurara`, or a binary from the [GitHub releases](https://github.com/tsurara-openapi/tsurara/releases)), then write `tsurara.config.yaml`:

```yaml
input: https://petstore3.swagger.io/api/v3/openapi.json
output: api
language: python
```

```sh
tsurara generate
pip install "tsurara-client[http]"     # the runtime, with httpx
```

```python
from tsurara_client import Client, Success, unwrap
from api import PetStatus
from api.operations import find_pets_by_status, get_pet_by_id

with Client("https://petstore3.swagger.io/api/v3") as client:
    pets = unwrap(find_pets_by_status(client, status=PetStatus.AVAILABLE))
    match get_pet_by_id(client, pet_id=1):
        case Success(data=pet):
            print(pet.name)
```

## Capabilities

`tsurara_lang_python::CAPABILITIES` (design.md 18.5.2):

| Capability | Value | Notes |
|---|---|---|
| `inline_records` | no | Inline objects become dataclasses named after their place (`PetOwner`) |
| `structural_unions` | yes | `A \| B` |
| `tagged_unions` | yes | Written as a union alias; the tag is in the TypeDef |
| `intersections` | no | `allOf` becomes a dataclass: a base class for one reference, copied fields otherwise |
| `inheritance` | single | Dataclass inheritance |
| `literal_types` | yes | `Literal["cat"]` |
| `enums` | any | `Enum` classes |
| `tuples` | yes | One `tuple[...]` per allowed length |
| `strict_decoding` | yes | Enums and discriminators are open where values are received, unless `strictEnums` |
| `nullable_primitives` | yes | `X \| None` |
| `recursion_by_value` | yes | |

## Mapping

| Model | Python |
|---|---|
| Object | `@dataclass(kw_only=True)` class; `kw_only` lets required fields follow defaulted ones, also through inheritance |
| Required property | `name: T` |
| Optional property | `name: T \| None = None` |
| Nullable property | `name: T \| None` |
| Optional and nullable | `name: T \| None \| Missing = MISSING` (`_support.py`); missing and `null` differ only here (Q3) |
| `additionalProperties` | `additional_properties: dict[str, T] = field(default_factory=dict)` |
| Enum | `class Status(Enum)` with members named from the values (`IT_S`, `VALUE_1`); at a received site the annotation is `Status \| str` (or `\| int`) |
| Open tagged union | At a received site, `Cat \| Dog \| dict[str, Any]`: an unlisted discriminator keeps the JSON object |
| Object with only `additionalProperties` | `dict[str, T]` |
| `oneOf`, `anyOf`, type arrays | `Name: TypeAlias = "A \| B"` |
| `integer`, `number`, `string`, `boolean` | `int`, `float`, `str`, `bool`; `format` is kept in the TypeDefs (dates stay `str` until the runtime converts them) |
| Array, map | `list[T]`, `dict[str, T]` |
| `prefixItems` | `tuple[A] \| tuple[A, B] \| tuple[A, B, *tuple[R, ...]]` |
| Binary | `bytes \| File` (`File` from the runtime adds a file name and a media type); binary responses are `bytes` |
| `x-tsurara-type` / type mappings | The `python` entry; without one, the schema's type and an `unmapped-type` warning |

### Approximations

| Construct | Approximation |
|---|---|
| `allOf` with a member that is not an object | One member is kept, with a warning (design.md 18.5.3, pass 2) |
| `allOf` with several references | Fields are copied; the dataclass does not inherit from them |
| String and number constraints, `oneOf` exclusivity | Not checked by the types, as in TypeScript |
| Discriminated unions | The union alias accepts any member; the TypeDef selects by the tag |

## Layout and naming

One module per declaration (`pet.py`, `pet_owner.py`), `__init__.py` re-exporting every class, `_typedefs.py` with `TYPE_DEFS` and `CODEC` (the TypeDefs with this package's classes), and `_support.py`. Modules start with `from __future__ import annotations` and import the classes their annotations use under `if TYPE_CHECKING:`; only a base class is imported at run time, so recursive and mutually referencing types never form import cycles. Type aliases are strings for the same reason.

Classes are PascalCase (component names that are identifiers are kept), members snake_case per class, with keywords and soft keywords getting `_` (`class_`, `type_`); a member whose JSON key differs gets a `# JSON: "..."` comment, and the TypeDef records the key. Names that generated modules use themselves (`Any`, `Enum`, `File`, `Missing`, ...) get `Model`. Modules are snake_case and case-folded.

## Call functions

`operations/` has one module per operation, named after its function (`operations/get_pet_by_id.py`), and `operations/__init__.py` re-exports the functions and their Result types. Each module has the OperationDef as `DEF` (with TypeDef references for the runtime), the Result type, and the function:

```python
from api import PetStatus
from api.operations import get_pet_by_id, find_pets_by_status
from tsurara_client import Client, Success, unwrap

with Client("https://petstore3.swagger.io/api/v3") as client:
    match get_pet_by_id(client, pet_id=1):
        case Success(data=pet):
            print(pet.name)
    pets = unwrap(find_pets_by_status(client, status=PetStatus.AVAILABLE))
```

- Parameters are keyword-only, snake_case, after `client`. Optional parameters default to `None`, which means not sent. A parameter named like an argument the function has itself (`body`, `timeout`, ...) gets a number (`body2`), and keywords get `_` (`class_`).
- `body` is the request body (`None` by default when optional); with several media types, `content_type` picks one (`Literal[...]`), the first by default.
- `timeout` (seconds) and `context` (passed to hooks) are per call.
- With `AsyncClient` the same function returns an awaitable (`@overload`).
- The Result type is `Success[...] | HttpError[...] | UndocumentedStatus | TransportFailure`: the success data per documented status and media type (`None` without content), and the documented error bodies. `default` is an error when other successes are documented.
- Server-Sent Events, JSON Lines and JSON text sequences with an item schema (`itemSchema`, or `x-itemSchema` before 3.2; design.md 8.5) are read item by item: the success data is `Iterator[StreamEvent]` with `Client` and `AsyncIterator[StreamEvent]` with `AsyncClient`, so such an operation has a second Result type, `{Operation}AsyncResult`. Events are dataclasses of a union tagged by `event` (`StreamNoteEvent`, with `data` decoded as its `contentSchema`); events the definition does not list arrive as dicts. Items of JSON Lines are their item schema's type (`{Operation}Item` when it is inline).
- Generated code needs `tsurara-client>=0.1,<0.2`; `operations/__init__.py` says so. `tsurara check` does not check the installed Python runtime yet.

## Types without the client

With `operations: false` there is no `operations` package, and the output needs `tsurara-client` without the `http` extra: `import tsurara_client` and the TypeDef codec use only the standard library. Decode JSON with the generated codec:

```python
from api import Pet
from api._typedefs import CODEC

pet = CODEC.decode({"ref": "Pet"}, {"id": 1, "name": "Pochi"})
assert isinstance(pet, Pet)
CODEC.encode({"ref": "Pet"}, pet)  # {"id": 1, "name": "Pochi"}
```

Call functions import the client, which needs httpx: install `tsurara-client[http]` (the generated `operations/__init__.py` names it). Importing `Client` without httpx raises an `ImportError` that says so.

## Mocks

With `python.mocks: true`, the subpackage `mocks` has the values of the TypeScript mocks (design.md 8.9), built from the same samples (18.7.1):

- `mocks/schemas.py`: `mock_pet(**overrides) -> Pet` decodes the sample with the package's TypeDefs; dataclasses take field overrides (`dataclasses.replace`).
- `mocks/operations.py`: per operation, a constructor per documented status (`show_pet_by_id_200(body: Pet)`, `show_pet_by_id_default(status, body)`) and `show_pet_by_id_route(response=None)`, a route for `MockRouter` that answers with the first documented success by default; `routes()` lists every operation.

```python
router = MockRouter(base_path="/v1")
router.extend(routes())
client = Client("https://api.test/v1", http=httpx.Client(transport=httpx.MockTransport(router)))
```

## Options

```yaml
language: python
python:
  strictEnums: false   # true: unlisted enum and discriminator values are errors where received
```
