---
title: "插件"
sourcePath: docs/guide/plugins.md
sourceHash: b6052c1d57c8
---

钩子可以改变 tsurara 生成的内容（参见[配置](../configuration/#hooks)）。`extend` 钩子会在生成的代码旁边添加文件：数据获取库的 hook、客户端门面、文档等。它会收到 tsurara 选定的名称，因此添加的文件引用生成的代码时，无需重新推导那些可能因冲突、保留字和 `naming.overrides` 而改变的名称。

## `extend` 钩子 {#the-extend-hook}

```yaml
hooks:
  extend: [node, scripts/hooks.mjs]
```

该命令从 stdin 读取一个 JSON 对象：

| 字段 | |
|---|---|
| `language` | `typescript`、`python`、`rust`、`go` 或 `external` |
| `model` | 模型（版本由 `semVersion` 表示） |
| `manifest` | 后端按名称列出的生成内容（见下文）；对于不返回清单的外部后端为 `null` |
| `common` | 目标的通用选项 |
| `marker` | 每个添加的文件都必须以此作为第一行 |

并以 `[{ "path": "...", "contents": "..." }]` 的形式打印要添加的文件。路径相对于输出目录。每个文件都必须以 `marker` 开头：这样 tsurara 会把它当作生成文件，在之后的运行不再添加它时将其删除，`tsurara check` 也会报告对它的修改。没有标记的文件，或路径与某个生成文件相同的文件，会使生成报错停止。

## 清单 {#the-manifest}

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

- `types` 按顺序列出定义中的 schema；`name` 是该声明在 `model.schemas` 和 `model.names` 中的 id。
- `operations` 先列出操作，再列出 webhook（`kind: "webhook"`，没有函数）。
- `file` 是声明该标识符的文件。请按语言编写所需的导入：TypeScript 中使用带目标导入扩展名的相对说明符（默认为 `'../operations/getPet.js'`），Python 中使用模块路径（`from ..operations.get_pet import get_pet`），Rust 中使用 `crate::<module>::types::Pet` 或 `crate::<module>::operations::get_pet`，Go 中则不需要（只有一个包）。

| 语言 | `types` 中的角色 | `operationDef` |
|---|---|---|
| TypeScript | `data`、`responses`、`errors`、`result`、`responseHeaders`、`event`、`item`；webhook 为 `request`、`responses` | `{name}Def` |
| Python | `result` | `DEF` |
| Rust | `options`、`body`（请求体有多种媒体类型时） | — |
| Go | `options`、`body` | — |

`helpers` 按角色列出为操作生成的其他内容：在 TypeScript 中，读取操作有 `queryKey`、`queryOptions`、`queryFilter`、`setQueriesData`、`getQueriesData`、`infiniteQueryKey` 和 `infiniteQueryOptions`，写入操作有 `mutationOptions`（需 `query: tanstack`），以及 `mockHandler`（需 `mocks`）。包装它们的插件（例如每个操作一个 hook）可以在这里找到它们的名称和文件。

请把添加的文件放在单独的目录中（`hooks/`、`swr/`），使其名称不会与生成的文件冲突；在只有一个包的 Go 中，请为添加的标识符加上自己的前缀。

## 示例 {#example}

为每个操作生成一个文件，其中包含对调用函数的包装：

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

## TypeScript 插件 {#plugins-in-typescript}

钩子会为每个阶段启动一个命令。用 `@tsurara/plugin` 编写的插件模块，每次运行只用一个 Node 进程即可参与任意阶段，并获得带类型的输入：

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

- 模块在 Node 22.18 或更高版本（类型剥离）下运行，工作目录为配置文件所在的目录；请在那里安装 `@tsurara/plugin`。`tsurara init --plugin` 会写入这个骨架，[examples/plugin-swr](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/examples/plugin-swr/tsurara.plugin.ts) 会为每个读取操作写入一个 SWR hook。
- 阶段：`transformDocument(document)`、`transformModel(model)`、`extend(input)` 和 `transformFiles(files)`；每个阶段返回其输出，并且可以是异步的。在每个阶段中，插件模块在钩子之后运行。
- `ts.file(path, options)` 收集导入：`import(export)` 和 `importType(export)` 接受清单中的条目，并写出带目标导入扩展名的说明符；`importFrom`、`importTypeFrom` 和 `importDefault` 接受包；`render(marker)` 写出文件。
- 测试：`@tsurara/plugin/testing` 中的 `runPlugin(modulePath, { definition })` 会运行 tsurara（`TSURARA_BIN` 或 PATH 上的 `tsurara`），并按路径返回文件。
- `{ module, runtime }` 用另一个命令运行模块，用于其他语言的插件 SDK。

## Python、Go 和 Rust 插件 {#plugins-in-python-go-and-rust}

同一个会话也能运行用其他 SDK 编写的插件；`runtime` 是启动它们的命令（tsurara 会在末尾追加模块路径）：

| 语言 | SDK | 配置 |
|---|---|---|
| Python | `tsurara-plugin`（[packages/plugin-python](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/packages/plugin-python/README.md)） | `{ module: ./plugin.py, runtime: [python, -m, tsurara_plugin] }` |
| Go | `github.com/tsurara-openapi/tsurara/packages/plugin-go`（[packages/plugin-go](https://github.com/tsurara-openapi/tsurara/blob/c5cc557cdb42c8f28966541163492b2cf79bd296/packages/plugin-go/README.md)） | `{ module: ./plugin, runtime: [go, -C, ./plugin, run, .] }`，或构建好的二进制文件 |
| Rust | `tsurara-plugin` crate | `{ module: ./plugin/Cargo.toml, runtime: [cargo, run, --quiet, --manifest-path] }`，或构建好的二进制文件 |

Python 和 Go 的模型与清单类型由 tsurara 自身生成（使用 Python 和 Go 后端，从 `spec/plugin-protocol.schema.json` 生成）；Rust crate 使用 Rust 类型。Python 的 `PyFile` 和 Go 的 `NewFile` 会写出带导入的文件（Go 的文件用 `go/format` 格式化）。在这些 SDK 中，`transformDocument` 和 `transformModel` 接收并返回 JSON，因此新版 tsurara 添加的内容不会丢失。用各个 SDK 编写的同一个插件会生成相同的文件（`crates/tsurara-cli/tests/plugin_sdks.rs`）。

## 外部后端 {#external-backends}

以外部程序形式编写的后端（`language: { command: [...] }`）在使用协议 2 时，会从 `generate` 返回清单（design.md 18.11）。使用协议 1 时，`extend` 钩子收到的是 `manifest: null`。
