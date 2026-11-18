---
title: "はじめに"
sourcePath: README.md
sourceHash: 8218f166c4ab
---

tsuraraは、OpenAPI 3.0、3.1、3.2とSwagger 2.0の定義から、型と操作ごとの呼び出し関数を生成します。対応言語はTypeScriptとPythonで、RustとGoは実験的な対応です。
呼び出しは例外を投げずにResultを返します。TanStack Queryのヘルパー、Zodスキーマ、モックも生成でき、コーディングエージェント向けにMCPサーバーとJSON出力のCLIがあります。
tsuraraは単一のバイナリで、生成にNodeは要りません。出力は薄く、TypeScriptの最も厳しいオプションで型検査を通ります。CIでは実在のAPI定義からの生成結果も検査しています。

## クイックスタート {#quick-start}

必要なもの：Node 22.18以降（下の例をそのまま実行する場合）。

1. 生成器とランタイムライブラリをインストールします。

   ```sh
   npm install --save-dev tsurara
   npm install @tsurara/client
   ```

   `tsurara` パッケージは、macOS、Linux、Windows（x64とarm64）向けのネイティブバイナリを実行します。各[GitHubリリース](https://github.com/tsurara-openapi/tsurara/releases)にも、バイナリのアーカイブがあります。

2. `tsurara.config.yaml` を作ります（`npx tsurara init` でも作れます）。

   ```yaml
   input: https://petstore3.swagger.io/api/v3/openapi.json
   output: src/generated
   typescript:
     importExtension: ts   # Nodeの型ストリッピングで直接実行する場合。tscでビルドするなら `js`（デフォルト）
   ```

3. 生成します。

   ```sh
   npx tsurara generate
   ```

4. APIを呼び出します。

   ```ts
   // main.ts
   import { createClient, isHttpError, unwrap } from '@tsurara/client';
   import { getInventory, getPetById } from './src/generated/index.ts';

   const api = createClient({ baseUrl: 'https://petstore3.swagger.io/api/v3' });

   const inventory = unwrap(await getInventory(api)); // { [status: string]: number }
   console.log(inventory);

   const result = await getPetById(api, { path: { petId: 1 } });
   if (result.ok) console.log(result.data);
   else if (isHttpError(result, 404)) console.log('no such pet');
   else console.log('failed:', result.kind);
   ```

   ```sh
   node main.ts
   ```
