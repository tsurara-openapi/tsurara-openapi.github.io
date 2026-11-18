---
title: "CLI"
sourcePath: docs/guide/cli.md
sourceHash: 2712fc267038
---

| 命令 | |
|---|---|
| `tsurara generate [--config <path>] [--target <name>] [--strict]` | 生成并写入所有目标的文件（`--strict`：警告视为错误） |
| `tsurara check` | 当生成的文件与应生成的内容不同，或已安装的 `@tsurara/client` 不匹配时，以退出码 1 结束；用于 CI |
| `tsurara init [--agents] [--preset react-query]` | 写入 `tsurara.config.yaml` 模板（`--agents`：同时在 `AGENTS.md` 中写入面向编程智能体的规则；`--preset react-query`：为使用 TanStack Query 的 React 启用查询选项、Zod schema 和 MSW 处理器，并给出需要安装的包） |
| `tsurara mcp` | 面向编程智能体的 MCP 服务器（[指南](../ai/)） |
| `tsurara inspect operations` / `operation <id>` / `schema <name>` / `warning <code>` | 在不写入文件的情况下，查询操作、生成的函数及调用示例、schema 生成的类型，或某个警告的含义 |

`generate` 和 `check` 接受 `--format json`，供脚本和编程智能体使用（[spec/cli-output.schema.json](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/spec/cli-output.schema.json)）；`inspect` 接受 `--format json|text` 和 `--target`。

`generate` 只写入内容发生变化的文件，并删除输出目录中以 tsurara 生成文件标记开头的过时文件。
