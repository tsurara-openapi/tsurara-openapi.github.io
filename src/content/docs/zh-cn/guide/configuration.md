---
title: "配置"
sourcePath: docs/guide/configuration.md
sourceHash: 0b600e1cef10
---

tsurara 从当前目录或最近的父目录读取 `tsurara.config.yaml`（或 `.yml`、`.json`、`.toml`），也可以用 `--config` 指定文件。npm 包 `tsurara` 中包含 `schema/tsurara.config.schema.json`，它描述了所有的键，可用于编辑器补全：

```yaml
# yaml-language-server: $schema=./node_modules/tsurara/schema/tsurara.config.schema.json
```

## 目标 {#a-target}

如果没有 `targets`，顶层就是一个目标。

```yaml
input: ./openapi.yaml            # 相对于本文件的路径，或 URL
output: ./src/generated          # 相对于本文件
language: typescript             # typescript（默认）或 python
```

| 键 | 默认值 | |
|---|---|---|
| `name` | `default` | 目标的名称，用于 `tsurara generate --target`。有多个目标时必填 |
| `input` | 必填 | 定义：相对于本文件的路径，或 URL。也可以是对象：`url`，以及只发送到该 URL 源（origin）的 `headers`（`Authorization: "Bearer ${TOKEN}"`） |
| `output` | 必填 | 输出目录。tsurara 只写入有变化的文件，并删除以其生成文件标记开头的过时文件 |
| `language` | `typescript` | `typescript`、`python`、`rust`（实验性）、`go`（实验性），或一个后端程序：`{ command: [program, args...], options: {...} }` |
| `filter` | | `tags` 和 `operationIds`：只生成这些操作。`excludeTags` 和 `excludeOperationIds`：生成除这些以外的操作，也会从已包含的操作中排除。使用其中任何一个时，只输出剩余操作所用到的 schema，并且不输出 webhook |
| `naming.overrides` | | 按 JSON Pointer 指定的首选名称，对所有语言生效：`"#/components/schemas/Error": ApiError`。各语言的命名规则仍然适用 |
| `splitVisibility` | `true` | 为带有 `readOnly`/`writeOnly` 的 schema 输出 `XWritable` 类型（TypeScript）：响应使用普通类型，请求使用可写类型 |
| `wildcardAsJson` | `false` | 将通配媒体类型（`*/*`、`application/*`）视为 JSON，适用于只返回 JSON 的 API。默认按实际的 Content-Type 解析 |
| `operations` | `true` | 生成操作。设为 `false` 时，只输出 schema、webhook 和 channel 的类型，输出只需要运行时的类型层（不需要 HTTP 客户端；参见[不使用客户端的类型](../types/#types-without-the-client)） |
| `runtime` | `package` | 生成的代码从哪里找到运行时：`package`（`@tsurara/client`、`tsurara-client` 等），或 `vendor`，即把运行时的副本写入输出目录（参见[内置运行时](../client/#a-vendored-runtime)） |
| `hooks` | | 在生成的各个阶段运行的命令（见下文） |
| `typescript` | | TypeScript 后端的选项（见下文）；仅在 `language: typescript` 时可用 |
| `python` | | Python 后端的选项（见下文）；仅在 `language: python` 时可用 |
| `rust` | | Rust 后端的选项（见下文）；仅在 `language: rust` 时可用 |
| `go` | | Go 后端的选项（见下文）；仅在 `language: go` 时可用 |
| `extends` | | 一个文件或文件列表：其中的设置作为本文件的默认值（见下文） |

写入其他语言的部分（例如在 `language: typescript` 时写 `python:`）会报错。

## TypeScript 选项 {#typescript-options}

```yaml
typescript:
  importExtension: ts
  layout: split
  enumStyle: union
  bodilessResponses: discard
  typeMappings:
    uuid: { type: "Brand<'Uuid'>", import: { from: ./brand.ts, name: Brand } }
  overrides:
    "#/components/schemas/Id": string
  naming:
    schemaCase: preserve
    functionCase: preserve
    typePrefix: Api
    enumKeyCase: preserve
    overrides:
      "#/components/schemas/Error": ApiErrorBody
```

| 键 | 默认值 | |
|---|---|---|
| `importExtension` | `js` | 生成代码中相对导入的扩展名：`js`（用于 `tsc` 构建和打包工具）、`ts`（用 Node 的类型剥离运行；使用方需要 `allowImportingTsExtensions` 或 `rewriteRelativeImportExtensions`），或 `none`（Metro 和部分打包工具） |
| `layout` | `split` | `split`：每个操作（`operations/getPet.ts`）和每个 schema（`schemas/Pet.ts`）各一个文件；`tags`：每个标签一个文件；`single`：单个文件 |
| `enumStyle` | `union` | `union`：字符串字面量联合类型；`const`：同时输出一个以值为键的对象（`Status.available`），类型由该对象推导 |
| `bodilessResponses` | `discard` | 定义中没有内容的错误响应（4xx、5xx，以及与成功状态码并列的 `default`）的响应体如何处理：`discard` 丢弃它，错误为 `undefined`；`read` 读取带有 Content-Type 到达的响应体（与 `auto` 相同），错误为 `unknown`。不适用于 `HEAD` |
| `aggregateMaps` | `false` | 同时输出 `paths.ts` 和 `operations.ts`，即包含所有操作的映射，供通用客户端使用 |
| `clientModule` | `@tsurara/client` | 生成的代码从该模块导入运行时 |
| `mocks` | | `msw` 或 `fetch`：同时在 `mocks/` 下输出 Mock 工厂函数（`mockPet()`，来自定义中的示例值）和每个操作的请求处理器，形式为 MSW 处理器或 `@tsurara/client/testing` 中 `mockFetch` 的路由（[Mock](../mocks/)）。其他文件不会导入它们；不使用该选项时，任何文件都不会提及 `msw` |
| `query` | | `tanstack`：同时在 `query/` 下输出 TanStack Query 5 的选项：每个读取操作（`GET`、`HEAD`、`QUERY`）有一个带类型的查询键工厂函数和查询选项，其他操作有 mutation 选项（[客户端](../client/#tanstack-query)）。其他文件不会导入它们；不使用该选项时，任何文件都不会提及 `@tanstack` |
| `infiniteQueries` | | 按操作 ID 指定的分页设置，用于无限查询选项（需 `query: tanstack`）：`param`（携带页码的参数，`query.cursor`）、`initial`（第一页；默认不发送）、`next` 和 `previous`（指向成功响应体的 JSON Pointer，`/nextCursor`；值不存在或为 `null` 时查询结束；没有 `next` 时由应用提供 `getNextPageParam`）。优先于定义中操作上的 `x-tsurara-pagination`（字段相同）。 |
| `validators` | | `zod`：同时在 `zod/` 下输出 Zod 4 schema，并输出包含 `responseSchemas` 的 `zod/operations.ts`，用于通过 `validateResponses` 校验响应（[客户端](../client/#validation)）。不使用该选项时，任何文件都不会提及 `zod` |
| `validatorConstraints` | `false` | 在 `validators: zod` 时，同时检查定义中的约束（`minLength`、`maxLength`、`pattern`、`minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`、`multipleOf`、`minItems`、`maxItems`、`uniqueItems`、`minProperties`、`maxProperties`）以及格式 `uri`、`ipv4`、`ipv6`、`date`、`time` 和 `duration`。默认关闭：否则响应校验会拒绝违反这些约束的值。不是 JavaScript 正则表达式的 `pattern` 会被省略，并给出警告 |
| `typeMappings` | | 每个 `format`（`uuid`、`date` 等）对应的类型：一个类型表达式，或 `{ type, import: { from, name } }`。`from` 中以 `.` 开头的路径相对于本文件。映射不能改变 JSON 解析的结果：为 `date-time` 指定 `Date`、为 `int64` 指定 `bigint` 都会报错 |
| `overrides` | | 按 JSON Pointer 指定的类型，写法与 `typeMappings` 相同 |
| `naming.schemaCase` | `preserve` | `preserve` 保留可作为标识符的组件名；`pascal` 将所有类型名转换为 PascalCase |
| `naming.typePrefix` | | 加在 schema 类型名之前：`Api` 会得到 `ApiPet`（以及 `ApiPetWritable`）。从操作派生的类型（`GetPetResult`）和由 `naming.overrides` 固定的名称保持不变 |
| `naming.enumKeyCase` | `preserve` | `enumStyle: const` 对象的键：`preserve` 原样写出成员名（`x-enum-varnames`、`x-enumNames`）或值；`constant` 得到 `PAYMENT_PENDING`，`pascal` 得到 `PaymentPending`，`camel` 得到 `paymentPending`。变得相同的键会编号（`A_B`、`A_B_2`） |
| `naming.functionCase` | `preserve` | `preserve` 将可作为标识符的操作 ID 直接用作函数名（`ListPets`、`get_pet`）；`camel` 将所有函数名转换为 camelCase（`listPets`、`getPet`） |
| `naming.overrides` | | 按 JSON Pointer 指定的最终 TypeScript 标识符，原样使用 |

`typeMappings`、`overrides` 和 `x-tsurara-type` 中的类型必须是类型表达式（名称、类型参数、数组、`|`、`&`、字面量）；其他内容在配置中会报错，在定义中会被忽略并给出警告。

## Python 选项 {#python-options}

| 键 | 默认值 | |
|---|---|---|
| `strictEnums` | `false` | 枚举和判别字段拒绝定义中未列出的值。默认情况下，在接收值的位置会保留这些值（`Status | str`） |
| `mocks` | `false` | 同时输出 `mocks/`：基于示例值的 `mock_{name}()` 工厂函数，以及每个操作对应的 `tsurara_client.testing` 中 `MockRouter` 的路由（[Python](../../languages/python/#mocks)） |

## Rust 选项 {#rust-options}

Rust 后端为实验性（[docs/languages/rust.md](../../languages/rust/)）。

| 键 | 默认值 | |
|---|---|---|
| `runtimeCrate` | `tsurara_client` | 生成的代码引用运行时 crate 时使用的路径。在 `runtime: vendor` 时必填：即生成在你的 crate 中的模块 `runtime` 的路径（`crate::api::runtime`） |
| `mocks` | `false` | 同时输出模块 `mocks`（在测试时，以及启用会开启 `tsurara-client/testing` 的 crate 特性 `mocks` 时编译）：工厂函数和 `MockTransport` 的路由（[Rust](../../languages/rust/#mocks)） |
| `typeMappings` | | 每个 `format` 对应的类型，写成类型路径：`date-time: chrono::DateTime<chrono::Utc>` |
| `overrides` | | 按 JSON Pointer 指定的类型：`"#/components/schemas/Id": uuid::Uuid` |

## Go 选项 {#go-options}

Go 后端为实验性（[docs/languages/go.md](../../languages/go/)）。它会向 `output` 写入一个包。

```yaml
language: go
go:
  package: petstore
```

| 键 | 默认值 | |
|---|---|---|
| `package` | 输出目录的名称 | 生成文件的包名；取目录名转为小写并去掉其他字符（`pet-store` → `petstore`），Go 关键字后加 `api`（`go` → `goapi`），否则为 `api` |
| `runtimeModule` | `github.com/tsurara-openapi/tsurara/runtimes/go` | 运行时模块（`runtimes/go`）的导入路径。在 `runtime: vendor` 时，为输出中 `internal/tsurara` 的导入路径，根据最近的 `go.mod` 计算 |
| `mocks` | `false` | 同时输出使用构建标签 `tsurara_mocks` 的 `mocks_gen.go`：`Mock{Type}()` 工厂函数和 `tsuraratest` 的路由（[Go](../../languages/go/#mocks)） |
| `typeMappings` | | 每个 `format` 对应的类型，以及其所在包的导入路径：`date-time: { type: time.Time, import: { from: time } }` |
| `overrides` | | 按 JSON Pointer 指定的类型：`"#/components/schemas/Id": int64` |

## 多个目标 {#targets}

```yaml
extends: ../../tsurara.base.yaml
typescript:
  importExtension: ts           # 下面所有目标的默认值
targets:
  - name: public
    input: https://api.example.com/openapi.json
    output: src/generated/public
  - name: admin
    input: ./admin.yaml
    output: src/generated/admin
    filter: { tags: [users] }
```

顶层的键是 `targets` 中每一项的默认值。每个目标都需要唯一的 `name`。

## extends {#extends}

`extends` 接受一个文件或文件列表。对象会深度合并，数组和其他值会被替换；发生冲突时，以写有 extends 的文件为准。每个文件都会先单独读取和检查，因此相对路径始终相对于它所在的文件，钩子也在其文件所在的目录中运行。

## 插件 {#plugins}

```yaml
plugins:
  - ./tsurara.plugin.ts                         # 通过 @tsurara/plugin 用 Node 运行
  - { module: ./other.py, runtime: [python, -m, tsurara_plugin] }
```

每个模块在每次 `tsurara generate` 时运行一次，并参与它所声明的阶段（design.md 11.2，[插件](../plugins/#plugins-in-typescript)）。路径相对于它所在的文件。

## 环境变量 {#environment-variables}

任何字符串中的 `${VAR}` 都会被替换为对应的环境变量，这样令牌就不必写进文件。未设置的变量会报错。

## 钩子 {#hooks}

钩子和插件是 `tsurara generate`（以及面向编程智能体的 MCP 服务器的 `generate`）以你的权限运行的命令。配置文件就是代码：只使用你信任的配置进行生成，就像只运行你信任的脚本一样。钩子和插件返回的文件路径必须位于输出目录之内（相对路径，不含 `..`）；tsurara 会拒绝其他路径。

| 钩子 | 运行时机 | 输入和输出 |
|---|---|---|
| `transformDocument` | 分析之前 | 通过 stdin 接收 JSON 格式的根定义；通过 stdout 输出转换后的定义 |
| `transformModel` | 分析之后 | 通过 stdin 和 stdout 传递 JSON 格式的模型（版本由 `semVersion` 表示） |
| `extend` | 生成之后 | 通过 stdin 接收 JSON 格式的 `{ language, model, manifest, common, marker }`；通过 stdout 输出要添加的文件（`[{ path, contents }]`），每个文件都以 `marker` 开头（[插件](../plugins/)） |
| `transformFiles` | 写入之前 | 通过 stdin 和 stdout 传递 JSON 格式的输出文件（`path`、`contents`） |
| `afterWrite` | 写入之后 | 命令列表；`{output}` 会被替换为输出目录 |

```yaml
hooks:
  transformDocument: [node, scripts/patch-openapi.mjs]
  afterWrite:
    - [biome, format, --write, "{output}"]
```

钩子是列表形式的命令（`[program, args...]`）。钩子失败时，生成会停止。

## 定义中的扩展字段 {#extension-fields-in-definitions}

| 字段 | |
|---|---|
| `x-tsurara-type` | 为 schema 指定每种语言的类型：`{ typescript: "Brand<'Uuid'>", python: UUID }`，或带导入：`{ typescript: { type: Uuid, import: { from: ./ids.ts, name: Uuid } } }` |
