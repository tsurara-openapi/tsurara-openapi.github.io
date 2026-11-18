---
title: "移行"
sourcePath: docs/guide/migration.md
sourceHash: 4e51fa30abcb
---

## openapi-typescriptとopenapi-fetchから {#from-openapi-typescript-and-openapi-fetch}

openapi-typescriptは1つの `paths` 型を生成し、openapi-fetchはパスを指定して呼び出します：`client.GET('/pets/{petId}', { params: { path: { petId: 1 } } })`。tsuraraは代わりに、操作ごとに関数を生成します。

| openapi-fetch | tsurara |
|---|---|
| `createClient<paths>({ baseUrl })` | `createClient({ baseUrl })` |
| `client.GET('/pets/{petId}', { params: { path: { petId } } })` | `getPet(api, { path: { petId } })` |
| `params.query`、`params.header`、`params.cookie`、`body` | `query`、`headers`、`cookies`、`body` |
| `{ data, error, response }` | Result：`r.ok ? r.data : r.kind === 'http' ? r.error : ...`。通信の失敗もrejectではなく結果として返ります |
| `components['schemas']['Pet']` | `Pet`（スキーマごとに1つのexport） |
| `paths['/pets']['get']['responses'][200]['content']['application/json']` | `ListPetsResponses[200]`、または `SuccessData<ListPetsResult>` |
| ミドルウェアの `onRequest` / `onResponse` | ミドルウェア `(req, next) => ...` |

汎用のコードのためにパスをキーにした形が必要なら、`typescript.aggregateMaps: true` で `paths.ts` と `operations.ts` も出力されます。

## hey-apiから {#from-hey-api}

hey-api（`@hey-api/openapi-ts`）も、クライアントのプラグインを使って操作ごとの関数（`getPet({ path: { petId } })`）を生成します。

| hey-api | tsurara |
|---|---|
| `openapi-ts.config.ts`、プラグイン | `tsurara.config.yaml`。TypeScriptの出力とランタイムは組み込みで、それ以外はフックで行います |
| `client.setConfig({ baseUrl })`、グローバルなクライアント | 各呼び出しに `createClient(...)` を渡します。複数のクライアントを併用できます |
| `getPet({ client, path })` | `getPet(api, { path })`、または `bindClient(api, { getPet })` |
| `{ data, error }`（または `throwOnError`） | Result、または `ApiError` を投げる `unwrap` |
| `GetPetData`、`GetPetResponses`、`GetPetErrors` | 同じ名前 |
| 1つのファイルにまとめた `types.gen.ts` | 1ファイルにするなら `layout: single`。操作とスキーマごとに1ファイルにするなら `split`（デフォルト） |

## 変わること {#things-that-change}

- 呼び出しはrejectされません。`r.ok` と `r.kind` で分岐するか、`unwrap` を使います。
- enumはデフォルトでunionになります（オブジェクトにするなら `enumStyle: const`）。
- `readOnly`/`writeOnly` のあるスキーマには、リクエスト用の `Writable` 版ができます。
- 日付は文字列のままです（JSONに日付型はありません）。区別したいなら、`typeMappings` でフォーマットをブランド付きの型に対応づけます。
