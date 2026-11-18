---
title: "编程智能体"
sourcePath: docs/guide/ai.md
sourceHash: 2a037fd06058
---

基于生成的客户端编写应用代码的智能体会反复需要两个答案：哪个生成的函数调用某个端点，以及在这种语言中如何调用它。tsurara 根据定义和它生成的代码回答这两个问题，途径是一个输出 JSON 的 CLI 和一个 MCP 服务器。

## MCP 服务器 {#the-mcp-server}

`tsurara mcp` 通过 stdio 运行一个 [Model Context Protocol](https://modelcontextprotocol.io) 服务器，它与 CLI 在同一个二进制文件中。它读取启动目录下的 `tsurara.config.yaml`。

| 工具 | 作用 |
|---|---|
| `list_targets` | 各个目标及其语言、输入和输出 |
| `search_operations` | 查找 id、方法、路径、摘要或标签包含 `query` 中所有单词的操作（`find pet by id` 能找到 `getPetById`），并给出生成的函数；`offset` 和 `limit`（默认 50）用于在大型定义中翻页 |
| `describe_operation` | 参数、请求体、响应、生成的函数和类型、为该操作生成的其他内容（TanStack Query 选项、键和过滤器、Mock 处理器），以及目标语言的调用示例 |
| `describe_schema` | schema 生成的类型、文件和声明 |
| `generate` | 为一个或所有目标运行 `tsurara generate`；只写入配置的输出目录 |
| `check` | 运行 `tsurara check` |
| `explain_warning` | 某个警告代码的含义以及解决方法 |

已安装版本的指南以资源形式提供（`tsurara://docs/guide/configuration.md` 等），因此智能体读到的文档与二进制文件的版本一致。

### Claude Code {#claude-code}

```sh
claude mcp add tsurara -- tsurara mcp
```

或者写在仓库根目录的 `.mcp.json` 中，与团队共享：

```json
{
  "mcpServers": {
    "tsurara": { "command": "tsurara", "args": ["mcp"] }
  }
}
```

tsurara 的仓库同时也是一个注册该服务器的 Claude Code 插件（`.claude-plugin/plugin.json`）。

### Cursor 及其他客户端 {#cursor-and-other-clients}

读取相同 `mcpServers` 格式的客户端（Cursor 的 `.cursor/mcp.json`、Windsurf、用 `"servers"` 代替 `"mcpServers"` 的 VS Code）可以使用上面的条目。请在包含 `tsurara.config.yaml` 的目录中启动服务器，或把客户端的工作目录设为该目录。

## Skill 与项目规则 {#the-skill-and-project-rules}

`skills/tsurara/SKILL.md`（附有各语言的参考资料）是一个 [Agent Skill](https://agentskills.io)：包括规则（不要编辑生成的文件、调用生成的函数、处理 Result、运行 `tsurara check`）、如何查找答案，以及如何在 TypeScript、Python、Rust 和 Go 中调用操作。tsurara 仓库的 Claude Code 插件包含了它；其他智能体可以从仓库中读取。参考资料中的每个代码块都会在 CI 中针对生成的代码进行类型检查。

`tsurara init --agents` 会把同样的规则简要地写入 `AGENTS.md`（项目中只有 `CLAUDE.md` 时则写入它），位于 `<!-- tsurara:start -->` 和 `<!-- tsurara:end -->` 之间；再次运行会替换这一部分。

[llms.txt](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/llms.txt) 为语言模型索引了文档，[llms-full.txt](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/llms-full.txt) 则把全部文档放在一个文件中。

## CLI {#the-cli}

对于运行 shell 命令而非 MCP 工具的智能体，服务器的每个答案都有对应的命令：

```sh
tsurara inspect operations --search "find pet by id" --format json
tsurara inspect operation getPetById --target web --format json
tsurara inspect schema Pet --format json
tsurara inspect warning unresolved-ref
tsurara generate --format json
tsurara check --format json
```

配置中有多个目标时需要 `--target`。`generate` 和 `check` 的 JSON 遵循 [spec/cli-output.schema.json](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/spec/cli-output.schema.json)。

## 调用示例 {#call-examples}

`describe_operation` 和 `inspect operation` 会打印一个调用生成函数的文件：参数使用定义中的示例值（示例、默认值和约束），base URL 使用定义中的第一个服务器，并按该语言的习惯处理 Result。该文件放在生成的代码旁边即可编译：

| 语言 | 文件 | 说明 |
|---|---|---|
| TypeScript | 输出根目录下的 `example.ts` | 使用 `query: tanstack` 时，还包括 `exampleQuery`（通过查询选项进行同样的调用）或 `exampleMutation`，以及其他辅助函数的适用位置 |
| Python | 包中的 `example.py` | 非普通值的参数用包的 `CODEC` 解码 |
| Rust | `mod.rs` 旁边的 `example.rs` | 添加 `mod example;`；参数用 `serde_json` 解码 |
| Go | 包中的 `example.go` | 非常量的值从 JSON 解码 |

非 JSON 的请求体（文件、表单字段）留给应用填写。
