---
title: "モノレポ"
sourcePath: docs/guide/monorepo.md
sourceHash: a0a97640b239
---

共有パッケージに一度だけ生成し、各アプリはそれをimportします。[examples/pnpm-monorepo](https://github.com/tsurara-openapi/tsurara/tree/170cabec56cf573944620f7d2ef05eb2b845d2bb/examples/pnpm-monorepo)はCIでテストしている動く構成で、ViteのアプリとNodeのアプリが `@acme/openapi` を共有しています。

```
packages/openapi/                 @acme/openapi
  tsurara.config.yaml                input, output: src/generated, typescript.importExtension: ts
  src/index.ts                    export * from '@tsurara/client'; export * from './generated/index.ts';
  package.json                    "sideEffects": false, .ts ファイルの exports
apps/web/                         バンドルするアプリ
apps/cli/                         Node の型ストリッピングで実行
```

```json
{
  "name": "@acme/openapi",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./src/index.ts",
    "./operations/*": "./src/generated/operations/*.ts",
    "./schemas/*": "./src/generated/schemas/*.ts"
  },
  "dependencies": { "@tsurara/client": "..." }
}
```

- パッケージはビルドしません。`exports` は `importExtension: ts` で生成した `.ts` ファイルを指しているので、バンドラーも型ストリッピングを使うNode（22.18以降）も、そのまま読めます。
- このパッケージをimportするコードをコンパイルするtsconfigには、すべて `allowImportingTsExtensions`（`noEmit` とともに）か `rewriteRelativeImportExtensions` が必要です。各アプリ、テスト用のパッケージ、ツールのtsconfigが対象です。これがないと、TypeScriptは利用者のコードではなく、共有パッケージのファイルの中でTS5097を報告します。
- バンドルには、アプリが使う操作だけが残ります。barrelを経由していても同じです（`sideEffects: false`）。Nodeと開発サーバーはbarrelが参照するモジュールをすべて読み込むので、定義が大きいときはサブパスからimportしてください：`@acme/openapi/operations/getPet`。
- `@tsurara/client` は共有パッケージの依存関係で、共有パッケージが再exportします。そのためワークスペースにはコピーが1つしかありません。
- CIでは共有パッケージで `tsurara check` を実行します。生成ファイルが古いときや、インストール済みの `@tsurara/client` が合わないときに失敗します。
- `.ts` ファイルをimportできない利用側があるなら、`importExtension: js` で生成し、普通のライブラリと同じくパッケージを `.js` と `.d.ts` にビルドします。
- Next.js（16.4、Turbopackでもwebpackでも）はパッケージをそのまま読めます。`transpilePackages` は不要で、tsconfigに `allowImportingTsExtensions` があれば足ります。サンプルにはNext.jsのアプリもあります。
