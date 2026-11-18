---
title: "CLI"
sourcePath: docs/guide/cli.md
sourceHash: 40cda569f3ee
---

| コマンド | |
|---|---|
| `tsurara generate [--config <path>] [--target <name>] [--strict]` | すべてのターゲットのファイルを生成して書き込みます（`--strict`：警告をエラーにします） |
| `tsurara check` | 生成ファイルが生成されるはずの内容と異なるとき、またはインストール済みの `@tsurara/client` が合わないときに、終了コード1で終わります。CI向けです |
| `tsurara init [--agents] [--preset react-query]` | `tsurara.config.yaml` のひな形を書き込みます（`--agents`：コーディングエージェント向けのルールを `AGENTS.md` にも書きます。`--preset react-query`：TanStack Queryを使うReact向けに、クエリオプション、Zodスキーマ、MSWのハンドラーを有効にし、インストールすべきパッケージを示します） |
| `tsurara mcp` | コーディングエージェント向けのMCPサーバー（[ガイド](../ai/)） |
| `tsurara inspect operations` / `operation <id>` / `schema <name>` / `warning <code>` | ファイルを書き込まずに、操作の一覧、生成された関数と呼び出し例、スキーマから生成された型、警告の意味を調べます |

`generate` と `check` は、スクリプトやコーディングエージェント向けに `--format json` を受け付けます（[spec/cli-output.schema.json](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/spec/cli-output.schema.json)）。`inspect` は `--format json|text` と `--target` を受け付けます。

`generate` は内容が変わったファイルだけを書き込み、出力先ディレクトリにある、tsuraraの生成ファイルの目印で始まる古いファイルを削除します。
