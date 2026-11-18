---
title: "Coding agents"
sourcePath: docs/guide/ai.md
sourceHash: bda3aa0b3010
---

Agents that write application code against a generated client need two answers again and again: which generated function calls an endpoint, and how to call it in this language. tsurara answers both from the definition and the code it generated, through a CLI that prints JSON and an MCP server.

## The MCP server

`tsurara mcp` runs a [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, in the same binary as the CLI. It reads `tsurara.config.yaml` from the directory it starts in.

| Tool | Does |
|---|---|
| `list_targets` | The targets, their language, input and output |
| `search_operations` | Operations whose id, method, path, summary or tags contain every word of `query` (`find pet by id` finds `getPetById`), with the generated function; `offset` and `limit` (default 50) page through large definitions |
| `describe_operation` | Parameters, request body, responses, the generated function and types, the other values generated for the operation (TanStack Query options, keys and filters, mock handlers), and a call example in the target's language |
| `describe_schema` | A schema's generated type, file and declaration |
| `generate` | Runs `tsurara generate` for one target or all; writes only into the configured output directories |
| `check` | Runs `tsurara check` |
| `explain_warning` | What a warning code means and how to resolve it |

The guides of the installed version are resources (`tsurara://docs/guide/configuration.md`, ...), so an agent reads documentation that matches the binary.

### Claude Code

```sh
claude mcp add tsurara -- tsurara mcp
```

Or in `.mcp.json` at the repository root, shared with the team:

```json
{
  "mcpServers": {
    "tsurara": { "command": "tsurara", "args": ["mcp"] }
  }
}
```

This repository is also a Claude Code plugin (`.claude-plugin/plugin.json`) that registers the server.

### Cursor and other clients

Clients that read the same `mcpServers` format (Cursor's `.cursor/mcp.json`, Windsurf, VS Code with `"servers"` instead of `"mcpServers"`) take the entry above. Start the server in the directory with `tsurara.config.yaml`, or set the client's working directory to it.

## The skill and project rules

`skills/tsurara/SKILL.md` (with references per language) is an [Agent Skill](https://agentskills.io): the rules (never edit generated files, call the generated functions, handle Results, run `tsurara check`), how to find answers, and how to call operations in TypeScript, Python, Rust and Go. The Claude Code plugin of this repository includes it; other agents can read it from the repository. Every code block in the references is type-checked against generated code in CI.

`tsurara init --agents` writes the same rules, briefly, into `AGENTS.md` (or `CLAUDE.md` when the project only has that), between `<!-- tsurara:start -->` and `<!-- tsurara:end -->`; running it again replaces that section.

[llms.txt](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/llms.txt) indexes the documentation for language models, and [llms-full.txt](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/llms-full.txt) holds all of it in one file.

## The CLI

Every answer of the server is also a command, for agents that run shell commands instead of MCP tools:

```sh
tsurara inspect operations --search "find pet by id" --format json
tsurara inspect operation getPetById --target web --format json
tsurara inspect schema Pet --format json
tsurara inspect warning unresolved-ref
tsurara generate --format json
tsurara check --format json
```

`--target` is required when the configuration has several targets. The JSON of `generate` and `check` follows [spec/cli-output.schema.json](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/spec/cli-output.schema.json).

## Call examples

`describe_operation` and `inspect operation` print a file that calls the generated function with sample values from the definition (its examples, defaults and constraints) and the definition's first server as the base URL, and handles the Result as the language does. It compiles next to the generated code:

| Language | File | Note |
|---|---|---|
| TypeScript | `example.ts` at the output root | With `query: tanstack`, also `exampleQuery` (the same call through the query options) or `exampleMutation`, and where the other helpers fit |
| Python | `example.py` in the package | Arguments that are not plain values are decoded with the package's `CODEC` |
| Rust | `example.rs` next to `mod.rs` | Add `mod example;`; arguments are decoded with `serde_json` |
| Go | `example.go` in the package | Values that are not constants are decoded from JSON |

Request bodies that are not JSON (files, form fields) are left for the app to fill.
