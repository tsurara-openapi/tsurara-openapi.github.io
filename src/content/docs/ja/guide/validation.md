---
title: "検証"
sourcePath: docs/guide/validation.md
sourceHash: 19a25cfc9f72
---

tsuraraが検査するものと、利用者に任されるものです（design.md 12章と15章）。

## tsuraraが検査するもの {#what-tsurara-checks}

| 検査 | 方法 |
|---|---|
| 生成ファイルが定義と一致している | CIで `tsurara check` を実行します。再生成のし忘れや手での編集を見つけます |
| 生成コードとランタイムが合っている | `tsurara check` が、コードに記録されたバージョンの範囲とインストール済みの `@tsurara/client` を比べます |
| 定義が忠実に変換されている | 型は正確か、より広い型（制約はJSDocに書かれます）になるか、警告を出してキーワードを省きます（[型](../types/)）。`--strict` で警告がエラーになります |
| レスポンスのステータスとメディアタイプが定義と合っている | 実行時に検査します。定義にないステータスは `documented: false` の `http` の結果になり（`onUndocumentedStatus` で観測できます）、定義と異なる本文は `parse` の結果になります |

## tsuraraが検査しないもの {#what-tsurara-does-not-check}

- **レスポンスがスキーマに合っているか（指定しない限り）。** デフォルトでは、JSONは解析するだけで検証しません。型が表すのは定義が約束している内容で、サーバーが実際に送った内容ではありません。`typescript.validators: zod` と `validate: validateResponses(responseSchemas)` を指定すると、クライアントは型とフォーマットを検査し、合わない本文には `kind: 'validation'` を返します（[クライアント](../client/#validation)）。リリース前にずれを見つけるには、これとは別にサーバー側のコントラクトテストが必要です。
- **型で表せない制約**（`pattern`、`minimum`、`maxLength` など）も、指定しない限り検査しません。これらはJSDocに書かれます。`typescript.validatorConstraints: true` にするとZodスキーマがそれらも（フォーマット `uri`、`ipv4`、`ipv6`、`date`、`time`、`duration` も）検査するので、フォームの入力の検証にも使えます。ただし、制約に反する値はレスポンスの検証でも拒否されるようになります。JavaScriptでコンパイルできない `pattern` は、警告を出して省きます。リクエストは送信前に検証しません。
- **フォーム。** UIでのユーザー入力の検証は別の仕事です（メッセージ、入力途中の値、APIにはない項目）。独自のスキーマを持つフォームライブラリを使ってください。その出力先として、tsuraraの型が使えます。
