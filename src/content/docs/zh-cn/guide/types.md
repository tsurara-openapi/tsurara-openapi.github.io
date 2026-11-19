---
title: "类型"
sourcePath: docs/guide/types.md
sourceHash: 7a7d7e6677c5
---

本页说明 schema 如何变成 TypeScript 类型。规则是固定的，表中的每一行都是一个测试（design.md 6.4）；Python 有自己的表，见 [docs/languages/python.md](../../languages/python/)。

| Schema | TypeScript |
|---|---|
| `type: string`、`integer`、`number`、`boolean`、`null` | `string`、`number`、`number`、`boolean`、`null` |
| `format: date-time`、`uuid`、`int64` 等 | 基础类型（`string`、`number`）；格式写在 JSDoc 中。`typeMappings` 可以指定 JSON 解析结果所对应的其他类型（例如带品牌的字符串） |
| `enum` | 字面量的联合类型（`'a' \| 'b'`）；`enumStyle: const` 会额外生成一个包含这些值的对象；定义中有 `x-enum-varnames` 或 `x-enumNames` 时，用它们作为对象的键，键的写法遵循 `naming.enumKeyCase` |
| `const` | 字面量类型 |
| `nullable: true`（3.0）、`type: [string, "null"]`（3.1） | `string \| null` |
| 带 `properties` 的 `type: object` | 对象类型；不在 `required` 中的属性是可选的（`a?: T`） |
| 与属性一起出现的 `additionalProperties: { ... }` | 索引签名，其值为该 schema 与所有属性类型的联合（TypeScript 要求如此） |
| 没有属性的 `type: object` | `{ [key: string]: unknown }` |
| `additionalProperties: false` 且没有属性 | `{ [key: string]: never }` |
| `type: array`、`items` | `T[]` |
| `prefixItems` | 元组：`minItems` 以内的元素是必需的，其余是可选的，`items` 给出剩余元素的类型 |
| `oneOf`、`anyOf` | 联合类型 |
| `allOf` | 内联对象合并为一个对象类型；具名成员保留为引用，并与最多一个对象字面量求交（`Base & { extra?: string }`） |
| `discriminator` | 每个成员都与其标签（`{ petType: 'cat' }`）求交，因此 `switch (pet.petType)` 可以收窄类型。已经把该属性要求为对应 `const` 的成员不会再求交 |
| 带 `itemSchema`（3.2）或 `x-itemSchema` 的 `text/event-stream` 响应 | `AsyncIterable<StreamEvent>`，其中 `StreamEvent` 为 `{ event: 'note'; data: Note; id?: string; retry?: number } \| ...`（[Server-Sent Events](../client/#server-sent-events)） |
| 带 `itemSchema` 或 `x-itemSchema` 的 `application/jsonl`、`application/x-ndjson` 或 `application/json-seq` 响应 | `AsyncIterable<ListItem>`，其中 `ListItem` 是条目 schema 的类型；客户端会逐条解析 |
| 其他流（没有条目 schema 的 `text/event-stream` 或 JSON Lines 等） | `ReadableStream<Uint8Array>` |
| `readOnly` / `writeOnly` | 启用 `splitVisibility`（默认）时，响应使用 `Pet`（不含 writeOnly 属性），请求使用 `PetWritable`（不含 readOnly 属性） |
| `$ref` | 具名类型；循环总是经过具名类型 |
| `{}`、`true` | `unknown` |
| `false` | `never` |
| 二进制请求/响应体（`application/octet-stream`、图片等），或带 `format: binary` 的 multipart 部分 | `Blob \| File` |
| JSON 值中的 `format: binary` | `string`（JSON 字符串无法容纳字节；会给出警告） |
| `x-tsurara-type` | 其中的 `typescript` 条目 |

## 精确、近似与拒绝 {#exact-approximated-rejected}

类型无法表达所有约束。tsurara 对每个关键字都预先决定了处理方式；即使有一个关键字无法表达，也不会让整个类型变成 `unknown`。

| 处理方式 | 关键字 | 结果 |
|---|---|---|
| 精确 | `type`、`enum`、`const`、`required`、nullable、`properties`、对象的 `allOf`、`prefixItems` | 仅凭类型即可表达规则 |
| 更宽的类型 | `oneOf` 的互斥性、字符串和数字约束（`minLength`、`pattern`、`minimum` 等）、`uniqueItems`、`patternProperties` 的模式、`prefixItems` 的长元组情况 | 类型也会接受一些定义不允许的值；约束写在 JSDoc 中。不给出警告 |
| 舍弃关键字 | `not`、`if`/`then`/`else`、`dependentSchemas`、无法解析的引用 | 根据其他关键字构建类型，并给出警告。`tsurara generate --strict` 会把警告变成错误 |
| 拒绝 | 改变 JSON 解析结果的类型映射（`Date`、`bigint`） | 配置错误 |

## 操作的类型 {#operation-types}

每个操作文件中包含调用函数、它的 OperationDef，以及以函数命名的类型：

| 类型 | |
|---|---|
| `GetPetData` | 输入：`path`、`query`、`headers`、`cookies`、`body` |
| `GetPetResponses` / `GetPetErrors` | 每个定义中声明的状态码对应的响应体类型 |
| `GetPetResult` | 函数的返回值：成功成员、定义中声明的错误、未声明状态码的成员，以及传输失败 |
| `GetPetResponseHeaders` | 定义中有响应头时，带类型的响应头 |

当某个 schema 已经使用了这些名称之一时，操作的类型会改名（`GetPetOperationResult`）并给出警告；函数名保持不变。

## 不使用客户端的类型 {#types-without-the-client}

`operations: false` 只输出声明，适用于服务端的 DTO、消息队列的载荷，或使用其他 HTTP 库发送的请求：

```yaml
input: openapi.yaml
output: src/types
operations: false
```

输出包含 schema、webhook 和事件 channel，不包含 `operations/`、OperationDef 和调用函数。此时每种语言只需要其运行时的类型层，不需要 HTTP 客户端：

| 语言 | 类型所需的依赖 |
|---|---|
| TypeScript | 无：`schemas/` 不导入任何模块，`index.ts` 也不记录运行时版本。事件 channel（`channels/`、`zod/channels.ts`）会从 `@tsurara/client` 导入 `decodeMessage` 和 `ChannelSchemas`，它们不会发送任何请求 |
| Python | 不带 extras 的 `tsurara-client`：`import tsurara_client` 和 TypeDef 编解码器无需 httpx 即可工作。调用函数需要 `tsurara-client[http]` |
| Rust | `tsurara-client = { version = "0.1", default-features = false }`：不需要 tokio 和 reqwest |
| Go | 运行时模块；生成的类型只使用其中的联合类型辅助函数，不导入 `net/http` |

各语言的页面展示了如何只用类型来解码值。
