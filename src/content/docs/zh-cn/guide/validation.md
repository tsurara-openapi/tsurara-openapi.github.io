---
title: "校验"
sourcePath: docs/guide/validation.md
sourceHash: 19a25cfc9f72
---

tsurara 检查什么，以及哪些需要你自己负责（design.md 第 12 章和第 15 章）。

## tsurara 检查的内容 {#what-tsurara-checks}

| 检查 | 方式 |
|---|---|
| 生成的文件与定义一致 | 在 CI 中运行 `tsurara check`：发现忘记重新生成或手动修改 |
| 生成的代码与运行时相匹配 | `tsurara check` 比较代码中记录的版本范围与已安装的 `@tsurara/client` |
| 定义被如实转换 | 类型要么精确，要么更宽（约束写在 JSDoc 中），要么舍弃该关键字并给出警告（[类型](../types/)）；`--strict` 会把警告变成错误 |
| 响应的状态码和媒体类型与定义一致 | 在运行时检查：未声明的状态码是 `documented: false` 的 `http` 结果（可通过 `onUndocumentedStatus` 观察）；与定义不符的响应体是 `parse` 结果 |

## tsurara 不检查的内容 {#what-tsurara-does-not-check}

- **响应是否符合其 schema，除非你要求。** 默认只解析 JSON，不做校验：类型表示的是定义所承诺的内容，而不是服务器实际发送的内容。使用 `typescript.validators: zod` 和 `validate: validateResponses(responseSchemas)` 时，客户端会检查类型和格式，并对不匹配的响应体返回 `kind: 'validation'`（[客户端](../client/#validation)）。要在发布之前发现偏差，仍需要服务端的契约测试。
- **类型无法表达的约束**（`pattern`、`minimum`、`maxLength` 等），除非你要求。它们写在 JSDoc 中。使用 `typescript.validatorConstraints: true` 时，Zod schema 也会检查它们（以及格式 `uri`、`ipv4`、`ipv6`、`date`、`time`、`duration`），因此可用于校验表单输入；此时响应校验也会拒绝违反这些约束的值。JavaScript 无法编译的 `pattern` 会被省略并给出警告。请求在发送前不做校验。
- **表单。** 在 UI 中校验用户输入是另一项工作（提示信息、未填完的值、API 中没有的字段）。请使用带有自己 schema 的表单库；tsurara 的类型很适合作为它的输出目标。
