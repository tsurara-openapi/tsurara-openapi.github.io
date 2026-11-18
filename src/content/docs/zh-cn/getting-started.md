---
title: "入门"
sourcePath: README.md
sourceHash: 8218f166c4ab
---

tsurara 根据 OpenAPI 3.0、3.1、3.2 和 Swagger 2.0 定义，生成类型以及每个操作对应的调用函数。支持 TypeScript 和 Python，Rust 和 Go 为实验性支持。
调用不会抛出异常，而是返回 Result。它还可以生成 TanStack Query 辅助函数、Zod schema 和 Mock，并为编程智能体提供 MCP 服务器和 JSON 输出的 CLI。
tsurara 是单个二进制文件，生成时不需要 Node。它的输出很轻量，可以通过 TypeScript 最严格的选项检查，并在 CI 中针对真实的 API 定义进行验证。

## 快速开始 {#quick-start}

要求：Node 22.18 或更高版本（用于直接运行下面的示例）。

1. 安装生成器和运行时库：

   ```sh
   npm install --save-dev tsurara
   npm install @tsurara/client
   ```

   `tsurara` 包会运行适用于 macOS、Linux 或 Windows（x64 与 arm64）的原生二进制文件。每个 [GitHub release](https://github.com/tsurara-openapi/tsurara/releases) 中也提供了这些二进制文件的压缩包。

2. 创建 `tsurara.config.yaml`（或运行 `npx tsurara init`）：

   ```yaml
   input: https://petstore3.swagger.io/api/v3/openapi.json
   output: src/generated
   typescript:
     importExtension: ts   # 用 Node 的类型剥离直接运行；使用 tsc 构建时用 `js`（默认）
   ```

3. 生成：

   ```sh
   npx tsurara generate
   ```

4. 调用 API：

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
