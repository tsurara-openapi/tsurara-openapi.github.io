---
title: "Migration"
sourcePath: docs/guide/migration.md
sourceHash: 4e51fa30abcb
---

## From openapi-typescript and openapi-fetch

openapi-typescript generates one `paths` type, and openapi-fetch calls it by path: `client.GET('/pets/{petId}', { params: { path: { petId: 1 } } })`. tsurara generates a function per operation instead.

| openapi-fetch | tsurara |
|---|---|
| `createClient<paths>({ baseUrl })` | `createClient({ baseUrl })` |
| `client.GET('/pets/{petId}', { params: { path: { petId } } })` | `getPet(api, { path: { petId } })` |
| `params.query`, `params.header`, `params.cookie`, `body` | `query`, `headers`, `cookies`, `body` |
| `{ data, error, response }` | A Result: `r.ok ? r.data : r.kind === 'http' ? r.error : ...`; transport failures are results too, not rejections |
| `components['schemas']['Pet']` | `Pet` (one export per schema) |
| `paths['/pets']['get']['responses'][200]['content']['application/json']` | `ListPetsResponses[200]`, or `SuccessData<ListPetsResult>` |
| Middleware `onRequest` / `onResponse` | Middleware `(req, next) => ...` |

If you need the path-keyed form for generic code, `typescript.aggregateMaps: true` also emits `paths.ts` and `operations.ts`.

## From hey-api

hey-api (`@hey-api/openapi-ts`) also generates per-operation functions (`getPet({ path: { petId } })`) with a client plugin.

| hey-api | tsurara |
|---|---|
| `openapi-ts.config.ts`, plugins | `tsurara.config.yaml`: TypeScript output and the runtime are built in; hooks for the rest |
| `client.setConfig({ baseUrl })`, a global client | `createClient(...)` passed to each call; several clients can coexist |
| `getPet({ client, path })` | `getPet(api, { path })`, or `bindClient(api, { getPet })` |
| `{ data, error }` (or `throwOnError`) | Results, or `unwrap` that throws `ApiError` |
| `GetPetData`, `GetPetResponses`, `GetPetErrors` | The same names |
| `types.gen.ts` in one file | `layout: single` for one file; `split` (default) for one file per operation and schema |

## Things that change

- Calls do not reject: handle `r.ok` and `r.kind`, or use `unwrap`.
- Enums are unions by default (`enumStyle: const` for objects).
- `readOnly`/`writeOnly` schemas get a `Writable` variant for requests.
- Dates stay strings (JSON has none); map formats to branded types with `typeMappings` if you want them distinct.
