---
title: "Monorepos"
sourcePath: docs/guide/monorepo.md
sourceHash: a0a97640b239
---

Generate once into a shared package, and let every app import it. [examples/pnpm-monorepo](https://github.com/tsurara-openapi/tsurara/tree/170cabec56cf573944620f7d2ef05eb2b845d2bb/examples/pnpm-monorepo) is a working setup, tested in CI: a Vite app and a Node app sharing `@acme/openapi`.

```
packages/openapi/                 @acme/openapi
  tsurara.config.yaml                input, output: src/generated, typescript.importExtension: ts
  src/index.ts                    export * from '@tsurara/client'; export * from './generated/index.ts';
  package.json                    "sideEffects": false, exports of .ts files
apps/web/                         a bundled app
apps/cli/                         run with Node type stripping
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

- The package is not built: its `exports` point at `.ts` files, generated with `importExtension: ts`, so bundlers and Node with type stripping (22.18 or later) both read them.
- Every tsconfig that compiles code importing it needs `allowImportingTsExtensions` (with `noEmit`) or `rewriteRelativeImportExtensions`: each app, test package and tool. Without it TypeScript reports TS5097 inside the shared package's files, not in your code.
- Bundles keep only the operations an app uses, even through the barrel (`sideEffects: false`). Node and dev servers load every module the barrel refers to, so for large definitions import from the subpaths: `@acme/openapi/operations/getPet`.
- `@tsurara/client` is a dependency of the shared package and re-exported by it, so the workspace has one copy.
- Run `tsurara check` in CI in the shared package: it fails when the generated files are out of date or the installed `@tsurara/client` does not match.
- If a consumer cannot import `.ts` files, generate with `importExtension: js` and build the package to `.js` and `.d.ts` like any library.
- Next.js (16.4, Turbopack or webpack) reads the package as it is: no `transpilePackages`, only `allowImportingTsExtensions` in its tsconfig. The example has a Next.js app.
