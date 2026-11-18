---
title: "コーディングエージェント"
sourcePath: docs/guide/ai.md
sourceHash: bda3aa0b3010
---

生成されたクライアントを使ってアプリのコードを書くエージェントは、2つの答えを何度も必要とします。どの生成関数がそのエンドポイントを呼ぶのか、そしてこの言語でそれをどう呼ぶのか、です。tsuraraは定義と生成したコードから両方に答えます。答えはJSONを出力するCLIとMCPサーバーから得られます。

## MCPサーバー {#the-mcp-server}

`tsurara mcp` は、[Model Context Protocol](https://modelcontextprotocol.io)のサーバーを標準入出力で実行します。CLIと同じバイナリに入っています。起動したディレクトリの `tsurara.config.yaml` を読みます。

| ツール | 内容 |
|---|---|
| `list_targets` | ターゲットと、その言語、入力、出力 |
| `search_operations` | ID、メソッド、パス、概要、タグに `query` のすべての単語を含む操作と、その生成関数（`find pet by id` で `getPetById` が見つかります）。大きな定義では `offset` と `limit`（デフォルト50）でページを送ります |
| `describe_operation` | パラメーター、リクエストの本文、レスポンス、生成された関数と型、その操作のために生成されたほかの値（TanStack Queryのオプション、キー、フィルター、モックのハンドラー）、ターゲットの言語での呼び出し例 |
| `describe_schema` | スキーマから生成された型、ファイル、宣言 |
| `generate` | 1つまたはすべてのターゲットについて `tsurara generate` を実行します。書き込むのは設定された出力先ディレクトリだけです |
| `check` | `tsurara check` を実行します |
| `explain_warning` | 警告コードの意味と解決方法 |

インストールされているバージョンのガイドがリソース（`tsurara://docs/guide/configuration.md` など）として提供されるので、エージェントはバイナリと一致するドキュメントを読めます。

### Claude Code {#claude-code}

```sh
claude mcp add tsurara -- tsurara mcp
```

チームで共有するなら、リポジトリのルートの `.mcp.json` に書きます。

```json
{
  "mcpServers": {
    "tsurara": { "command": "tsurara", "args": ["mcp"] }
  }
}
```

tsuraraのリポジトリはClaude Codeのプラグイン（`.claude-plugin/plugin.json`）でもあり、このサーバーを登録します。

### Cursorとほかのクライアント {#cursor-and-other-clients}

同じ `mcpServers` の形式を読むクライアント（Cursorの `.cursor/mcp.json`、Windsurf、`"mcpServers"` の代わりに `"servers"` を使うVS Code）には、上のエントリをそのまま使えます。サーバーは `tsurara.config.yaml` のあるディレクトリで起動するか、クライアントの作業ディレクトリをそこに設定してください。

## スキルとプロジェクトのルール {#the-skill-and-project-rules}

`skills/tsurara/SKILL.md`（言語ごとの参照資料付き）は[Agent Skill](https://agentskills.io)です。ルール（生成ファイルを編集しない、生成された関数を呼ぶ、Resultを扱う、`tsurara check` を実行する）、答えの探し方、TypeScript、Python、Rust、Goでの操作の呼び出し方が書かれています。tsuraraのリポジトリのClaude Codeプラグインに含まれていて、ほかのエージェントはリポジトリから読めます。参照資料のコードブロックは、すべてCIで生成コードに対して型検査されています。

`tsurara init --agents` は、同じルールを短くまとめて `AGENTS.md`（プロジェクトに `CLAUDE.md` しかなければそちら）の `<!-- tsurara:start -->` と `<!-- tsurara:end -->` の間に書き込みます。もう一度実行すると、その部分を置き換えます。

[llms.txt](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/llms.txt)は言語モデル向けのドキュメントの索引で、[llms-full.txt](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/llms-full.txt)にはそのすべてが1つのファイルに入っています。

## CLI {#the-cli}

MCPのツールではなくシェルのコマンドを実行するエージェントのために、サーバーの答えはすべてコマンドでも得られます。

```sh
tsurara inspect operations --search "find pet by id" --format json
tsurara inspect operation getPetById --target web --format json
tsurara inspect schema Pet --format json
tsurara inspect warning unresolved-ref
tsurara generate --format json
tsurara check --format json
```

設定に複数のターゲットがあるときは `--target` が必要です。`generate` と `check` のJSONは[spec/cli-output.schema.json](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/spec/cli-output.schema.json)に従います。

## 呼び出し例 {#call-examples}

`describe_operation` と `inspect operation` は、生成された関数を呼び出すファイルを出力します。引数には定義のサンプル値（例、デフォルト値、制約）を、ベースURLには定義の最初のサーバーを使い、Resultはその言語の流儀で扱います。このファイルは生成コードの隣に置けばコンパイルできます。

| 言語 | ファイル | 補足 |
|---|---|---|
| TypeScript | 出力のルートの `example.ts` | `query: tanstack` のときは `exampleQuery`（同じ呼び出しをクエリオプション経由で行うもの）か `exampleMutation` も含み、ほかのヘルパーの使いどころも示します |
| Python | パッケージ内の `example.py` | 単純な値でない引数は、パッケージの `CODEC` でデコードします |
| Rust | `mod.rs` の隣の `example.rs` | `mod example;` を追加してください。引数は `serde_json` でデコードします |
| Go | パッケージ内の `example.go` | 定数でない値はJSONからデコードします |

JSON以外のリクエストの本文（ファイル、フォームの項目）は、アプリ側で埋めるように残されます。
