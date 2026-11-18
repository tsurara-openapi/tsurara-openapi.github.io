---
title: "Python"
sourcePath: docs/languages/python.md
sourceHash: 4b9a4fa99df1
---

Python 后端（`language: python`，crate `tsurara-lang-python`）生成 dataclass、枚举和类型别名，并为以通用方式转换 JSON 的运行时附带 TypeDef（design.md 18.7）。生成的代码使用运行时 `tsurara-client`（`runtimes/python`）：基于 httpx 的同步和异步客户端、Result，以及 TypeDef 编解码器；它通过了 `spec/` 中的一致性测试向量。每个操作都会生成一个调用函数。

生成的代码需要 Python 3.11 或更高版本（design.md 18.16，Q2），并以 Python 3.11 为目标用 pyright 检查。

## 快速开始 {#quick-start}

安装生成器（`npm install --save-dev tsurara`，或 [GitHub releases](https://github.com/tsurara-openapi/tsurara/releases) 中的二进制文件），然后编写 `tsurara.config.yaml`：

```yaml
input: https://petstore3.swagger.io/api/v3/openapi.json
output: api
language: python
```

```sh
tsurara generate
pip install "tsurara-client[http]"     # 运行时，附带 httpx
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

| 能力 | 值 | 说明 |
|---|---|---|
| `inline_records` | no | 内联对象变为以其所在位置命名的 dataclass（`PetOwner`） |
| `structural_unions` | yes | `A \| B` |
| `tagged_unions` | yes | 写成联合类型别名；标签在 TypeDef 中 |
| `intersections` | no | `allOf` 变为一个 dataclass：只有一个引用时作为基类，否则复制字段 |
| `inheritance` | single | dataclass 继承 |
| `literal_types` | yes | `Literal["cat"]` |
| `enums` | any | `Enum` 类 |
| `tuples` | yes | 每种允许的长度对应一个 `tuple[...]` |
| `strict_decoding` | yes | 除非设置 `strictEnums`，在接收值的位置枚举和判别字段是开放的 |
| `nullable_primitives` | yes | `X \| None` |
| `recursion_by_value` | yes | |

## 映射 {#mapping}

| 模型 | Python |
|---|---|
| 对象 | `@dataclass(kw_only=True)` 类；`kw_only` 使必需字段可以排在有默认值的字段之后，继承时也是如此 |
| 必需属性 | `name: T` |
| 可选属性 | `name: T \| None = None` |
| 可空属性 | `name: T \| None` |
| 可选且可空 | `name: T \| None \| Missing = MISSING`（`_support.py`）；只有这里区分“缺失”和 `null`（Q3） |
| `additionalProperties` | `additional_properties: dict[str, T] = field(default_factory=dict)` |
| 枚举 | `class Status(Enum)`，成员名由值生成（`IT_S`、`VALUE_1`）；在接收值的位置，类型注解为 `Status \| str`（或 `\| int`） |
| 开放的带标签联合类型 | 在接收值的位置为 `Cat \| Dog \| dict[str, Any]`：未列出的判别值会保留 JSON 对象 |
| 只有 `additionalProperties` 的对象 | `dict[str, T]` |
| `oneOf`、`anyOf`、类型数组 | `Name: TypeAlias = "A \| B"` |
| `integer`、`number`、`string`、`boolean` | `int`、`float`、`str`、`bool`；`format` 保留在 TypeDef 中（日期在运行时转换之前保持为 `str`） |
| 数组、映射 | `list[T]`、`dict[str, T]` |
| `prefixItems` | `tuple[A] \| tuple[A, B] \| tuple[A, B, *tuple[R, ...]]` |
| 二进制 | `bytes \| File`（运行时的 `File` 附带文件名和媒体类型）；二进制响应为 `bytes` |
| `x-tsurara-type` / 类型映射 | 其中的 `python` 条目；没有时使用 schema 的类型，并给出 `unmapped-type` 警告 |

### 近似 {#approximations}

| 结构 | 近似方式 |
|---|---|
| 含有非对象成员的 `allOf` | 只保留一个成员，并给出警告（design.md 18.5.3，pass 2） |
| 含有多个引用的 `allOf` | 复制字段；dataclass 不继承它们 |
| 字符串和数字约束、`oneOf` 的互斥性 | 与 TypeScript 一样，类型不做检查 |
| 带判别字段的联合类型 | 联合类型别名接受任何成员；由 TypeDef 根据标签选择 |

## 布局与命名 {#layout-and-naming}

每个声明一个模块（`pet.py`、`pet_owner.py`），一个重新导出所有类的 `__init__.py`，一个包含 `TYPE_DEFS` 和 `CODEC`（使用本包类的 TypeDef）的 `_typedefs.py`，以及 `_support.py`。模块以 `from __future__ import annotations` 开头，并在 `if TYPE_CHECKING:` 下导入类型注解所用的类；运行时只导入基类，因此递归和相互引用的类型永远不会形成导入循环。类型别名写成字符串也是出于同样的原因。

类名使用 PascalCase（可作为标识符的组件名保持不变），成员在每个类中使用 snake_case，关键字和软关键字加 `_`（`class_`、`type_`）；JSON 键与名称不同的成员会带有 `# JSON: "..."` 注释，TypeDef 会记录该键。生成的模块自身使用的名称（`Any`、`Enum`、`File`、`Missing` 等）会加上 `Model`。模块名使用 snake_case，并在忽略大小写时保持唯一。

## 调用函数 {#call-functions}

`operations/` 中每个操作一个模块，以其函数命名（`operations/get_pet_by_id.py`），`operations/__init__.py` 重新导出这些函数及其 Result 类型。每个模块包含作为 `DEF` 的 OperationDef（带有供运行时使用的 TypeDef 引用）、Result 类型和函数：

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

- 参数是位于 `client` 之后的仅限关键字参数，使用 snake_case。可选参数默认为 `None`，表示不发送。与函数自身参数同名的参数（`body`、`timeout` 等）会加上编号（`body2`），关键字会加上 `_`（`class_`）。
- `body` 是请求体（可选时默认为 `None`）；有多种媒体类型时，用 `content_type`（`Literal[...]`）选择其一，默认为第一个。
- `timeout`（秒）和 `context`（传给钩子）按调用指定。
- 使用 `AsyncClient` 时，同一个函数返回 awaitable（`@overload`）。
- Result 类型为 `Success[...] | HttpError[...] | UndocumentedStatus | TransportFailure`：按定义中声明的状态码和媒体类型给出成功数据（无内容时为 `None`），以及定义中声明的错误响应体。当定义了其他成功响应时，`default` 视为错误。
- 带有条目 schema（`itemSchema`，或 3.2 之前的 `x-itemSchema`；design.md 8.5）的 Server-Sent Events、JSON Lines 和 JSON text sequences 会逐条读取：使用 `Client` 时成功数据为 `Iterator[StreamEvent]`，使用 `AsyncClient` 时为 `AsyncIterator[StreamEvent]`，因此这类操作有第二个 Result 类型 `{Operation}AsyncResult`。事件是以 `event` 为标签的联合类型中的 dataclass（`StreamNoteEvent`，其 `data` 按 `contentSchema` 解码）；定义中未列出的事件以 dict 形式到达。JSON Lines 的条目是其条目 schema 的类型（内联时为 `{Operation}Item`）。
- 生成的代码需要 `tsurara-client>=0.1,<0.2`；`operations/__init__.py` 中写明了这一点。`tsurara check` 目前还不检查已安装的 Python 运行时。

## 不使用客户端的类型 {#types-without-the-client}

使用 `operations: false` 时没有 `operations` 包，输出只需要不带 `http` extra 的 `tsurara-client`：`import tsurara_client` 和 TypeDef 编解码器只使用标准库。用生成的编解码器解码 JSON：

```python
from api import Pet
from api._typedefs import CODEC

pet = CODEC.decode({"ref": "Pet"}, {"id": 1, "name": "Pochi"})
assert isinstance(pet, Pet)
CODEC.encode({"ref": "Pet"}, pet)  # {"id": 1, "name": "Pochi"}
```

调用函数会导入客户端，而客户端需要 httpx：请安装 `tsurara-client[http]`（生成的 `operations/__init__.py` 中写明了它）。在没有 httpx 的情况下导入 `Client` 会抛出说明原因的 `ImportError`。

## Mock {#mocks}

使用 `python.mocks: true` 时，子包 `mocks` 中包含与 TypeScript Mock（design.md 8.9）相同的值，由相同的示例（18.7.1）构建：

- `mocks/schemas.py`：`mock_pet(**overrides) -> Pet` 用包的 TypeDef 解码示例；dataclass 可以覆盖字段（`dataclasses.replace`）。
- `mocks/operations.py`：每个操作都有按定义中声明的状态码划分的构造函数（`show_pet_by_id_200(body: Pet)`、`show_pet_by_id_default(status, body)`），以及 `show_pet_by_id_route(response=None)`，即 `MockRouter` 的路由，默认用定义中第一个成功响应作答；`routes()` 列出所有操作。

```python
router = MockRouter(base_path="/v1")
router.extend(routes())
client = Client("https://api.test/v1", http=httpx.Client(transport=httpx.MockTransport(router)))
```

## 选项 {#options}

```yaml
language: python
python:
  strictEnums: false   # true：在接收值的位置，未列出的枚举值和判别值视为错误
```
