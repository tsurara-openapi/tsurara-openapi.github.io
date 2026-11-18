---
title: "Plugins"
sourcePath: docs/guide/plugins.md
sourceHash: b6052c1d57c8
---

Hooks change what tsurara generates (see [Configuration](../configuration/#hooks)). The `extend` hook adds files next to the generated code: hooks for a data-fetching library, a client facade, documentation. It receives the names tsurara chose, so the added files refer to generated code without re-deriving names that collisions, reserved words and `naming.overrides` change.

## The `extend` hook

```yaml
hooks:
  extend: [node, scripts/hooks.mjs]
```

The command reads one JSON object on stdin:

| Field | |
|---|---|
| `language` | `typescript`, `python`, `rust`, `go`, or `external` |
| `model` | The model (versioned by `semVersion`) |
| `manifest` | What the backend generated, by name (below); `null` for external backends that return none |
| `common` | The common options of the target |
| `marker` | The first line every added file must start with |

and prints the files to add as `[{ "path": "...", "contents": "..." }]`. Paths are relative to the output directory. Each file must start with `marker`: tsurara then treats it as a generated file, deletes it when a later run no longer adds it, and `tsurara check` reports edits to it. A file without the marker, or with the path of a generated file, stops generation with an error.

## The manifest

```jsonc
{
  "manifestVersion": 1,
  "language": "typescript",
  "types": [{ "name": 3, "identifier": "ErrorModel", "file": "schemas/ErrorModel.ts" }],
  "operations": [{
    "operationId": "getPet",
    "kind": "operation",
    "function": { "identifier": "getPet", "file": "operations/getPet.ts" },
    "operationDef": { "identifier": "getPetDef", "file": "operations/getPet.ts" },
    "types": {
      "data": { "identifier": "GetPetData", "file": "operations/getPet.ts" },
      "result": { "identifier": "GetPetResult", "file": "operations/getPet.ts" }
    }
  }]
}
```

- `types` lists the schemas of the definition, in order; `name` is the declaration's id in `model.schemas` and `model.names`.
- `operations` lists the operations, then the webhooks (`kind: "webhook"`, without a function).
- `file` is the file that declares the identifier. Write the import your language needs: a relative specifier with the import extension of the target in TypeScript (`'../operations/getPet.js'` by default), a module path in Python (`from ..operations.get_pet import get_pet`), `crate::<module>::types::Pet` or `crate::<module>::operations::get_pet` in Rust, and nothing in Go (one package).

| Language | Roles in `types` | `operationDef` |
|---|---|---|
| TypeScript | `data`, `responses`, `errors`, `result`, `responseHeaders`, `event`, `item`; webhooks `request`, `responses` | `{name}Def` |
| Python | `result` | `DEF` |
| Rust | `options`, `body` (with several body media types) | — |
| Go | `options`, `body` | — |

`helpers` lists other values generated for an operation, by role: in TypeScript `queryKey`, `queryOptions`, `queryFilter`, `setQueriesData`, `getQueriesData`, `infiniteQueryKey` and `infiniteQueryOptions` for reads, `mutationOptions` for writes (with `query: tanstack`), and `mockHandler` (with `mocks`). A plugin that wraps them (hooks per operation, for example) finds their names and files there.

Put added files in their own directory (`hooks/`, `swr/`) so their names cannot collide with generated ones; in Go, which has one package, give added identifiers a prefix of their own.

## Example

One file per operation with a wrapper around the call function:

```js
// scripts/hooks.mjs
let input = '';
process.stdin.on('data', (c) => (input += c));
process.stdin.on('end', () => {
  const { manifest, marker } = JSON.parse(input);
  const js = (file) => `../${file.replace(/\.ts$/, '.js')}`;
  const files = manifest.operations
    .filter((op) => op.function)
    .map(({ function: fn, types }) => {
      const name = `use${fn.identifier[0].toUpperCase()}${fn.identifier.slice(1)}`;
      return {
        path: `hooks/${name}.ts`,
        contents: `${marker}

import type { Client } from '@tsurara/client';
import { ${fn.identifier} } from '${js(fn.file)}';
import type { ${types.data.identifier} } from '${js(types.data.file)}';

export const ${name} = (client: Client<unknown>, data: ${types.data.identifier}): ReturnType<typeof ${fn.identifier}> =>
  ${fn.identifier}(client, data);
`,
      };
    });
  process.stdout.write(JSON.stringify(files));
});
```

## Plugins in TypeScript

Hooks start a command per stage. A plugin module written with `@tsurara/plugin` takes part in any of the stages from one Node process per run, with typed inputs:

```yaml
plugins:
  - ./tsurara.plugin.ts
```

```ts
// tsurara.plugin.ts
import { definePlugin, ts, type TypeScriptTargetOptions } from '@tsurara/plugin';

export default definePlugin({
  name: 'swr-hooks',
  extend({ language, manifest, marker, options }) {
    if (language !== 'typescript' || manifest == null) return [];
    const target = options as TypeScriptTargetOptions;
    return manifest.operations.flatMap((op) => {
      if (op.function == null) return [];
      const f = ts.file(`extra/${op.function.identifier}.ts`, target);
      const fn = f.import(op.function); // `import { getPet } from '../operations/getPet.js'`
      f.line(`export { ${fn} };`);
      return [{ path: f.path, contents: f.render(marker) }];
    });
  },
});
```

- The module runs with Node 22.18 or later (type stripping), in the directory of the configuration; install `@tsurara/plugin` there. `tsurara init --plugin` writes this skeleton, and [examples/plugin-swr](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/examples/plugin-swr/tsurara.plugin.ts) writes an SWR hook per read operation.
- Stages: `transformDocument(document)`, `transformModel(model)`, `extend(input)` and `transformFiles(files)`; each returns its output, and may be async. Plugin modules run after the hooks of each stage.
- `ts.file(path, options)` collects imports: `import(export)` and `importType(export)` take entries of the manifest and write specifiers with the target's import extension; `importFrom`, `importTypeFrom` and `importDefault` take packages; `render(marker)` writes the file.
- Tests: `runPlugin(modulePath, { definition })` from `@tsurara/plugin/testing` runs tsurara (`TSURARA_BIN` or `tsurara` on the PATH) and returns the files by path.
- `{ module, runtime }` runs a module with another command, for plugin SDKs in other languages.

## Plugins in Python, Go and Rust

The same session runs plugins written with the other SDKs; `runtime` is the command that starts them (tsurara appends the module path):

| Language | SDK | Configuration |
|---|---|---|
| Python | `tsurara-plugin` ([packages/plugin-python](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/packages/plugin-python/README.md)) | `{ module: ./plugin.py, runtime: [python, -m, tsurara_plugin] }` |
| Go | `github.com/tsurara-openapi/tsurara/packages/plugin-go` ([packages/plugin-go](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/packages/plugin-go/README.md)) | `{ module: ./plugin, runtime: [go, -C, ./plugin, run, .] }`, or a built binary |
| Rust | the `tsurara-plugin` crate | `{ module: ./plugin/Cargo.toml, runtime: [cargo, run, --quiet, --manifest-path] }`, or a built binary |

Python and Go get their types of the model and the manifest from tsurara itself (generated from `spec/plugin-protocol.schema.json` with the Python and Go backends); the Rust crate uses the Rust types. Python's `PyFile` and Go's `NewFile` write files with imports (Go's formatted with `go/format`). `transformDocument` and `transformModel` take and return JSON in these SDKs, so nothing a newer tsurara adds is lost. The same plugin written with each SDK produces the same files (`crates/tsurara-cli/tests/plugin_sdks.rs`).

## External backends

A backend written as an external program (`language: { command: [...] }`) returns the manifest from `generate` when it speaks protocol 2 (design.md 18.11). With protocol 1, `extend` hooks receive `manifest: null`.
