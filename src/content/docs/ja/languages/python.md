---
title: "Python"
sourcePath: docs/languages/python.md
sourceHash: 5b0949ae2dbb
---

Pythonバックエンド（`language: python`、クレート `tsurara-lang-python`）は、dataclass、enum、型エイリアスを生成し、JSONを汎用的に変換するランタイム向けのTypeDefを付けます（design.md 18.7）。生成コードはランタイム `tsurara-client`（`runtimes/python`）を使います。ランタイムはhttpxの上の同期と非同期のクライアント、Result、TypeDefのコーデックを持ち、`spec/` の適合性テストのベクターを通ります。操作ごとに呼び出し関数が1つ生成されます。

生成コードはPython 3.11以降を必要とし（design.md 18.15、Q2）、Python 3.11としてpyrightで検査しています。

## クイックスタート {#quick-start}

生成器をインストールし（`npm install --save-dev tsurara`、または[GitHubリリース](https://github.com/tsurara-openapi/tsurara/releases)のバイナリ）、`tsurara.config.yaml` を書きます。

```yaml
input: https://petstore3.swagger.io/api/v3/openapi.json
output: api
language: python
```

```sh
tsurara generate
pip install "tsurara-client[http]"     # ランタイム（httpx付き）
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

## 能力 {#capabilities}

`tsurara_lang_python::CAPABILITIES`（design.md 18.5.2）：

| 能力 | 値 | 補足 |
|---|---|---|
| `inline_records` | no | インラインのオブジェクトは、置かれた場所にちなんだ名前のdataclassになります（`PetOwner`） |
| `structural_unions` | yes | `A \| B` |
| `tagged_unions` | yes | unionのエイリアスとして書きます。タグはTypeDefにあります |
| `intersections` | no | `allOf` はdataclassになります。参照が1つなら基底クラス、それ以外はフィールドをコピーします |
| `inheritance` | single | dataclassの継承 |
| `literal_types` | yes | `Literal["cat"]` |
| `enums` | any | `Enum` クラス |
| `tuples` | yes | 許される長さごとに1つの `tuple[...]` |
| `strict_decoding` | yes | `strictEnums` でなければ、値を受け取る箇所のenumと判別子は開いています |
| `nullable_primitives` | yes | `X \| None` |
| `recursion_by_value` | yes | |

## 対応表 {#mapping}

| モデル | Python |
|---|---|
| オブジェクト | `@dataclass(kw_only=True)` のクラス。`kw_only` により、継承をまたいでも、デフォルト値のあるフィールドのあとに必須のフィールドを置けます |
| 必須のプロパティ | `name: T` |
| 省略可能なプロパティ | `name: T \| None = None` |
| nullを許すプロパティ | `name: T \| None` |
| 省略可能かつnullを許す | `name: T \| None \| Missing = MISSING`（`_support.py`）。値がないことと `null` を区別するのはここだけです（Q3） |
| `additionalProperties` | `additional_properties: dict[str, T] = field(default_factory=dict)` |
| enum | `class Status(Enum)`。メンバーの名前は値から作ります（`IT_S`、`VALUE_1`）。定義に `x-enum-varnames` か `x-enumNames` があれば、そこから作ります。値を受け取る箇所では、型注釈は `Status \| str`（または `\| int`）です |
| 開いたタグ付きunion | 値を受け取る箇所では `Cat \| Dog \| dict[str, Any]`。挙がっていない判別子の値なら、JSONオブジェクトのまま保持します |
| `additionalProperties` だけのオブジェクト | `dict[str, T]` |
| `oneOf`、`anyOf`、型の配列 | `Name: TypeAlias = "A \| B"` |
| `integer`、`number`、`string`、`boolean` | `int`、`float`、`str`、`bool`。`format` はTypeDefに残ります（日付はランタイムが変換するまで `str` のままです） |
| 配列、マップ | `list[T]`、`dict[str, T]` |
| `prefixItems` | `tuple[A] \| tuple[A, B] \| tuple[A, B, *tuple[R, ...]]` |
| バイナリ | `bytes \| File`（ランタイムの `File` はファイル名とメディアタイプを持ちます）。バイナリのレスポンスは `bytes` です |
| `x-tsurara-type` / 型マッピング | `python` のエントリ。なければスキーマの型になり、`unmapped-type` の警告が出ます |

### 近似 {#approximations}

| 構造 | 近似 |
|---|---|
| オブジェクトでないメンバーを含む `allOf` | メンバーを1つだけ残し、警告を出します（design.md 18.5.3、pass 2） |
| 複数の参照を含む `allOf` | フィールドをコピーします。dataclassはそれらを継承しません |
| 文字列と数値の制約、`oneOf` の排他性 | TypeScriptと同じく、型では検査しません |
| 判別子付きのunion | unionのエイリアスはどのメンバーも受け入れます。TypeDefがタグでメンバーを選びます |

## レイアウトと命名 {#layout-and-naming}

宣言ごとに1つのモジュール（`pet.py`、`pet_owner.py`）、すべてのクラスを再exportする `__init__.py`、`TYPE_DEFS` と `CODEC`（このパッケージのクラスを使うTypeDef）を持つ `_typedefs.py`、そして `_support.py` を出力します。モジュールは `from __future__ import annotations` で始まり、型注釈で使うクラスは `if TYPE_CHECKING:` の中でimportします。実行時にimportするのは基底クラスだけなので、再帰する型や相互に参照する型がimportの循環を起こすことはありません。型エイリアスが文字列なのも同じ理由です。

クラスはPascalCaseです（識別子として使えるコンポーネント名はそのまま使います）。メンバーはクラスごとにsnake_caseで、キーワードとソフトキーワードには `_` を付けます（`class_`、`type_`）。JSONのキーと名前が異なるメンバーには `# JSON: "..."` というコメントが付き、TypeDefにキーが記録されます。生成されたモジュール自身が使う名前（`Any`、`Enum`、`File`、`Missing` など）には `Model` を付けます。モジュール名はsnake_caseで、大文字小文字を区別せずに一意にします。

## 呼び出し関数 {#call-functions}

`operations/` には操作ごとに1つのモジュールがあり、関数名にちなんだ名前を持ちます（`operations/get_pet_by_id.py`）。`operations/__init__.py` は関数とそのResultの型を再exportします。各モジュールは、OperationDefを `DEF`（ランタイム向けのTypeDefの参照付き）として持ち、Resultの型と関数を持ちます。

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

- パラメーターは `client` のあとのキーワード専用引数で、snake_caseです。省略可能なパラメーターのデフォルトは `None` で、送信しないことを意味します。関数自身が持つ引数と同じ名前のパラメーター（`body`、`timeout` など）には番号が付き（`body2`）、キーワードには `_` が付きます（`class_`）。
- `body` はリクエストの本文です（省略可能なら、デフォルトは `None`）。メディアタイプが複数あれば、`content_type`（`Literal[...]`）で選びます。デフォルトは最初のものです。
- `timeout`（秒）と `context`（フックに渡されます）は呼び出しごとに指定します。
- `AsyncClient` を渡すと、同じ関数がawaitableを返します（`@overload`）。
- Resultの型は `Success[...] | HttpError[...] | UndocumentedStatus | TransportFailure` です。定義にあるステータスとメディアタイプごとの成功時のデータ（内容がなければ `None`）と、定義にあるエラーの本文を表します。ほかに成功のレスポンスが定義されているときは、`default` はエラーとして扱います。
- 項目のスキーマ（`itemSchema`、または3.2より前の `x-itemSchema`。design.md 8.5）を持つServer-Sent Events、JSON Lines、JSON text sequencesは、項目ごとに読みます。成功時のデータは、`Client` では `Iterator[StreamEvent]`、`AsyncClient` では `AsyncIterator[StreamEvent]` です。そのためこうした操作には2つ目のResultの型 `{Operation}AsyncResult` があります。イベントは `event` でタグ付けされたunionのdataclass（`StreamNoteEvent`。`data` はその `contentSchema` としてデコードされます）です。定義に挙がっていないイベントはdictとして届きます。JSON Linesの項目は、項目のスキーマの型です（インラインなら `{Operation}Item`）。
- 生成コードは `tsurara-client>=0.1,<0.2` を必要とし、`operations/__init__.py` にそう書かれています。`tsurara check` は、インストール済みのPythonのランタイムをまだ検査しません。

## クライアントなしで型だけを使う {#types-without-the-client}

`operations: false` では `operations` パッケージがなくなり、出力は `http` のextrasなしの `tsurara-client` だけを必要とします。`import tsurara_client` とTypeDefのコーデックは標準ライブラリだけを使います。JSONのデコードには生成されたコーデックを使います。

```python
from api import Pet
from api._typedefs import CODEC

pet = CODEC.decode({"ref": "Pet"}, {"id": 1, "name": "Pochi"})
assert isinstance(pet, Pet)
CODEC.encode({"ref": "Pet"}, pet)  # {"id": 1, "name": "Pochi"}
```

呼び出し関数はクライアントをimportし、クライアントにはhttpxが必要です。`tsurara-client[http]` をインストールしてください（生成される `operations/__init__.py` にもそう書かれています）。httpxなしで `Client` をimportすると、その旨を伝える `ImportError` が発生します。

## モック {#mocks}

`python.mocks: true` にすると、サブパッケージ `mocks` に、TypeScriptのモック（design.md 8.9）と同じ値が、同じサンプル（18.7.1）から作られます。

- `mocks/schemas.py`：`mock_pet(**overrides) -> Pet` は、パッケージのTypeDefでサンプルをデコードします。dataclassではフィールドを上書きできます（`dataclasses.replace`）。
- `mocks/operations.py`：操作ごとに、定義にあるステータスごとのコンストラクター（`show_pet_by_id_200(body: Pet)`、`show_pet_by_id_default(status, body)`）と、`MockRouter` 向けのルート `show_pet_by_id_route(response=None)` があります。ルートはデフォルトで、定義にある最初の成功レスポンスで応答します。`routes()` はすべての操作を並べます。

```python
router = MockRouter(base_path="/v1")
router.extend(routes())
client = Client("https://api.test/v1", http=httpx.Client(transport=httpx.MockTransport(router)))
```

## オプション {#options}

```yaml
language: python
python:
  strictEnums: false   # true: 値を受け取る箇所で、定義にない enum と判別子の値をエラーにする
```
