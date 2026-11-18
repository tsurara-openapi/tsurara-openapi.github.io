---
title: "プラグイン"
sourcePath: docs/guide/plugins.md
sourceHash: 82eef03caa8c
---

フックは、tsuraraが生成する内容を変えます（[設定](../configuration/#hooks)を参照）。`extend` フックは生成コードの隣にファイルを追加します。データ取得ライブラリ向けのフック、クライアントのファサード、ドキュメントなどです。このフックはtsuraraが選んだ名前を受け取るので、追加するファイルは生成コードを参照するときに名前を導き直す必要がありません。名前は衝突、予約語、`naming.overrides` によって変わることがあります。

## `extend` フック {#the-extend-hook}

```yaml
hooks:
  extend: [node, scripts/hooks.mjs]
```

コマンドは標準入力から1つのJSONオブジェクトを読みます。

| フィールド | |
|---|---|
| `language` | `typescript`、`python`、`rust`、`go`、または `external` |
| `model` | モデル（`semVersion` でバージョンを示します） |
| `manifest` | バックエンドが生成したものを名前で示したもの（後述）。マニフェストを返さない外部バックエンドでは `null` |
| `common` | ターゲットの共通オプション |
| `marker` | 追加するファイルがすべて最初の行に持つべき行 |

そして、追加するファイルを `[{ "path": "...", "contents": "..." }]` の形で出力します。パスは出力先ディレクトリからの相対パスです。各ファイルは `marker` で始めなければなりません。するとtsuraraはそれを生成ファイルとして扱い、後の実行で追加されなくなれば削除し、`tsurara check` はそのファイルへの編集を報告します。目印のないファイルや、生成ファイルと同じパスのファイルがあると、生成はエラーで止まります。

## マニフェスト {#the-manifest}

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

- `types` は定義のスキーマを順に並べたものです。`name` は `model.schemas` と `model.names` における宣言のIDです。
- `operations` は操作を並べ、そのあとにwebhook（`kind: "webhook"`、関数なし）を並べます。
- `file` は識別子を宣言しているファイルです。importは言語に合わせて書いてください。TypeScriptではターゲットのimportの拡張子を付けた相対指定子（デフォルトでは `'../operations/getPet.js'`）、Pythonではモジュールのパス（`from ..operations.get_pet import get_pet`）、Rustでは `crate::<module>::types::Pet` や `crate::<module>::operations::get_pet`、Goでは何も要りません（1つのパッケージのため）。

| 言語 | `types` の役割 | `operationDef` |
|---|---|---|
| TypeScript | `data`、`responses`、`errors`、`result`、`responseHeaders`、`event`、`item`。webhookでは `request`、`responses` | `{name}Def` |
| Python | `result` | `DEF` |
| Rust | `options`、`body`（本文のメディアタイプが複数あるとき） | — |
| Go | `options`、`body` | — |

`helpers` は、操作のために生成されたそのほかの値を役割ごとに並べます。TypeScriptでは、読み取りの操作に `queryKey`、`queryOptions`、`queryFilter`、`setQueriesData`、`getQueriesData`、`infiniteQueryKey`、`infiniteQueryOptions`、書き込みの操作に `mutationOptions`（`query: tanstack` のとき）、そして `mockHandler`（`mocks` のとき）があります。これらを包むプラグイン（操作ごとのフックなど）は、ここでその名前とファイルを見つけられます。

追加するファイルは専用のディレクトリ（`hooks/`、`swr/`）に置き、生成ファイルと名前が衝突しないようにしてください。パッケージが1つしかないGoでは、追加する識別子に独自の接頭辞を付けてください。

## 例 {#example}

操作ごとに1ファイル、呼び出し関数を包む関数を書き出します。

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

## TypeScriptのプラグイン {#plugins-in-typescript}

フックは段階ごとにコマンドを起動します。`@tsurara/plugin` で書いたプラグインモジュールは、1回の実行につき1つのNodeプロセスで、型付きの入力を受け取り、どの段階にも参加できます。

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

- モジュールはNode 22.18以降（型ストリッピング）で、設定ファイルのあるディレクトリで実行されます。`@tsurara/plugin` はそこにインストールしてください。`tsurara init --plugin` がこのひな形を書き込みます。[examples/plugin-swr](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/examples/plugin-swr/tsurara.plugin.ts)は、読み取りの操作ごとにSWRのフックを書き出す例です。
- 段階は `transformDocument(document)`、`transformModel(model)`、`extend(input)`、`transformFiles(files)` です。それぞれ出力を返し、非同期にもできます。プラグインモジュールは、各段階でフックのあとに実行されます。
- `ts.file(path, options)` はimportを集めます。`import(export)` と `importType(export)` はマニフェストのエントリを受け取り、ターゲットのimportの拡張子を付けた指定子を書きます。`importFrom`、`importTypeFrom`、`importDefault` はパッケージを受け取ります。`render(marker)` がファイルを書き出します。
- テスト：`@tsurara/plugin/testing` の `runPlugin(modulePath, { definition })` はtsurara（`TSURARA_BIN` か、PATH上の `tsurara`）を実行し、ファイルをパスごとに返します。
- `{ module, runtime }` は、モジュールを別のコマンドで実行します。ほかの言語のプラグインSDK向けです。

## Python、Go、Rustのプラグイン {#plugins-in-python-go-and-rust}

同じセッションで、ほかのSDKで書いたプラグインも実行できます。`runtime` はそれらを起動するコマンドです（tsuraraが末尾にモジュールのパスを付け足します）。

| 言語 | SDK | 設定 |
|---|---|---|
| Python | `tsurara-plugin`（[packages/plugin-python](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/packages/plugin-python/README.md)） | `{ module: ./plugin.py, runtime: [python, -m, tsurara_plugin] }` |
| Go | `github.com/tsurara-openapi/tsurara/packages/plugin-go`（[packages/plugin-go](https://github.com/tsurara-openapi/tsurara/blob/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/packages/plugin-go/README.md)） | `{ module: ./plugin, runtime: [go, -C, ./plugin, run, .] }`、またはビルド済みのバイナリ |
| Rust | `tsurara-plugin` クレート | `{ module: ./plugin/Cargo.toml, runtime: [cargo, run, --quiet, --manifest-path] }`、またはビルド済みのバイナリ |

PythonとGoのモデルとマニフェストの型は、tsurara自身が生成しています（PythonとGoのバックエンドで `spec/plugin-protocol.schema.json` から生成）。RustのクレートはRustの型を使います。Pythonの `PyFile` とGoの `NewFile` は、importを含むファイルを書き出します（Goのものは `go/format` で整形されます）。これらのSDKでは `transformDocument` と `transformModel` がJSONを受け取って返すので、新しいtsuraraが追加した内容も失われません。同じプラグインをどのSDKで書いても、同じファイルが生成されます（`crates/tsurara-cli/tests/plugin_sdks.rs`）。

## 外部バックエンド {#external-backends}

外部プログラムとして書いたバックエンド（`language: { command: [...] }`）は、プロトコル2を話す場合、`generate` からマニフェストを返します（design.md 18.11）。プロトコル1では、`extend` フックは `manifest: null` を受け取ります。
