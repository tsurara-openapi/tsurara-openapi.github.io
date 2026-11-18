---
title: "迁移"
sourcePath: docs/guide/migration.md
sourceHash: 4e51fa30abcb
---

## 从 openapi-typescript 和 openapi-fetch 迁移 {#from-openapi-typescript-and-openapi-fetch}

openapi-typescript 生成一个 `paths` 类型，openapi-fetch 按路径调用它：`client.GET('/pets/{petId}', { params: { path: { petId: 1 } } })`。tsurara 则为每个操作生成一个函数。

| openapi-fetch | tsurara |
|---|---|
| `createClient<paths>({ baseUrl })` | `createClient({ baseUrl })` |
| `client.GET('/pets/{petId}', { params: { path: { petId } } })` | `getPet(api, { path: { petId } })` |
| `params.query`、`params.header`、`params.cookie`、`body` | `query`、`headers`、`cookies`、`body` |
| `{ data, error, response }` | Result：`r.ok ? r.data : r.kind === 'http' ? r.error : ...`；传输失败也是结果，而不是 reject |
| `components['schemas']['Pet']` | `Pet`（每个 schema 一个导出） |
| `paths['/pets']['get']['responses'][200]['content']['application/json']` | `ListPetsResponses[200]`，或 `SuccessData<ListPetsResult>` |
| 中间件 `onRequest` / `onResponse` | 中间件 `(req, next) => ...` |

如果通用代码需要以路径为键的形式，`typescript.aggregateMaps: true` 还会输出 `paths.ts` 和 `operations.ts`。

## 从 hey-api 迁移 {#from-hey-api}

hey-api（`@hey-api/openapi-ts`）也通过客户端插件为每个操作生成函数（`getPet({ path: { petId } })`）。

| hey-api | tsurara |
|---|---|
| `openapi-ts.config.ts`、插件 | `tsurara.config.yaml`：TypeScript 输出和运行时是内置的；其余功能用钩子实现 |
| `client.setConfig({ baseUrl })`，全局客户端 | 把 `createClient(...)` 传给每次调用；可以同时存在多个客户端 |
| `getPet({ client, path })` | `getPet(api, { path })`，或 `bindClient(api, { getPet })` |
| `{ data, error }`（或 `throwOnError`） | Result，或抛出 `ApiError` 的 `unwrap` |
| `GetPetData`、`GetPetResponses`、`GetPetErrors` | 相同的名称 |
| 单个文件中的 `types.gen.ts` | 单个文件用 `layout: single`；每个操作和 schema 一个文件用 `split`（默认） |

## 需要注意的变化 {#things-that-change}

- 调用不会 reject：请处理 `r.ok` 和 `r.kind`，或使用 `unwrap`。
- 枚举默认是联合类型（需要对象时用 `enumStyle: const`）。
- 带 `readOnly`/`writeOnly` 的 schema 会为请求生成一个 `Writable` 变体。
- 日期保持为字符串（JSON 中没有日期类型）；如果希望区分，可以用 `typeMappings` 把格式映射到带品牌的类型。
