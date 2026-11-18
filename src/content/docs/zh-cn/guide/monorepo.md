---
title: "Monorepo"
sourcePath: docs/guide/monorepo.md
sourceHash: 671b93f91d5a
---

只在一个共享包中生成一次，让每个应用导入它。[examples/pnpm-monorepo](https://github.com/tsurara-openapi/tsurara/tree/c5cc557cdb42c8f28966541163492b2cf79bd296/examples/pnpm-monorepo) 是一个可运行的示例，在 CI 中进行测试：一个 Vite 应用和一个 Node 应用共享 `@acme/openapi`。

```
packages/openapi/                 @acme/openapi
  tsurara.config.yaml                input, output: src/generated, typescript.importExtension: ts
  src/index.ts                    export * from '@tsurara/client'; export * from './generated/index.ts';
  package.json                    "sideEffects": false，导出 .ts 文件
apps/web/                         经过打包的应用
apps/cli/                         用 Node 的类型剥离运行
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

- 这个包不需要构建：它的 `exports` 指向用 `importExtension: ts` 生成的 `.ts` 文件，因此打包工具和启用类型剥离的 Node（22.18 或更高版本）都能直接读取。
- 每个编译“导入该包的代码”的 tsconfig 都需要 `allowImportingTsExtensions`（与 `noEmit` 一起）或 `rewriteRelativeImportExtensions`：包括每个应用、测试包和工具。否则 TypeScript 会在共享包的文件中报告 TS5097，而不是在你的代码中。
- 打包结果只保留应用用到的操作，即使通过 barrel 导入也是如此（`sideEffects: false`）。Node 和开发服务器会加载 barrel 引用的所有模块，因此定义较大时，请从子路径导入：`@acme/openapi/operations/getPet`。
- `@tsurara/client` 是共享包的依赖，并由共享包重新导出，因此工作区中只有一份副本。
- 在 CI 中于共享包内运行 `tsurara check`：当生成的文件过时，或已安装的 `@tsurara/client` 不匹配时，它会失败。
- 如果某个使用方无法导入 `.ts` 文件，就用 `importExtension: js` 生成，并像普通库一样把包构建为 `.js` 和 `.d.ts`。
- Next.js（16.4，Turbopack 或 webpack）可以直接读取这个包：不需要 `transpilePackages`，只需在其 tsconfig 中设置 `allowImportingTsExtensions`。示例中包含一个 Next.js 应用。
