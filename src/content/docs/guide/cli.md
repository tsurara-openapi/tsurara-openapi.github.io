---
title: "The CLI"
sourcePath: docs/guide/cli.md
sourceHash: 40cda569f3ee
---

| Command | |
|---|---|
| `tsurara generate [--config <path>] [--target <name>] [--strict]` | Generate and write the files of every target (`--strict`: warnings are errors) |
| `tsurara check` | Exit with 1 when the generated files differ from what would be generated, or when the installed `@tsurara/client` does not match; for CI |
| `tsurara init [--agents] [--preset react-query]` | Write a `tsurara.config.yaml` template (`--agents`: also the rules for coding agents in `AGENTS.md`; `--preset react-query`: query options, Zod schemas and MSW handlers for React with TanStack Query, and the packages to install) |
| `tsurara mcp` | An MCP server for coding agents ([guide](../ai/)) |
| `tsurara inspect operations` / `operation <id>` / `schema <name>` / `warning <code>` | Look up operations, the generated function and a call example, a schema's generated type, or what a warning means, without writing files |

`generate` and `check` take `--format json` for scripts and coding agents ([spec/cli-output.schema.json](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/spec/cli-output.schema.json)); `inspect` takes `--format json|text` and `--target`.

`generate` writes only the files whose content changed, and deletes stale files in the output directory that start with tsurara's generated-file marker.
