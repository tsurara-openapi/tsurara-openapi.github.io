---
title: "设计"
sourcePath: docs/design.md
sourceHash: faa01e846180
---

本文档描述 tsurara 的设计。tsurara 是一个根据 OpenAPI 定义生成 TypeScript 类型和 API 调用函数的工具。

- 状态：实现中
- 最后更新：2026-11-10

tsurara 正在重构，以生成多种语言，而不仅仅是 TypeScript。目标架构见第 18 章；凡是与第 4、6、7、10、11 章不同之处，这些章节描述的是当前的实现。

## 1. 目的 {#1-purpose}

从 OpenAPI 生成 TypeScript 的工具中，没有事实上的标准。现有的成熟工具存在一些问题：从复杂的 schema 生成错误的类型、在大型定义上拖慢类型检查、把序列化写进生成的代码等（第 3 章）；tsurara 之所以存在，是因为输出中的这些问题，而不是因为其他项目的状况。

生成器用 Rust 编写，以单个二进制文件发布；生成的代码所使用的运行时库以 npm 包 `@tsurara/client` 发布。

## 2. 需求 {#2-requirements}

| # | 需求 |
|---|---|
| R1 | 用 Rust 实现生成器 |
| R2 | 在 pnpm workspace 的 monorepo 中，多个应用可以共享同一份生成结果。每个应用可以各自调整日志、追踪、连接时的请求头等 |
| R3 | 生成的代码满足 TypeScript 的 `erasableSyntaxOnly` |
| R4 | 把输出拆分为多个文件，使 Git 冲突不容易发生 |
| R5 | 覆盖 OpenAPI 规范（3.0、3.1、3.2；2.0 会转换为 3.0，见 5.4） |
| R6 | 定义既可以从本地文件加载，也可以从 URL 加载 |
| R7 | 不仅生成类型，还为每个操作生成调用函数 |
| R8 | 从同一份定义生成其他语言，每种语言都先有类型，再有调用函数和运行时库（第 18 章） |

R7 意味着 tsurara 不采用通过 `client.GET('/pet/{id}', ...)` 这类泛型函数推断类型的方式。这种方式会让推断变得沉重，也很难取出返回值的类型。tsurara 为每个操作生成一个具有具体参数和返回值类型的函数。

## 3. 现有工具的问题与 tsurara 的做法 {#3-problems-with-existing-tools-and-tsuraras-approach}

下表把对现有工具的主要抱怨与 tsurara 针对每一点的做法对应起来。详细内容在括号中的章节里。

| 现有工具的问题 | tsurara 的做法 |
|---|---|
| `allOf`/`oneOf`/discriminator/nullable/循环会产生错误或无效的类型 | 在输出之前在中间表示（IR）中进行规范化（6.3）。把转换规则固定为映射表，并测试每一行（6.4、13） |
| 意外出现的 `unknown` 或 `Record<string, never>` | 用映射表决定输出，并把近似作为警告报告（6.4、6.8） |
| 输出随顺序或位置而变化。交叉类型难以阅读 | 展平 allOf，让含义相同的 schema 产生相同的输出（6.3） |
| 在大型定义上 IntelliSense 很慢。出现 “excessively deep” 错误 | 不构建对巨大类型进行索引访问的结构。把 Result 类型输出为展开的联合类型（7.4） |
| `text/plain` 等被当作 JSON 解析，在运行时崩溃 | 根据定义中的媒体类型自动决定如何解析响应（parseAs）（8.5） |
| 生成的代码无法编译 | 在 CI 中运行测试，把大型真实定义和边界情况定义的输出用多种 tsconfig 交给 `tsc` 检查（13） |
| `@type` 变成 `_type`。保留字产生无效类型。大小写设置意外改变名称 | 不转换属性名，而是加引号。标识符统一经过一个清理函数。默认不转换 schema 名称（6.6） |
| 生成的 multipart 代码中的缺陷，例如重复的 `formData.append` | 不在生成的代码中编写 multipart 的构建逻辑，而是放在运行时库中（8.5） |
| 只能在生成后用正则表达式做后处理 | 让插件可以挂接到 IR（11） |
| 结果依赖于插件的注册顺序 | 插件声明其挂接的阶段，不依赖注册顺序（11） |
| `throwOnError` 抛出原始 JSON，丢失了状态码 | `unwrap()` 抛出继承自 `Error` 的 `ApiError`（8.3） |
| bigint 和 Date 类型与运行时的值不符 | 拒绝与运行时的值不一致的类型映射（10.4） |
| 无法在运行时检测与规范的偏差 | 校验不在最初的范围内，但能检测到的偏差会作为 Result 返回（8.2）。`kind: 'validation'` 为将来的校验保留 |
| 主版本更新会改变行为 | 明确说明稳定性承诺覆盖哪些内容，并且只在 semver 主版本中改变它们（14） |

## 4. 整体结构 {#4-overall-structure}

### 4.1 仓库结构 {#41-repository-layout}

```
crates/
  tsurara-loader     加载定义、解析 $ref、规范化 Swagger 2.0
  tsurara-sem        把定义分析为模型（不含 I/O 的纯转换）
  tsurara-backend    面向各语言代码生成器的接口，以及插件
  tsurara-lang-typescript  生成 TypeScript 类型、OperationDef 和函数
  tsurara-config     加载配置文件（extends、targets）
  tsurara-cli        tsurara 命令（generate / check / init）
runtimes/
  typescript      @tsurara/client（生成的 TypeScript 所使用的运行时库）
packages/
  tsurara            用于分发 CLI 的 npm 包装
spec/
  operation-def.schema.json  所有运行时共享的 OperationDef 格式
  conformance/    所有运行时都要运行的请求和响应向量（18.9）
schema/
  tsurara.config.schema.json   配置文件的 JSON Schema（用于编辑器补全）
examples/
  pnpm-monorepo   apps/app-1 和 app-2 共享 packages/openapi 的示例。兼作 E2E 测试
docs/
  design.md       本文档
```

`packages/tsurara` 与 biome 一样，通过 `optionalDependencies` 分发各平台的二进制文件。

### 4.2 处理流程 {#42-processing-flow}

```
输入（文件 / URL）
  → tsurara-loader：加载、收集外部 $ref、转换 Swagger 2.0 → 3.0
  → 插件（document 阶段）
  → tsurara-sem，然后是后端（tsurara-lang-typescript）
      ① 分析：解析 $ref、判别字段、readOnly/writeOnly
      ② 构建规范化的 IR
      → 插件（IR 阶段）
      ③ 输出：按文件生成代码
  → 插件（files 阶段）
  → tsurara-cli：写入、删除过时的生成文件、afterWrite 钩子
```

tsurara-sem 和各后端不做任何 I/O。其输入是已加载的 `DocumentSet`，输出是路径与内容的列表。作为 Rust 库嵌入时，它执行与 CLI 完全相同的转换。

## 5. 加载（tsurara-loader） {#5-loading-tsurara-loader}

### 5.1 输入来源 {#51-input-sources}

输入可以是本地路径、`http(s)://` 或 `file://`。HTTP 可以指定认证请求头和超时。请求头只发送到根定义的源。加载器自己跟随重定向（最多 10 次），当重定向离开该源时去掉请求头，并拒绝重定向到 `http(s)` 以外的地址。

网络访问位于 `Fetcher` trait 之后。默认实现处理文件读取和 HTTP（ureq）。作为 Rust 库嵌入时，可以替换为自定义的 HTTP 栈或缓存。对于不需要 HTTP 的用户，可以通过 Cargo 特性移除 HTTP 支持。

### 5.2 格式检测 {#52-format-detection}

如果内容以 `{` 或 `[` 开头，就按 JSON 读取，失败时再按 YAML 读取。`200:` 这类数字 YAML 键会被转换为字符串。YAML 合并键（`<<`）也会展开。别名会展开为副本，因此对它们增加的节点数设有上限（一百万，或每个 YAML 事件 100 个，取较大者）；含有嵌套别名的文档（“billion laughs”）会以解析错误失败，错误中会指出上限和别名所在的行。

### 5.3 $ref 解析 {#53-ref-resolution}

从根定义出发跟随 `$ref`，把所有被引用的外部定义加载到 `DocumentSet` 中。定义中的位置用文档 URL 和 JSON Pointer 的组合（`Loc`）表示。相对引用按 URL 的拼接规则解析。

在 3.1 中遵循 JSON Schema 2020-12，对 `$id`、`$anchor` 和 `$dynamicAnchor` 建立索引，使它们可以作为引用目标被查找。

通过 HTTP 获取的定义不能引用本地文件：只有当本地文档引用 `file://` 文档时才会加载它，来自远程文档的引用（无论是直接引用还是通过 `$id`）会在解析时失败，并说明原因。否则，供应商的定义就可能把生成机器上的文件内容放进输出中。远程定义仍然可以引用其他 HTTP 地址；目前还没有主机白名单。

加载外部定义失败时，当时不会报错。只有在实际解析指向它的引用时才会报错。这样，加载不会仅仅因为某个示例值中含有名为 `$ref` 的键而停止。

### 5.4 Swagger 2.0 规范化 {#54-swagger-20-normalization}

Swagger 2.0 定义在交给 tsurara-sem 之前会转换为 OpenAPI 3.0，这样 tsurara-sem 只需处理 3.x。转换包括以下内容。

- 把 `definitions` / `parameters` / `responses` 移到 `components` 下，并改写 `$ref`
- 把 `in: body` 参数转换为 `requestBody`，把 `in: formData` 参数转换为 multipart 或 urlencoded 的 `requestBody`
- 根据 `produces` / `consumes` 决定媒体类型
- 根据 `host` / `basePath` / `schemes` 构建 `servers`
- 把 `securityDefinitions` 转换为 `securitySchemes`
- 把 `x-nullable` 转换为 `nullable`，把 `type: file` 转换为 `type: string, format: binary`

对 2.0 的支持在最初的范围内。许多现有定义仍然是 2.0，而把转换限制在加载器内部，就不会影响代码生成。

## 6. 代码生成（tsurara-sem 与 tsurara-lang-typescript） {#6-code-generation-tsurara-sem-and-tsurara-lang-typescript}

### 6.1 三个阶段 {#61-three-stages}

把 OpenAPI schema 直接写成 TypeScript，会把 schema 写法上的差异原样带入输出。代码生成分为三个阶段：分析、规范化的 IR 和输出。

1. 分析：解析 `$ref`，找出判别字段之间的关系，以及是否存在 readOnly/writeOnly。
2. 规范化的 IR：构建接近 TypeScript 类型的中间表示，把含义相同的 schema 变成相同的形状。
3. 输出：根据 IR 写出类型、OperationDef 和函数，并把它们分配到文件中。

### 6.2 支持的规范 {#62-supported-specification}

| 版本 | 主要项目 |
|---|---|
| 3.0 | `nullable`、discriminator（包括 `oneOf` 一侧和通过 `allOf` 继承的一侧）、`readOnly`/`writeOnly` |
| 3.1 | `type` 数组、`const`、`prefixItems`（元组）、`$defs`、带兄弟键的 `$ref`、`contentMediaType`/`contentEncoding`、webhook、`$dynamicRef` |
| 3.2 | `query` 方法、`additionalOperations`、`in: querystring`、`itemSchema`（顺序媒体类型）、`discriminator.defaultMapping` |
| 全部 | 参数（path/query/header/cookie，与路径级参数合并，用 `content` 指定）、多种媒体类型、响应头、`default` 和 `2XX` 形式的状态码、回调、servers、JSDoc（description、deprecated、default、example、format 以及各种约束） |
| 扩展 | `x-event-channels`：不是某个操作的响应的消息，例如 hub 的更新（8.8） |

在初始版本中，`$dynamicRef` 在每个引用位置静态解析，并输出为具体类型（例如 `PetPage`）。输出 `Page<T>` 这样的泛型类型留待将来。

### 6.3 规范化 {#63-normalization}

构建规范化的 IR 时会进行以下处理。

- 展平 allOf：无名对象的成员合并为一个对象字面量。具名类型（`$ref`）保留为交叉类型，但一个交叉类型中最多包含一个对象字面量。输出形如 `Base & { a: string; b: number }`。只有以不同类型出现的属性，才会在该属性上保留交叉类型。
- 整理联合类型：展平嵌套并去除重复。包含 `unknown` 的联合类型变为 `unknown`，`never` 会被去除。
- 统一 nullable：3.0 的 `nullable: true`、3.1 的 `type: [..., 'null']`，以及包含 `type: 'null'` 的 `oneOf`，都会变为 `X | null`。3.0 中写在 `$ref` 旁边的 `nullable: true` 按规范被忽略。由于这种写法在真实定义中很常见，会给出警告说明已忽略（6.8），并建议改写为 `allOf: [{ $ref }]` 加 `nullable: true` 来允许 `null`。
- 顺序：属性保持其在定义中的顺序，因为这个顺序对可读性很重要。另一方面，`required` 的顺序和 allOf 成员的顺序不会影响输出。

### 6.4 类型映射表 {#64-type-mapping-table}

从 schema 到类型的转换规则由下表固定，每一行都是一个测试。

| Schema | 输出 |
|---|---|
| `{}` / `true` | `unknown` |
| `false` | `never` |
| 没有属性也没有 `additionalProperties` 的 `type: object` | `{ [key: string]: unknown }` |
| 没有属性且 `additionalProperties: false` | `{ [key: string]: never }`（仅此情况） |
| 有属性，没有 `additionalProperties` | 没有索引签名 |
| 有属性，`additionalProperties` 带有 schema | 索引值的类型是该 schema 与所有属性类型的联合 |
| `patternProperties` | 索引签名（值为各模式类型的联合） |
| `enum` | 字面量类型的联合 |
| `const` | 字面量类型 |
| `prefixItems` | 元组。每个元素都是可选的（`[string?, number?]`），`minItems` 以内的元素是必需的。如果 `items` 带有 schema，它就是剩余元素的类型；没有 `items` 时追加 `...unknown[]`；`items: false` 时不允许剩余元素 |
| 作为 HTTP 请求/响应体本身或 multipart 部分值的 `format: binary` 字符串，或没有 `contentEncoding` 的 `contentMediaType` | `Blob \| File` |
| JSON 值内部的 `type: string`（即使带有 `contentMediaType`、`contentEncoding` 或 `format: binary`） | `string`。`contentMediaType` 等写在 JSDoc 中。`format: binary` 无法在 JSON 中表示，因此当它出现在 JSON 值内部（而不是声明的根部或非 JSON 的请求/响应体）时会给出警告 |
| 循环 | 总是经过具名类型。内联的自引用会被提升为具名类型 |
| TypeScript 无法表达的关键字（例如 `not`） | 只舍弃该关键字，用剩余的关键字构建类型；没有剩余时为 `unknown`。两种情况都会给出警告 |

同时存在属性和 `additionalProperties` 时取联合，是因为 `{ a: string; [key: string]: number }` 在 TypeScript 中是错误。

`prefixItems` 的元素是可选的，因为在 JSON Schema 中，`prefixItems` 只决定“从开头起依次存在的元素的类型”，而不决定元素的个数。只有 `prefixItems: [string, number]` 和 `items: false` 时，`[]` 和 `["a"]` 都是有效值。因此输出为 `[string?, number?]`，有 `minItems: 2` 时为 `[string, number]`。如果 `maxItems` 小于 `prefixItems` 的个数，元素会被截断到该数量。

以下两种情况也可以在 TypeScript 中精确表达。当 `minItems` 超过 `prefixItems` 的个数时，可以把剩余元素的类型作为必需元素添加（`[string, number, boolean, ...boolean[]]`）。当 `items` 带有 schema 且 `maxItems` 设定了上限时，可以列出直到上限的可选元素（`[string?, boolean?, boolean?]`）。但是，数字较大时元组会变长，增加输出体积和类型检查成本。因此初始版本对这两种情况都用剩余元素类型（`...T[]`）近似，并把约束保留在 JSDoc 中。

- 当 `minItems` 超过 `prefixItems` 的个数时
- 当 `items` 带有 schema 且 `maxItems` 设定了上限时

任何值都无法满足的组合会变为 `never`。即 `minItems` 大于 `maxItems`，以及 `items: false` 且 `minItems` 超过 `prefixItems` 的个数。

IR 中的元组除了元素类型列表外，还保存必需元素的个数（028 中的工作）。

一个值是否为二进制取决于它出现的位置。在 JSON 中声明为 `type: string` 的值以 JSON 字符串的形式到达，因此即使带有 `contentMediaType: text/html` 或 `format: binary`，它也是 `string`。只有请求或响应体本身（`application/octet-stream` 等）以及 multipart 部分的值才会变为 `Blob | File`。部分的值是指 multipart 请求体 schema 的顶层属性以及其中数组的条目，并会跟随 `$ref`。如果一个具名对象 schema 的所有用途（所有文档中的所有 `$ref` 和判别映射）都是 multipart 请求体，它就以部分值的形式声明，这些请求体引用它。其他任何具名 schema 都按 JSON 值转换，因此无论它在 JSON 中的何处使用，其类型都是正确的。当 multipart 请求体引用这样的 schema 且该 schema 含有二进制部分值时，请求体类型不再引用它，而是把它内联展开，并把这些部分设为 `Blob | File`；具名类型不会改变，也不会输出错误的类型（在 029 中决定）。

#### 6.4.1 哪些精确、哪些近似、哪些拒绝 {#641-what-is-exact-what-is-approximated-and-what-is-rejected}

TypeScript 类型无法表达所有约束。对每个关键字，tsurara 都预先决定以下四种处理方式中的哪一种。不会因为一个无法表达的约束就让整个类型变成 `unknown`，而丢掉已知的部分。

| 处理方式 | 示例 | 输出与通知 |
|---|---|---|
| 精确表达 | `type`、`enum`、`const`、`required`、nullable、`properties`、`allOf` 中的属性组合、`prefixItems`（6.4 中的规则，但 `minItems` 超过 `prefixItems` 个数的情况，以及 `items` schema 与 `maxItems` 的组合除外） | 仅凭类型即可表达 |
| 用更宽的类型近似 | 6.4 中近似处理的两种 `prefixItems` 长度约束、`oneOf` 的互斥性（TypeScript 联合类型也接受匹配多个成员的值）、`patternProperties` 的模式、属性与 `additionalProperties` 的组合（6.4）、字符串和数字约束（`minLength`、`pattern`、`minimum` 等）、`uniqueItems` | 类型也会接受一些定义不允许的值。这经常发生，因此不给出警告；约束写在 JSDoc 中，本文档的表格会说明它是近似 |
| 舍弃关键字来近似 | `not`、`if`/`then`/`else`、`dependentSchemas`、无法解析的引用、静态解析的 `$dynamicRef`、被忽略的 `$ref` 兄弟键 | 给出警告（6.8）。CI 可以把警告视为错误 |
| 拒绝 | 与运行时的值不一致的类型映射（10.4） | 生成报错停止 |

类型的正确性不仅通过输出能通过 `tsc` 来检查，还通过接受定义允许的值、拒绝定义不允许的值来检查（第 13 章）。因近似而被接受的值在测试中会被标记为近似。

### 6.5 discriminator 与 readOnly/writeOnly {#65-discriminator-and-readonlywriteonly}

discriminator：当 `oneOf`/`anyOf` 带有判别字段时，每个成员都会获得作为字面量类型的判别属性（`({ petType: 'cat' } & Cat) | ...`）。值来自 `mapping`，不在 `mapping` 中时使用 schema 名称。已经只用这些值要求该属性（必需的 `const`）的成员保持不变，因为求交不会带来任何变化。当子 schema 通过 `allOf` 引用父 schema 且父 schema 带有判别字段时，子类型也会获得相同的字面量。在父 schema 用 `oneOf` 列出子 schema、而每个子 schema 又通过 `allOf` 引用父 schema 的循环中，子 schema 一侧只展开不含 `oneOf` 的父 schema，以避免类型循环引用错误。

判别字段不会改变校验结果（OpenAPI 3.1.1 中的 Discriminator Object），校验父 schema 时也不会去寻找子 schema。因此 tsurara 只为判别属性添加字面量类型，而不会把父类型替换为子类型的联合。在父 schema 带有判别字段、子 schema 只是通过 `allOf` 引用父 schema 的定义中，响应类型保持为父类型，无法收窄为子类型。要收窄，请在定义的父 schema 中用 `oneOf` 列出子 schema。

readOnly/writeOnly：对于带有其中之一的 schema（包括通过引用目标带有的情况），除原类型外还会生成 `PetWritable`。原类型用于响应，并去掉 writeOnly 属性。`Writable` 类型用于请求，并去掉 readOnly 属性。两者都没有的 schema 不会生成 `Writable` 类型。这种拆分可以在配置中关闭，此时会忽略 readOnly/writeOnly，只输出一个类型。

一个 schema 是否带有 readOnly/writeOnly，在整个引用图上判断。对于相互引用（例如 A 引用 B、B 引用 A），会按强连通分量反复计算，直到结果不再变化。检查过程中的临时结果不能被当作最终结果。若以临时结果定论，相互引用另一侧的 readOnly 属性就会残留在请求类型中（030 中的工作）。

只要给 schema 添加一个 readOnly 属性，引用它的请求一侧的类型名就会从 `X` 变为 `XWritable`。这符合命名规则，但对用户代码来说是破坏性变更（第 14 章）。

### 6.6 命名 {#66-naming}

- 属性名：不转换。不能作为标识符的名称会加引号（`'@type'`）。
- 类型名和函数名：全部经过同一个清理函数。与保留字以及生成代码所用的 TypeScript 全局名称（`Date`、`Error`、`Blob`、`File`、`Record` 等）的冲突按固定规则避开。只有大小写不同的名称也视为冲突，以防止在不区分大小写的 macOS 文件系统上文件名相撞。
- Schema 名称：如果是有效标识符就保持不变。转换为驼峰等是可选的。
- 函数名：根据 `operationId` 构建；没有 `operationId` 时根据方法和路径构建。
- 解决冲突：名称按定义中的顺序分配，因此同一份定义总是得到相同的名称。自动选择的名称可以通过配置中的 `naming.overrides` 固定。

把内联 schema 变成具名类型的后端（TypeScript 以外）按 18.4.2 所述，从所有者和路径推导名称；由于候选名称最后才命名，添加内联 schema 永远不会改变声明的名称。

与保留字或全局名称冲突的名称会加上后缀 `Model`（`Error` → `ErrorModel`，`Date` → `DateModel`）。如果加了后缀的名称仍与其他名称冲突，则追加 `2`、`3` 等。被避开的冲突会作为警告报告（6.8），并且可以用 `naming.overrides` 把名称固定为其他名称。

当从操作派生的类型名（`{P}Data`、`{P}Responses`、`{P}Errors`、`{P}Result`、`{P}ResponseHeaders`、`{}Def`，以及 webhook 和回调的类型）已被占用（通常是被某个 schema 占用）时，schema 保留其名称，只有这个派生名称让开：在后缀前加上 `Operation`（`ListPetsOperationResult`），若仍被占用则再加编号。函数名和其他派生名称保持不变，因此添加名为 `ListPetsResult` 的 schema 永远不会把函数 `listPets` 变成 `listPets2`。`renamed` 警告会指出双方，`naming.overrides` 可以选择其他名称。这参考了 kubb 的冲突检测（跨种类时使用有语义的后缀，同一种类内使用编号）。最初的策略是报错停止生成；OpenAI 的定义中有十处这样的冲突（`UsageCompletionsResult` 既是一个 schema，又是 `usageCompletions` 的结果），因此在 064 中做了修改。

关于名称，确定性和稳定性分开考虑。

- 确定性：同一份定义和配置总是得到相同的名称。tsurara 始终保证这一点。
- 稳定性：向定义中添加项目时，已有的名称不变。为保留字和全局名称添加的 `Model` 后缀只取决于名称本身，因此是稳定的。另一方面，为只有大小写不同的名称或重复名称追加的编号取决于定义中的顺序。添加项目可能会改变已有的名称，此时会给出警告。需要固定的名称用 `naming.overrides` 指定。记录已分配名称的锁文件仍是一个可选方案（第 16 章）。

### 6.7 类型检查性能 {#67-type-checking-performance}

类型计算在生成器中完成，而不是交给 TypeScript 的类型系统。

- 不构建对巨大类型进行索引访问的结构，例如 `paths['/x']['get']['responses'][200]['content']['application/json']`。
- Result 类型输出为展开的联合类型，而不是用泛型构建。这样悬停时易读，也没有实例化成本。
- 每个函数都有显式的返回类型。这满足 `isolatedDeclarations`，也能加快使用项目引用时的类型检查。
- 不生成条件类型或递归的映射类型。

### 6.8 警告 {#68-warnings}

`tsurara generate` 会用 JSON Pointer 报告近似转换的位置（用 `unknown` 替代、静态解析了无法解析的 `$dynamicRef`、忽略了 `$ref` 的兄弟键等）。这样用户就知道该去定义中的哪里查看，以了解某个类型为何变成了 `unknown`。哪些近似会产生警告遵循 6.4.1 中的表。

| 代码 | 含义 |
|---|---|
| `unsupported` | 舍弃了模型无法表示的关键字，或某个值不可能符合定义 |
| `dynamic-ref` | 在每个引用位置静态解析了 `$dynamicRef` |
| `renamed` | 为避免冲突而更改了名称 |
| `unresolved-ref` | 无法解析引用，变成了 `unknown` |
| `invalid-definition` | 定义的形状出乎意料，已尽可能地解释 |
| `ignored-sibling` | 忽略了 `$ref` 旁边的关键字（OpenAPI 3.0） |
| `wildcard-media-type` | 通配媒体类型带有非二进制的 schema |
| `unmapped-type` | 映射的类型没有该语言的条目 |
| `sample-cycle` | 示例值（18.7.1）：必需属性引用回了它自己的声明 |
| `sample-pattern` | 示例值：有 `pattern` 但没有 `example` |

`tsurara inspect warning <code>` 会打印每个代码的含义以及解决方法；说明位于 `WarningKind::explanation` 中，并有测试检查每个代码都在本表中。

## 7. 输出 {#7-output}

### 7.1 文件布局 {#71-file-layout}

```
src/generated/
  schemas/Pet.ts               每个 schema 一个文件（仅类型）
  operations/getPetById.ts     每个操作一个文件（类型、OperationDef、函数）
  webhooks/newPet.ts           每个 webhook 一个文件
  client.ts                    ClientOptions（根据 servers 构建的 baseUrl 类型）
  index.ts                     barrel（每个文件一行）
  zod/Pet.ts                   使用 `typescript.validators: zod` 时（8.7）；不在 barrel 中
  query/getPetById.ts          使用 `typescript.query: tanstack` 时（9.4）；不在 barrel 中
  channels/board.ts            `x-event-channels` 的每个事件 channel 一个文件（8.8）；不在 barrel 中
  mocks/                       使用 `typescript.mocks: msw | fetch` 时（8.9）；不在 barrel 中
  _runtime/                    使用 `runtime: vendor` 时（7.5）：`@tsurara/client` 的副本
```

回调与拥有它们的操作输出在同一个文件中。

可选地，`tags` 布局把操作按标签合并为一个文件，`single` 布局把所有内容放在一个文件中。默认是上面的 `split` 布局。也可以输出供通用客户端使用的聚合映射（`paths.ts`、`operations.ts`），但默认不输出。

### 7.2 减少冲突 {#72-making-conflicts-unlikely}

- schema 和操作各自有自己的文件，因此对不同 API 的修改不会落在同一个文件中。
- 像 barrel 这样列出多个项目的文件，每行一个项目，并按固定顺序排列。
- 输出中不包含时间戳或生成器版本。
- 同一份定义和配置总是得到逐字节相同的输出。

重新生成时，只删除带有生成文件头、且本次没有生成的旧文件。

### 7.3 支持 erasableSyntaxOnly {#73-supporting-erasablesyntaxonly}

- 不输出 `enum`、`namespace` 或构造函数参数属性。
- 枚举默认是字符串字面量的联合类型。可选地，可以输出 `export const PetStatus = { ... } as const` 和 `export type PetStatus = (typeof PetStatus)[keyof typeof PetStatus]` 这一对。
- 类型导入使用 `import type`，因此在 `verbatimModuleSyntax` 下也能通过。
- barrel 用 `export type *` 重新导出只含类型的文件，用 `export *` 重新导出含有值的文件。
- 导入扩展名可以是 `.js`、`.ts` 或无。默认为 `.js`。要用 Node 的类型剥离直接运行时请选择 `.ts`，因为 Node 不会把 `.js` 说明符映射到 `.ts` 文件。

满足 `erasableSyntaxOnly` 只是在 Node 中直接运行的必要条件。直接运行还需要 `.ts` 导入扩展名以及 Node 22.18 或更高版本（Node 的 TypeScript 文档）。共享包的推荐设置见 9.2。

### 7.4 操作文件示例 {#74-example-operation-file}

```ts
// operations/getPetById.ts
import type { Client, RequestOptions, TransportFailure } from '@tsurara/client';
import type { Pet } from '../schemas/Pet.js';
import type { ErrorModel } from '../schemas/ErrorModel.js';

export type GetPetByIdData = {
  path: { petId: number };
  query?: { expand?: string[] };
};

export type GetPetByIdResponses = { 200: Pet };
export type GetPetByIdErrors = { 404: ErrorModel; default: ErrorModel };

export type GetPetByIdResult =
  | { ok: true; kind: 'success'; status: 200; data: Pet; response: Response }
  | { ok: false; kind: 'http'; documented: true; status: 404; error: ErrorModel; response: Response }
  | { ok: false; kind: 'http'; documented: true; status: number; error: ErrorModel; response: Response }
  | TransportFailure;

export const getPetByIdDef = {
  v: 1,
  id: 'getPetById',
  method: 'GET',
  path: '/pet/{petId}',
  tags: ['pet'],
  params: {
    path: { petId: {} },
    query: { expand: { style: 'form', explode: true } },
  },
  responses: {
    200: { parseAs: 'json' },
    404: { parseAs: 'json' },
    default: { parseAs: 'json' },
  },
} as const;

/** Find pet by ID */
export function getPetById<Ctx>(
  client: Client<Ctx>,
  options: GetPetByIdData & RequestOptions<Ctx>,
): Promise<GetPetByIdResult> {
  return client.request<GetPetByIdResult>(getPetByIdDef, options);
}
```

- 函数的第一个参数是客户端，并且总是显式传入。不存在隐式的全局客户端，因为共享包中的全局状态会把应用之间、请求之间的设置混在一起。
- 对于没有必需参数的操作，可以省略 `options`。
- 对于请求体有多种媒体类型的操作，`Data` 类型中的 `body` 和 `contentType` 用带判别字段的联合类型绑定在一起。定义中的第一个媒体类型是默认值，只有该成员可以省略 `contentType`。如果请求体是可选的，每个成员都可以省略 `body`。省略 `body` 时，即使给出了 `contentType` 也不会发送请求体。

  ```ts
  export type UploadPetData =
    | { contentType?: 'application/json'; body: PetWritable }
    | { contentType: 'multipart/form-data'; body: UploadPetForm };
  ```
- 函数体只是调用 `client.request(def, options)`。路径展开、查询序列化、请求体构建和响应解析都由 `@tsurara/client` 读取 OperationDef 来完成。
- `OperationDef` 持有一个值，但它只是普通的对象字面量，因此不违反 erasableSyntaxOnly。
- OperationDef 不加 `satisfies OperationDef`，因为它会让 `isolatedDeclarations` 无法推断类型（TS9010）。其形状由 `client.request` 的参数类型检查。

### 7.5 内置运行时 {#75-vendored-runtime}

`runtime: vendor`（默认为 `package`）会把运行时源码的副本写入输出，生成的代码导入该副本而不是包。它适用于无法添加运行时包的项目（严格的依赖策略、离线构建、把依赖作为资源打包的游戏引擎）。副本就是能通过 `spec/conformance` 的源码：序列化仍然留在运行时中。

| 语言 | 副本 | 生成的代码如何引用它 |
|---|---|---|
| TypeScript | `_runtime/`（带有目标的导入扩展名） | 用相对说明符代替 `@tsurara/client` |
| Python | 子包 `_runtime` | 相对导入（`from .._runtime import Client`） |
| Rust | 模块 `runtime`（`mod.rs` 中的 `pub mod runtime;`） | 必填的 `rust.runtimeCrate`：该模块在用户 crate 中的路径（`crate::api::runtime`） |
| Go | 输出中的包 `internal/tsurara` | `go.runtimeModule`，未设置时根据最近的 `go.mod` 计算 |

- 源码在构建时嵌入二进制文件（`tsurara-runtimes`，一个针对 `runtimes/` 的构建脚本，不含测试），因此副本始终与生成器一致。
- 每个复制的文件都以生成文件标记和一行注明 MIT 许可证的文字开头。过时文件的删除和 `tsurara check` 像对待生成的代码一样覆盖副本：修改会让 `check` 失败，`generate` 会恢复它，取消内置则会删除它。不写入运行时版本标记，`check` 的版本检查也不适用（副本本身就是那个版本）。
- 只在语言需要的地方修改副本：TypeScript 的相对导入带上导入扩展名；Rust 的 `crate::`、`$crate::` 和 `tsurara_client::` 路径改为 `runtimeCrate`，`#[macro_export]` 宏按路径重新导出，解析 cargo 特性（客户端层仅在有操作时保留，Mock 传输层仅在 `rust.mocks` 时保留，并置于 `cfg(any(test, feature = "mocks"))` 之下），并允许 `clippy::collapsible_if`，因为运行时保持兼容 Rust 1.85；Go 中对运行时和 `tsuraratest` 的导入改为内置后的路径。
- 不复制第三方依赖：`generate` 会列出它们（Python 为 httpx；Rust 为 serde、serde_json 和 indexmap，有操作时还有 tokio、fastrand、httpdate 和 reqwest，这些也列在 `mod.rs` 中）。TypeScript 和 Go 没有第三方依赖。
- 使用 `operations: false` 时，Rust 只复制类型层（18.9）；当没有文件导入运行时，TypeScript 什么都不复制。
- 每个目标都有自己的副本。不提供供多个目标共享的位置：同一仓库中共享运行时的多个目标更适合使用包。

## 8. 运行时库（@tsurara/client） {#8-runtime-library-tsuraraclient}

### 8.1 创建客户端 {#81-creating-a-client}

```ts
import { createClient } from '@tsurara/client';

const api = createClient<{ traceparent?: string }>({
  baseUrl: 'https://api.example.com',
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  middleware: [tracing(), logging(logger), retry({ max: 2 })],
  onResult: (result, req) => metrics.record(req.operation.id, result.kind),
  fetch: customFetch,
  timeout: 10_000,
});
```

| 选项 | 说明 |
|---|---|
| `baseUrl` | 连接目标 |
| `headers` | 添加到每个请求的请求头。可以是异步函数 |
| `middleware` | 拦截请求和响应的函数（8.4） |
| `onResult` | 接收最终 Result 的观察钩子（8.4） |
| `onUndocumentedStatus` | 响应的状态码未在定义中声明时调用的观察钩子（8.2） |
| `auth` | 返回操作的某个安全方案的凭据（见下文） |
| `fetch` | fetch 的实现。用于在测试中替换，或在服务端使用 |
| `timeout` | 默认超时（毫秒） |
| `validate` | 校验 JSON 响应体；`validateResponses(schemas)` 可以根据 Standard Schema schema 构建它（8.7） |

无论在这里还是在 `RequestOptions` 中，可选选项都接受 `undefined` 作为“未设置”，因此在 `exactOptionalPropertyTypes` 下也可以有条件地设置（`onUndocumentedStatus: dev ? log : undefined`）。

认证遵循定义。每个 OperationDef 都带有该操作的安全要求（它自己的 `security` 或根级的 `security`），以及放置每个凭据所需的信息。`auth(scheme, info)` 返回某个方案的凭据或 `undefined`；客户端使用第一个所有方案都有凭据的备选项，并按方案放置凭据：API key 放在其请求头、查询参数或 cookie 中，`http` `bearer`、OAuth 2 和 OpenID Connect 的令牌放在 `Authorization: Bearer` 中，`basic` 放在 `Authorization: Basic` 中（钩子返回 `user:password`，由客户端编码）。`security: []` 的操作不发送任何凭据，不完整的备选项会被跳过。`mutualTLS` 属于传输层（`fetch`）。生成的代码导出 `SecuritySchemeName`，即方案名称的联合类型。获取令牌（OAuth 流程）不在客户端中进行；钩子可以调用负责这件事的代码。

类型参数 `Ctx` 是每次调用时传入的 context 的类型，用于在 SSR 中传递每个请求的追踪 ID 等场景。不使用模块扩充（module augmentation），因此各个应用可以有不同的类型而互不干扰。

`signal`、`headers`、`timeout`、`baseUrl` 和 `context` 可以通过 `RequestOptions` 按调用覆盖。

### 8.2 Result {#82-result}

`client.request` 返回的 Promise 永远不会 reject。HTTP 错误、网络失败和中止都作为 Result 值返回。

| `kind` | `ok` | 何时 | 主要字段 |
|---|---|---|---|
| `success` | true | 返回了定义中的成功状态码 | `status`、`data`、`response` |
| `http` | false | 返回了错误状态码，或定义中没有的状态码。定义中没有的状态码带有 `documented: false` 和 `error: unknown`。当定义了其他成功状态码时，未定义的 2xx（例如只定义了 200 的操作返回 201）也归入此类 | `status`、`error`、`documented`、`response` |
| `network` | false | fetch 本身失败（DNS、连接中断、CORS 等） | `cause` |
| `timeout` | false | 超过了 `timeout` 给定的时间 | `cause` |
| `aborted` | false | 被调用方的 `signal` 中止 | `cause` |
| `parse` | false | 解析响应体失败，包括 Content-Type 与预期不符的情况 | `cause`、`response`、`contentType` |
| `unexpected` | false | 中间件等用户代码抛出了异常 | `cause` |
| `validation` | false | `validate` 在成功响应体或定义中声明的错误响应体中发现了问题（8.7） | `status`、`value`、`issues`、`response` |

在内部，`timeout` 和 `aborted` 都是通过 AbortSignal 实现的中止。仍然把它们分开，是因为日志和重试对它们的处理不同。`unexpected` 与 `network` 分开也是出于同样的原因：不把用户代码中的缺陷与网络失败混在一起。

`validation` 从一开始就保留，这样日后加入校验时，不会破坏按 `kind` 分支的用户代码。

定义中没有的状态码，即使服务器本意是成功，也会成为失败，因此服务器与定义之间的偏差（定义写的是 200，服务器却返回 201）只会表现为意外的失败。`onUndocumentedStatus({ operation, context, status, response })` 会对每个这样的响应调用，且在 `onResult` 之前；在开发期间记录它，就能在偏差发生的地方看到它。与 `onResult` 一样，它抛出的异常不会改变 Result。

`default` 响应的类型为 `status: number`。TypeScript 无法表达“404 以外的数字”，因此用 `status === 404` 收窄后，联合类型中仍会留下 `default` 成员。实际上，只要先检查定义中声明的状态码，就不会有问题。

### 8.3 unwrap 与 ApiError {#83-unwrap-and-apierror}

在更适合用异常编写的地方，可以使用 `unwrap(result)`。成功时它返回 `data`，失败时抛出 `ApiError`。`ApiError` 继承自 `Error`，带有 `kind`、`status`、`operationId`、原始的 `result` 和 `cause`。堆栈跟踪也会保留。

`ApiError` 以操作的 Result 类型作为类型参数。`ApiError<GetPetResult>` 把 `result` 收窄为该操作的失败，因此 `result.kind === 'http' && result.documented` 会让定义中声明的错误响应体获得其 schema 类型。抛出的值无法携带静态类型，所以这适用于知道是哪个操作的地方，例如 TanStack Query 中的 `useQuery<Pet, ApiError<GetPetResult>>`。默认的 `ApiError` 带有 `error: unknown` 的通用失败。

`new ApiError(result)` 与 `unwrap` 一样，会记录返回 `result` 的操作名称。

`isHttpError(result, 422)` 把 Result 收窄为某个状态码在定义中声明的错误：如果该状态码单独声明，则收窄为它自己的成员；否则收窄为 `status` 设为该值的 `default`（或范围）成员。只检查 `status` 无法收窄，因为未声明状态码的成员带有 `status: number`。

传入不是 Result 的值时，会改为抛出 `TypeError`。常见情况是忘了 `await`（`unwrap(getPet(api, …))`）：类型检查会拒绝它，但只用类型剥离运行的代码不会，因此错误信息会提示去 await 这个调用。

### 8.4 中间件与 onResult {#84-middleware-and-onresult}

中间件是形如 `(req, next) => Promise<Response>` 的函数。中间件从最外层开始调用，并通过 `next` 把控制权交给内层。通过 `req.operation` 可以看到操作的 `id`、`method`、路径模板（`/pet/{petId}`）和 `tags`。可以把它们用作追踪的 span 名称和日志的键。

中间件可以抛出异常。`@tsurara/client` 会在外层捕获并把它转换为 Result。

`onResult` 在所有处理完成后接收 Result。日志和指标往往需要最终结果，包括 HTTP 之前的失败（例如超时）。仅靠中间件很难捕获这些，所以它是一个单独的钩子。

两个运行时都以相同的默认值内置了重试：`@tsurara/client` 中的 `retry()` 中间件，以及 `tsurara-client` 中的客户端选项 `retry=Retry()`。它们只对幂等方法（GET、HEAD、OPTIONS、PUT、DELETE）重试网络失败以及状态码 408、429、500、502、503 和 504，最多 2 次。等待时间在响应带有 `Retry-After`（秒数或 HTTP 日期）时取该值，否则采用 full jitter 的指数退避（随机等待，上限为每次重试翻倍的 100 毫秒）；两者都以 30 秒为上限（`maxDelay` / `max_delay`）。客户端的 `timeout` 覆盖所有尝试的总和：会在其之后才结束的等待不会开始，而是返回最后一个响应；超时或中止之后不会再重试。每次尝试都会重新构建请求，无法再次发送的流式请求体不会重试。

`bindClient(client, { getPet, listPets })` 返回把客户端绑定为第一个参数的函数（`api.getPet(options)`）。绑定后函数的 `context` 类型来自客户端。

### 8.5 序列化与响应解析 {#85-serialization-and-response-parsing}

所有请求和响应的转换都由 `@tsurara/client` 根据 OperationDef 完成。生成的代码不包含转换逻辑。转换逻辑集中在库中的一个地方，就可以对其整体进行测试。

- 路径与查询：遵循 OpenAPI 的 `style`（form、spaceDelimited、pipeDelimited、deepObject 等）和 `explode`。路径参数缺失，或其值会使整个路径段变为空、`.` 或 `..` 时，会在发送前失败（`kind: 'unexpected'`）：URL 解析会移除点段，否则 `/users/{id}/profile` 中的 `id: '..'` 会调用 `/profile`。值会进行百分号编码（包括 `%`），因此 `%2e` 这样的值会以 `%252e` 发送。路径模板必须以 `/` 开头：它会以文本形式追加到 base URL 后面，因此 `https://api.example.com` 之后的 `@evil.example/x` 或 `:8443/x` 会改变主机或端口。模型会去掉不以 `/` 开头的路径键，并给出 `invalid-definition` 警告（webhook 名称和回调表达式不是路径），所有运行时都会在发送前拒绝这样的 OperationDef（`unexpected`）。
- 请求体：支持 JSON、`multipart/form-data`、`application/x-www-form-urlencoded` 和二进制。multipart 遵循 `encoding`：数组按元素逐个 `append`，对象用给定的 Content-Type 序列化。
- 响应：生成器根据媒体类型决定 `parseAs`，并写入 OperationDef。

下表从上往下检查，第一个匹配的行起决定作用。

| 顺序 | 媒体类型与 schema | parseAs | data 的类型 |
|---|---|---|---|
| 1 | 无响应体（204 等） | `none` | `undefined` |
| 2 | 带条目 schema（3.2 的 `itemSchema`，或 `x-itemSchema`）的 `text/event-stream` | `events` | `AsyncIterable<{P}Event>` |
| 2a | 带条目 schema 的 JSON Lines（`application/jsonl`、`application/x-ndjson`）和 JSON text sequences（`application/json-seq`） | `jsonLines`、`jsonSeq` | `AsyncIterable<{P}Item>` |
| 2b | 其他顺序格式（以上格式但没有条目 schema） | `stream` | `ReadableStream<Uint8Array>` |
| 3 | `application/json`、`*/*+json` | `json` | JSON 上下文中的 schema 类型（6.4）。即使 `type: string` 带有 `format: binary` 或 `contentMediaType`，也保持为 `string`，不会改为 `blob` |
| 4 | `text/*` 等字符串格式 | `text` | `string` |
| 5 | `*/*`、`application/*` 等通配类型，且 schema 为二进制（6.4：`format: binary`，或没有 `contentEncoding` 的 `contentMediaType`） | `blob` | `Blob` |
| 6 | 通配类型，且 schema 不是二进制 | `auto` | Schema 类型 \| `string` \| `Blob` |
| 7 | 其他（`application/octet-stream`、图片等） | `blob` | `Blob` |

使用 `auto` 时，解析方式由响应的实际 Content-Type 决定：JSON 媒体类型按 JSON 解析，`text/*` 读作字符串，其他读作 `Blob`。返回哪一种要到运行时才知道，因此 data 的类型是所有可能值的联合。这样可以避免给定义允许的值赋予错误的类型。通配类型会给出警告；对于实际上只返回 JSON 的 API，可以通过配置把通配类型视为 JSON（031 中的工作，016 中的配置）。如果按 JSON 处理的操作返回了非 JSON 的 Content-Type，结果为 `kind: 'parse'`。

Server-Sent Events：条目 schema 把一个事件描述为带有属性 `event`、`data`、`id` 和 `retry` 的对象。其 `oneOf` 或 `anyOf` 中的每一项都是一个事件，并用写在该关键字旁边的属性补全；没有它们时，schema 本身就是唯一的事件。`{P}Event` 是这些事件的联合 `{ event: 'note'; data: Note; id?: string; retry?: number } | ...`，因此 `switch (e.event)` 可以收窄 `data`。`event` 是事件名称（`event` 的 `const` 或 `enum`）的联合；没有名称的事件为 `string`，代表其他任何名称。在有带标签联合类型的语言中，事件是以 `event` 为标签、以操作命名的联合类型（`StreamNoteEvent`），没有名称的事件是它的默认成员。schema 带有 JSON `contentMediaType` 的 `data`，类型为其 `contentSchema` 的类型（没有时为 `unknown`），并由运行时解析；其他 `data` 为 `string`。OperationDef 说明要解析哪些事件：列出属于 JSON 的事件名称（`event` 的 `const` 或 `enum`），使定义中未列出的事件保持为文本；只有当所有事件都是 JSON 且其中一个没有名称（代表其他任何名称）时，才使用 `jsonEvents: true`。在一组文本事件中，带 JSON 数据但没有名称的事件在运行时无法区分，因此其 data 保持为 `string`，并给出警告。`data` 总是必需的，因为没有 data 的事件不会被分发（与 `EventSource` 相同）；除非 `required` 列出了它们，`id` 和 `retry` 是可选的。运行时按 HTML 标准的描述解析流，并交出一个只能读取一次的异步可迭代对象；退出循环会取消流。由于 Result 已经返回，事件中的 JSON 无效时会在迭代中抛出异常。定义中未列出的事件原样到达，`data` 为字符串。语义模型保持请求/响应体的种类为 `stream`，并在其旁边携带事件（`MediaContent::events`）；tsurara-lower 会标记这类响应（`OperationTypes::sequences`），并给出单个条目的类型。每个运行时都能读取事件和 JSON 条目：`@tsurara/client` 和 Python 交出（异步）迭代器，Rust 交出用 `next().await` 读取的 `Items<T>`，Go 交出用 `All()` 读取的 `*Items[T]`；它们的超时覆盖发送和响应头，但不覆盖条目；Python、Rust 和 Go 通过流式传输层读取每个响应，使条目在服务器写出时即可到达。`@tsurara/client` 的 `parseEventStream` 以同样的方式读取没有 schema 的字节流。

JSON Lines 和 JSON text sequences：条目 schema 是 JSON 上下文中单个条目的 schema，`{P}Item` 是其类型。运行时每行读取一个 JSON 文本（`jsonLines`；跳过空行，CR、LF 和 CRLF 都表示行尾），或每条以 U+001E 开头的记录读取一个 JSON 文本（`jsonSeq`；跳过第一个分隔符之前的文本和空记录），遇到无效 JSON 时在迭代中抛出异常。模型保持请求/响应体的种类为 `stream`，并在其旁边携带条目类型（`MediaContent::items`）。

请求体同样根据媒体类型和 schema 构建。

- 对于 JSON 媒体类型，把 JSON 上下文中 schema 类型的值以 JSON 发送。即使带有 `format: binary` 或 `contentMediaType`，也不会改为原样发送该值。
- 对于二进制请求体（`application/octet-stream` 等）以及 schema 为二进制的通配类型，原样发送该值。对于通配类型，`Blob` 的 `type` 会成为 Content-Type；没有 `type` 时不设置 Content-Type。
- 对于 schema 不是二进制的通配类型，以 Content-Type `application/json` 把值作为 JSON 发送。生成器会给出警告。
- `Blob`、`ArrayBuffer`、`Uint8Array`、`ReadableStream` 和 `FormData` 永远不会传给 `JSON.stringify`。当它们之一作为 JSON 请求体传入时，会返回 `kind: 'unexpected'` 的 Result，而不是悄悄把数据变成 `{}`。

### 8.7 响应校验 {#87-response-validation}

校验是可选的，不使用时一切不变。`@tsurara/client` 通过 [Standard Schema](https://standardschema.dev) 接口（`~standard.validate`）进行校验，Zod（3.24 及以上、4）、Valibot 和 ArkType 都实现了该接口，因此它不依赖其中任何一个。`validate` 选项是一个函数，接收解析后的响应体以及操作、状态码和媒体类型，返回问题或什么都不返回；`validateResponses(schemas)` 根据按操作 id、状态码（也包括 `2XX` 和 `default`）和媒体类型划分的 schema 构建这样的函数。单次调用可以传入其他校验器或 `validate: false`。校验的对象是以 JSON 读取的成功响应体和定义中声明的错误响应体（不包括文本、二进制或流）；有问题的响应体会变为 `{ ok: false, kind: 'validation', status, value, issues, response }`，`unwrap` 会抛出该种类的 `ApiError`。异步校验器会被 await。

`typescript.validators: zod` 会输出 Zod 4 schema：`zod/Pet.ts` 导出 `PetSchema: z.ZodType`（为 `isolatedDeclarations` 加了类型注解，引用通过 `z.lazy`，因此循环和模块顺序都不成问题），`zod/operations.ts` 导出供 `validateResponses` 使用的 `responseSchemas`。类型和调用函数永远不会导入 Zod 文件，因此不做校验的应用不会加载 `zod`。

这些 schema 检查类型、`enum`、`const` 以及格式 `uuid`、`email` 和 `date-time`。`typescript.validatorConstraints: true` 会加入定义中的约束，这些约束通过 `Doc::constraints()` 从模型的文档标签中读取：字符串的 `minLength`、`maxLength` 和 `pattern`，数字的 `minimum`、`maximum`、`exclusiveMinimum`、`exclusiveMaximum`（3.0 的布尔值并入边界）和 `multipleOf`，数组的 `minItems`、`maxItems` 和 `uniqueItems`（按 JSON 文本进行细化），对象的 `minProperties` 和 `maxProperties`，以及格式 `uri`、`ipv4`、`ipv6`、`date`、`time` 和 `duration`。对于可空的值，它们作用于其他成员。由于服务器经常发送无害地违反这些约束的值（很长的描述、没有偏移量的日期时间），它们默认关闭；开启后这类响应会变为 `kind: 'validation'`。该选项适用于把 schema 复用于输入（例如表单）的应用。按规范，`pattern` 是 ECMA-262 正则表达式，但也存在为其他引擎编写的定义：每个模式都会在生成时按 ECMAScript 规则并带 `u` 标志编译（`regress` crate），无法编译的会给出 `unsupported` 警告并被省略，而不是生成一个在加载时抛出异常的模块。`$ref` 上的约束以及数组中嵌套数组条目的约束，在模型保留 schema 文档的地方（声明和属性）生效；嵌套的条目 schema 只保留类型。目前还不会在发送前校验请求。

```ts
import { createClient, validateResponses } from '@tsurara/client';
import { responseSchemas } from './generated/zod/operations.ts';

const api = createClient({ baseUrl, validate: validateResponses(responseSchemas) });
```

这些 schema 检查的是 TypeScript 类型所表达的内容，绝不超出定义：

| Schema | Zod |
|---|---|
| `string`、`integer`、`number`、`boolean`、`null` | `z.string()`、`z.number().int()`、`z.number()`、`z.boolean()`、`z.null()` |
| `format: uuid`、`email`、`date-time` | `z.uuid()`、`z.email()`、`z.iso.datetime({ offset: true })`；其他格式是普通字符串 |
| `enum`、`const` | `z.enum([...])`（字符串）或 `z.literal` 的联合；与 TypeScript 类型一样是封闭的（18.5.3） |
| 对象 | `z.object({...})`，可选属性带 `.optional()`；允许未列出的属性，`additionalProperties` 变为 `.catchall(...)`，没有属性的 `false` 变为 `.strict()` |
| 数组、元组 | `z.array(...)`；定长元组为 `z.tuple([...])`，其他元组为 `z.array(z.unknown())` |
| `oneOf`、`anyOf`、discriminator | `z.union([...])`（不检查 `oneOf` 的互斥性） |
| `allOf` | `z.intersection(...)` |
| `$ref` | `z.lazy(() => PetSchema)` |
| readOnly / writeOnly | 响应类型（去掉 writeOnly 属性） |
| 外部类型（`x-tsurara-type`、类型映射）、二进制 | `z.unknown()`（外部类型会给出警告） |
| 字符串和数字约束（`minLength`、`pattern`、`minimum` 等） | 目前还不检查：类型也对它们做了近似 |

Zod schema 的类型检查成本很高：有了它们，对 GitHub、Stripe、Kubernetes 和 OpenAI 输出运行 `tsc` 需要 0.9 到 1.4 秒，而不是 0.1 到 0.2 秒，类型实例化次数为 130 万到 270 万次，而不是 1.3 万到 3.6 万次（TypeScript 7.0.2，2026-11-11）。语料库测试会用 `tsc` 检查 Zod 输出。Python 运行时用 TypeDef 解码值，这本身就会拒绝类型不符的响应体；它没有单独的校验选项。

### 8.8 事件 channel {#88-event-channels}

有些消息不是响应：服务器在提交之后向 hub（Mercure）发布更新，浏览器则通过 `EventSource` 从 hub（另一台服务器）接收这些更新。`x-event-channels` 在文档的根部描述它们：

```yaml
x-event-channels:
  board:
    summary: Updates every participant of a board may see
    channel: 'board/{boardId}'         # appended by the app to the deployment's topic prefix
    parameters:
      boardId: { type: string }
    private: true                      # the hub requires a subscriber claim; informational
    content:
      application/json:
        schema: { $ref: '#/components/schemas/BoardEvent' }   # oneOf with a discriminator on `type`
```

传输格式：一条消息就是一个 JSON 文档（`MessageEvent.data`）；事件的种类是其中的一个属性（`type`，值如 `card.added`），而不是 SSE 的 `event` 字段，因此每条消息都会到达 `onmessage`，同样的格式也可用于 WebSocket；`seq` 这类排序数据是载荷中的属性；SSE 的 `id` 仍然属于 hub（`Last-Event-ID`）。

模型把它们保存为 `Model::channels`（名称、文档、模板、参数、载荷内容），位于 webhook 之后，并发出一个 `channel` 名称请求。没有对应参数的模板变量会变为字符串，不在模板中的参数会被丢弃，两者都会给出 `invalid-definition` 警告。TypeScript 后端为每个 channel 写出 `channels/{name}.ts`：`{Channel}Message`（载荷类型：JSON 媒体类型时为其类型，文本时为 `string`，两者都没有时为 `unknown` 并给出 `unsupported` 警告）、`{Channel}TopicParams` 和 `{channel}Topic(params)`（每个值都进行百分号编码）、`{channel}ChannelDef`，以及 `decode{Channel}(data, options?)`，后者调用 `@tsurara/client` 的 `decodeMessage` 并返回 `MessageResult`：`{ ok: true, value }`、`{ ok: false, kind: 'parse', data, cause }` 或 `{ ok: false, kind: 'validation', value, issues }`。使用 `typescript.validators: zod` 时，`zod/channels.ts` 导出供 `validateChannels` 使用的 `channelSchemas`，它进行同步校验（异步 schema 会抛出异常）。解码器接受字符串，因此可以配合 `EventSource`、基于 `fetch` 的 `parseEventStream` 以及 WebSocket 使用；连接不归客户端所有。Zod schema 保持注解为 `z.ZodType`：由于 Zod 推断出的可选属性不满足 `exactOptionalPropertyTypes`，解码器把校验后的值视为消息类型。其他语言目前忽略 channel；不会把 `webhooks` 读作 channel。

### 8.9 Mock {#89-mocks}

`typescript.mocks: msw | fetch` 会写出其他文件不会导入的 `mocks/`：包含 `mock{Name}()` 的 `mocks/schemas/{Name}.ts`（18.7.1 中的示例值；带属性的对象接受 `overrides?: Partial<T>`；值为自身示例的具名类型由其工厂函数构建，由于示例会切断循环，循环也能保持有限）、包含 `{Op}MockResponse`（定义中声明的状态码及其响应体类型的联合：状态码为字面量，范围和 `default` 为 `number`）和 `{function}Handler(response?, options?)` 的 `mocks/operations/{function}.ts`、包含把响应转换为其媒体类型的逻辑的 `mocks/support.ts`，以及让每个操作都用其第一个成功响应作答的 `mocks/index.ts`。使用 `msw` 时，处理器是 MSW 2 和 3 的 `HttpHandler`（`*/pets/:petId`；参数位于路径段中间时使用正则表达式；对于 MSW 没有辅助函数的方法，使用带方法检查的 `http.all`）；使用 `fetch` 时，它们是 `mockFetch` 的路由（18.9）。

工厂函数逐字段进行类型检查，但类型中包含示例可能不符合其 TypeScript 类型的结构时除外：带判别字段的联合类型（真实定义中存在映射与成员常量相矛盾的情况，会得到 `never`）、继承的标签、`allOf` 交叉类型和外部类型。这些值以 JSON 写出并进行断言（`as unknown as T`）。不会生成处理器中的请求校验，也不会生成逐条流式返回的响应。

### 8.6 分发与兼容性 {#86-distribution-and-compatibility}

`@tsurara/client` 仅支持 ESM，发布构建好的 JS 和 `.d.ts`。它只依赖标准的 `fetch`、`Request`、`Response` 和 `AbortSignal`。Node 不会对 node_modules 下的 `.ts` 应用类型剥离，因此这个包在发布前要先构建。

OperationDef 格式带有版本号。生成的代码会记录兼容的 `@tsurara/client` 版本范围，`tsurara check` 会检测其与已安装版本的不匹配。这样，当生成器和库被分别更新而产生偏差时就能察觉。

## 9. 在 pnpm workspace 中使用 {#9-using-it-in-a-pnpm-workspace}

### 9.1 结构 {#91-layout}

```
packages/openapi/                  共享包
  package.json                     name: @acme/openapi, "sideEffects": false
  tsurara.config.yaml
  src/generated/...                tsurara 的输出
  src/index.ts                     重新导出生成结果和 @tsurara/client
apps/app-1/src/api.ts              app-1 的客户端
apps/app-2/src/api.ts              app-2 的客户端
```

生成只在 `packages/openapi` 中进行一次。app-1 和 app-2 各自创建自己的客户端，并把它传给生成的函数。日志、追踪和请求头的差异都在客户端配置中，因此生成的输出对各个应用一无所知。

| 定制的种类 | 位置 | 示例 |
|---|---|---|
| 生成时（所有应用共享） | `packages/openapi/tsurara.config.yaml`、插件 | 类型映射、对定义的补丁、按标签筛选 |
| 运行时（每个应用） | 各应用的 `createClient()` | baseUrl、认证请求头、日志、追踪、重试、替换 fetch |

### 9.2 共享包的处理 {#92-handling-the-shared-package}

`packages/openapi` 不需要构建；它是一个内部包，其 `package.json` 的 `exports` 直接指向 `.ts` 文件。为了在使用打包工具（Vite 等）的应用和由 Node 直接运行的应用之间共享同一份生成输出，推荐以下设置。

- 在生成设置中把导入扩展名设为 `.ts`（7.3）。Node 不会把 `.js` 说明符映射到 `.ts`。
- 在每个编译“导入共享包的代码”的 tsconfig 中，启用 `allowImportingTsExtensions`（与 `noEmit` 一起）或 `rewriteRelativeImportExtensions`：不仅是每个应用，还包括测试包和工具。生成的文件之间以 `.ts` 扩展名相互导入，而 TypeScript 会把它们作为导入方项目的一部分进行检查，因此没有该设置的项目会在共享包的文件中（而不是在它自己的代码中）报告 TS5097（“An import path can only end with a '.ts' extension when 'allowImportingTsExtensions' is enabled”）。无法这样设置时，请改用 `.js` 导入扩展名生成，并像任何发布的包一样把共享包构建为 `.js` 和 `.d.ts`；由 Node 运行的应用则使用构建后的文件。
- 由 Node 直接运行的应用使用 Node 22.18 或更高版本。pnpm 的符号链接会解析为真实路径，因此 Node 的“不对 node_modules 下的文件进行类型剥离”这一限制应该不适用。
- 除了 barrel 之外，还要为共享包的 `exports` 提供子路径 `operations/*` 和 `schemas/*`。

```json
{
  "name": "@acme/openapi",
  "type": "module",
  "sideEffects": false,
  "exports": {
    ".": "./src/index.ts",
    "./operations/*": "./src/generated/operations/*.ts",
    "./schemas/*": "./src/generated/schemas/*.ts"
  }
}
```

这一设置已在三个共享同一个包的应用中验证过：使用 Vite 的 React（开发服务器和生产构建，严格的 tsconfig，从 barrel 导入）、使用 Vite 的纯 TypeScript（宽松的 tsconfig，从子路径导入，自定义中间件和 `retry()`），以及用 Node 26 的类型剥离运行的 CLI（`nodenext`）。编辑生成的文件会重新加载 Vite 页面，Node 通过 pnpm 的符号链接运行该包，tree-shaking 即使通过 barrel 也能去掉未使用的操作，工作区中只有一份 `@tsurara/client`。`examples/pnpm-monorepo` 就是仓库中的这一设置，并在 CI 中验证：一个打包结果只保留所用操作的 Vite 应用，以及一个针对本地服务器进行端到端测试的 Node 应用。示例中的 Next.js 应用（App Router，一个服务端组件和一个客户端组件）无需 `transpilePackages` 即可用 Turbopack 和 webpack 构建：Next.js 16.4 会编译链接的工作区包中的 `.ts` 文件。它的 tsconfig 与其他使用方一样需要 `allowImportingTsExtensions`；没有它，`next build` 会在共享包中因 TS5097 失败。Node 和 TypeScript 的最低版本在 034 中验证，这两个应用作为 024 的验收标准进行验证。

每个操作都有自己的文件，并设置了 `sideEffects: false`，因此即使从 barrel 导入，生产打包结果也只包含用到的函数。不过这说的是生产构建中的 tree-shaking。在 Node 中直接运行或在 Vite 开发服务器中，会加载 barrel 引用的所有模块。`tsc` 和编辑器在经过 barrel 时也会读取所有文件。对于操作很多的定义，请直接从子路径导入。

```ts
import { getPetById } from '@acme/openapi/operations/getPetById';
import type { Pet } from '@acme/openapi/schemas/Pet';
```

经过 barrel 和直接导入的加载时间在 025 中测量。

当一个共享包生成多个定义（`targets`）时，请通过各自的子路径（`@acme/openapi/public`、`@acme/openapi/admin` 等）公开每个目标。每个目标的输出都有相同的名称（例如 `BaseUrl` 和 `servers`），因此用 `export *` 把它们合并到一个 barrel 中会造成名称冲突。

让 `@tsurara/client` 成为 `packages/openapi` 的依赖。应用通过 `@acme/openapi` 的重新导出来使用它，因此工作区最终只有一个版本的 `@tsurara/client`。

### 9.3 应用代码示例 {#93-example-app-code}

```ts
// apps/app-1/src/api.ts
import { createClient } from '@acme/openapi';

export const api = createClient<{ traceparent?: string }>({
  baseUrl: import.meta.env.VITE_API_URL,
  headers: async () => ({ Authorization: `Bearer ${await getToken()}` }),
  middleware: [tracing(), logging(logger)],
});
```

```ts
// apps/app-1/src/pages/pet.ts
import { getPetById } from '@acme/openapi';
import { api } from '../api';

const r = await getPetById(api, { path: { petId: 1 }, context: { traceparent } });
if (r.ok) {
  render(r.data);
} else if (r.kind === 'http' && r.status === 404) {
  renderNotFound(r.error);
} else {
  reportError(r);
}
```

需要的应用可以用 `bindClient(api, { getPetById, ... })` 把函数和客户端打包成一个对象（可选）。

### 9.4 TanStack Query {#94-tanstack-query}

`typescript.query: tanstack` 为每个操作输出 `query/{function}.ts`，其他任何内容（类型、函数或 barrel）都不会导入它，因此不使用 TanStack Query 的应用永远不会加载它：

- 读取操作（`GET`、`HEAD`、`QUERY`）：`{function}QueryKey(data, scope?)` 返回 `[operationId, data]`，有作用域时返回 `[{ scope }, operationId, data]`，它用 `DataTag` 标注类型，因此 `getQueryData`、`setQueryData` 和 `cancelQueries` 知道数据和错误的类型；`{function}QueryOptions(client, data)` 返回 `{ queryKey, queryFn }`，其 `queryFn` 带着查询的 `signal` 调用函数并对结果执行 `unwrap`。当操作没有必需输入时，可以省略 `data`（此时为 `{}`）。用 `skipToken` 代替 `data` 时，会返回 `queryFn` 为 `skipToken` 的选项（一个重载，`{P}SkippableQueryOptions`），这样输入尚未确定的查询无需在调用处写条件也能获得类型；按 TanStack 的要求，`useSuspenseQuery` 会拒绝它们。`{function}QueryFilter(scope?)` 返回匹配该操作所有查询的 `{ queryKey }`（`[operationId]` 或 `[{ scope }, operationId]`），用 `DataTag` 标注类型，可用于 `invalidateQueries`、`cancelQueries`、`removeQueries` 和 `setQueriesData`。TanStack 的 `setQueriesData` 和 `getQueriesData` 无法从过滤器推断数据类型（5.108 也是如此），因此 `set{P}QueriesData(queryClient, updater, scope?)` 和 `get{P}QueriesData(queryClient, scope?)` 会带着数据类型和一个只匹配该操作查询的过滤器调用它们；这个过滤器不匹配数据为分页集合的无限查询。
- 其他方法：`{function}MutationOptions(client)` 返回 `{ mutationKey: [operationId], mutationFn }`（有作用域时为 `[{ scope }, operationId]`），其变量为该操作的 `Data`。
- 错误为 `ApiError<{P}Result>`，因此 `onError` 和 `error` 能看到定义中声明的错误响应体，`isHttpError(error.result, status)` 可以收窄它们；数据为 `SuccessData<{P}Result>`。`@tsurara/client` 中的 `queryRetry()` 是 TanStack Query 的 `retry` 选项，它只重试 `retry()` 中间件会重试的内容（网络失败和两者共享的 `RETRY_STATUSES`）；生成的选项不设置它，因为应用选择重试层的地方是 `QueryClient` 的默认设置。`retry()` 会记录它放弃的请求发送了多少次（一个以最后的响应或最后一次网络失败的原因为键的 `WeakMap`，因此不改变任何 Result 类型），`queryRetry()` 不会重试这样的失败，因此同时配置两者时，两层的重试次数不会相乘。
- 成功结果为流的操作两者都不会获得（`streamedQuery` 可能稍后加入）。
- 无限查询：OpenAPI 不描述分页，也不会根据 `cursor` 之类的名称进行猜测，因此只有在分页方式写明时，读取操作才会获得 `{function}InfiniteQueryOptions(client, data)` 和 `{function}InfiniteQueryKey(data, scope?)`：写在操作上的 `x-tsurara-pagination`（由模型读入与语言无关的 `Operation::pagination`），或优先级更高的 `typescript.infiniteQueries.<operationId>`。两者都接受 `param`（参数的 `in` 和名称，`query.cursor`）、`initial`（第一页；没有它时第一个请求不发送该参数，因此必需参数需要它），以及 `next` 和 `previous`（指向成功响应体的 JSON Pointer；那里的值不存在或为 `null` 时查询结束）。`queryFn` 根据 `pageParam` 设置参数；`getNextPageParam` 和 `getPreviousPageParam` 读取指针，没有 `next` 时，选项类型会把 `getNextPageParam` 留给应用（指针无法描述的格式：Link 头、根据总数计算的偏移量）。`{P}PageParam` 是参数的类型，因此 `data.pageParams` 和指针的值都会据此检查。未指向操作任何参数的分页、不是 JSON Pointer 的指针、非读取操作，或配置了不存在的操作 id，都会给出 `invalid-definition` 警告，该操作不会获得无限查询选项。

键的形状是应用在乐观更新和由 Mercure 驱动的缓存更新中所依赖的契约：操作 id，后面跟着请求数据（`path`、`query`、`headers`、`cookies`，以及 `QUERY` 的 `body`）。两个相同的请求有相同的键，不同操作的键永远不会共享第一个元素，`['getPet']` 在 `invalidateQueries` 中匹配所有 `getPet` 查询。base URL 和凭据不是键的一部分。使用 `queryScope`（一个说明谁可以共享结果的 JSON 值：租户、API、环境；绝不是凭据）创建的客户端会在其选项的键的最前面放置 `{ scope }`，这样在同一个 `QueryClient` 上作用域不同的客户端会保持各自的条目；由于键也会在手边没有客户端的地方构建（用 Server-Sent Event 更新缓存、服务端渲染），键工厂函数以参数形式接收作用域。没有作用域的键以操作 id（字符串）开头，有作用域的键以对象开头，因此两者永远不会相互匹配。`@tsurara/client` 中的 `queryScopeFilter(scope)` 匹配一个作用域的所有查询和 mutation，用于登出和切换租户。键中只包含 JSON 值，因此在服务端 `dehydrate`、在浏览器中 `hydrate` 之后哈希值相同。无限查询的键在数据之后追加一个标记（`[..., operationId, data, { infinite: true }]`）：永远不等于普通的键，但仍会被该操作的过滤器匹配。在无限查询选项的类型中，每个键都是宽泛的 `DataTag<QueryKey, InfiniteData<…>>`，而不是精确的联合类型：Vue 的 `useInfiniteQuery` 会深度映射键，并拒绝长度不同的元组组成的联合类型；`{function}InfiniteQueryKey` 保留精确的类型。哪个 mutation 影响哪个查询，OpenAPI 中没有写明，也不会推断；带类型的键和过滤器是应用在 `onSuccess` 中组合使用的部件。

类型来自 `@tanstack/query-core`（`QueryObserverOptions`、`DataTag`、`QueryFunctionContext`、`MutationOptions`），每个适配器都会重新导出它，因此这些对象无需按框架生成，就能用于 React 和其他适配器的 `useQuery`、`useSuspenseQuery`、`useQueries`、`prefetchQuery`、`ensureQueryData`、`fetchQuery` 和 `useMutation`。选项类型中的每个键（`QueryObserverOptions` 的键类型参数、`queryKey`、`queryFn` 的 context）都是同一个 `DataTag` 键：只要有一处是普通键，`useQueries`（React）和 `useQuery`（Vue）就会推断出两种键类型并拒绝这些选项。展开选项可以保留适配器的推断：`select` 决定 `data`，`initialData` 使其有定义，`onMutate` 返回的值成为 `onError` 中带类型的 context。为了 `isolatedDeclarations`，它们都写成显式类型。工厂函数不接受按调用的请求选项：`RequestOptions` 与请求数据共享 `headers` 和 `contentType`，因此按调用的设置应放在客户端的选项或中间件中。已用 TypeScript 5.8 和 7 针对 `@tanstack/react-query` 和 `@tanstack/vue-query` 5.107 验证。

## 10. 配置文件 {#10-configuration-file}

### 10.1 示例 {#101-example}

```yaml
# packages/openapi/tsurara.config.yaml
extends: ../../tsurara.base.yaml
targets:
  - name: public-api
    input:
      url: https://api.example.com/openapi.json
      headers:
        Authorization: "Bearer ${API_TOKEN}"
    output: src/generated/public
    filter:
      tags: [pet, store]
    naming:
      overrides:
        "#/components/schemas/Error": ApiErrorBody
    language: typescript       # the default
    typescript:
      importExtension: ts
      typeMappings:
        uuid: { type: Uuid, import: { from: ../brand.js, name: Uuid } }
    hooks:
      transformDocument: [node, scripts/patch-spec.mjs]
      afterWrite:
        - [biome, format, --write, "{output}"]
```

格式可以是 YAML、JSON 或 TOML。为了编辑器补全，会随附 `schema/tsurara.config.schema.json`。

依赖于语言的设置（`layout`、`importExtension`、`enumStyle`、`aggregateMaps`、`clientModule`、`typeMappings`、`overrides`、`naming.schemaCase`，以及最终标识符的 `naming.overrides`）写在以目标的 `language` 命名的部分中（18.10）。通用的 `naming.overrides` 是首选名称，各语言的规则仍然适用。

### 10.2 extends 与合并 {#102-extends-and-merging}

`extends` 接受一个或多个文件。对象会深度合并，数组会被替换。写在顶层的条目会成为 `targets` 中每一项的默认值。没有 `targets` 时，顶层就是唯一的目标，名为 `default`。有多个目标时，每个目标都需要唯一的 `name`。

### 10.3 路径与环境变量 {#103-paths-and-environment-variables}

相对路径以其所在配置文件的位置为基准解析。通过 `extends` 加载的基础配置中写的路径，也以该基础文件为基准解析。钩子命令在其所在配置文件的目录中运行。

环境变量可以用 `${VAR}` 展开，这样认证令牌就不必写进配置文件。

### 10.4 类型映射的约束 {#104-constraints-on-type-mappings}

`typeMappings` 按格式替换输出的类型。但是，替换后的类型必须与从 JSON 读取的运行时值一致。

把 `date-time` 映射为 `Date`、把 `int64` 映射为 `bigint`，除非在运行时转换值，否则类型就是谎言。初始版本把这两者视为配置错误，默认值分别为 `string` 和 `number`。运行时转换可以在之后通过让 OperationDef 携带需要转换的路径来加入。

不改变运行时值的映射是允许的，例如带品牌的类型（`string & { __brand: 'Uuid' }` 等）。

`typeMappings` 和 `x-tsurara-type` 中的 `import.from` 按如下方式处理（016 中的工作）。

- 以 `.` 开头的相对路径按 10.3，以其所在的配置文件为基准解析。生成器会把解析后的路径改写为相对于每个使用该类型的生成文件的说明符。
- 包名这类非相对说明符原样写出。
- 保留用户写的扩展名。按照导入扩展名设置（7.3）机械地改写，可能会破坏外部模块的说明符。在 Node 中直接运行时，用户自己写上 `.ts` 扩展名。

### 10.5 过滤 {#105-filter}

`filter` 按标签或 `operationId` 缩小要生成的操作：`tags` 和 `operationIds` 表示包含，`excludeTags` 和 `excludeOperationIds` 表示排除，排除优先于包含。过滤后，不被任何操作引用的 schema 不会输出。当共享包整体只用到定义的一部分时，这样可以让输出保持精简。如果只是各个应用使用不同的函数，不要按应用拆分目标，交给生产打包的 tree-shaking 即可（9.2）。拆分目标会让相同的类型重复出现在不同的文件中，应用之间也无法再共享类型。

## 11. 扩展 {#11-extensions}

扩展 tsurara 有三种方式。

1. 声明式设置：配置中的 `typeMappings`、`naming.overrides` 和 `overrides`（按 JSON Pointer 指定的类型），以及定义中的 `x-tsurara-type` 等扩展字段。
2. 外部命令钩子，可以用任何语言编写。

   | 钩子 | 输入和输出 |
   |---|---|
   | `transformDocument` | 通过 stdin 接收 JSON 格式的根定义，通过 stdout 返回转换后的定义 |
   | `transformModel` | 通过 stdin 接收 JSON 格式的模型（18.4.6），通过 stdout 返回转换后的模型。结果必须保留 `semVersion` |
   | `extend` | 通过 stdin 接收 JSON 格式的 `{ language, model, manifest, common, marker }`，通过 stdout 返回要添加的文件（`[{ path, contents }]`）（11.1） |
   | `transformFiles` | 接收 JSON 格式的输出文件列表（路径和内容），返回转换后的列表 |
   | `afterWrite` | 在写入之后运行。`{output}` 会被替换为输出目录 |

3. Rust 的 `Plugin` trait，面向把 tsurara 作为库嵌入的用户。外部命令钩子在内部也是该 trait 的实现。

外部类型（定义中的 `x-tsurara-type`，配置中的 `typeMappings` 和 `overrides`）会被原样写入生成的代码，因此每个后端都会先检查它们。类型必须是该语言受限语法下的类型表达式：TypeScript 中为标识符、限定名、类型参数、数组和元组、括号、`|`、`&`、不含转义的字符串类型和模板字面量类型（每个 `${...}` 也同样检查）以及数字；Python 中为名称、带点的名称、下标、`|`、字符串字面量和数字。分号、花括号、`=`、注释以及字面量之外的换行都会被拒绝。导入名称必须是标识符，模块必须是不含引号或反斜杠的说明符（TypeScript）或以点分隔的模块路径（Python）。来自定义的条目若未通过检查，会被忽略并给出 `invalid-definition` 警告，转而使用 schema 自身的类型；来自配置的条目则是配置错误。定义中的条目默认会被采纳：在这种语法下它们只能指名类型，而且导入只针对类型（TypeScript 中为 `import type`，Python 中位于 `if TYPE_CHECKING:` 之下），因此不会执行任何东西。

插件声明其挂接的阶段（document、model、extend、files）。每个阶段的输入是固定的，因此结果不依赖于插件的注册顺序。同一阶段的多个插件按配置中的书写顺序应用。

### 11.1 清单与 extend 阶段 {#111-the-manifest-and-the-extend-stage}

每个后端都会随文件一起返回一份清单：按名称列出它生成的内容，这样插件编写引用生成代码的文件时，无需重新推导那些可能因冲突、保留字和 `naming.overrides` 而改变的名称。

```jsonc
{
  "manifestVersion": 1,
  "language": "typescript",
  // The declarations of the model (`name` is the declaration's id in the model), in model order.
  "types": [{ "name": 3, "identifier": "ErrorModel", "file": "schemas/ErrorModel.ts" }],
  // The operations, then the webhooks.
  "operations": [{
    "operationId": "getPet",
    "kind": "operation",
    "function": { "identifier": "getPet", "file": "operations/getPet.ts" },
    "operationDef": { "identifier": "getPetDef", "file": "operations/getPet.ts" },
    "types": { "data": { "identifier": "GetPetData", "file": "operations/getPet.ts" }, "result": { ... } }
  }]
}
```

`file` 是声明该标识符的输出文件；插件按其语言的需要把它转换为导入（TypeScript 中为带配置扩展名的相对说明符，Python 中为模块路径，Rust 中为 `crate::…::types` 或 `…::operations`，Go 中则不需要，因为输出是一个包）。`types` 中的角色因语言而异：

| 语言 | 角色 | `operationDef` |
|---|---|---|
| TypeScript | `data`、`responses`、`errors`、`result`、`responseHeaders`、`event`、`item`；webhook 为 `request`、`responses` | `{name}Def` |
| Python | `result` | `DEF` |
| Rust | `options`、`body`（请求体有多种媒体类型时） | 无（私有） |
| Go | `options`、`body` | 无（未导出） |

后端自行添加的声明（被提升的内联 schema）在第一个版本中不会列出，文件导出的每个标识符也不会全部列出：插件把自己的文件放在单独的目录中（TypeScript、Python、Rust），或使用独特的前缀（Go，只有一个包），以避开生成的名称。清单与模型一样用 `manifestVersion` 标注版本。

extend 阶段在后端之后、`transformFiles` 之前运行。它接收模型（经过 model 插件处理之后）、清单、通用选项和生成文件标记，并返回要添加的文件。每个添加的文件都必须以标记开头，这样过时文件的删除和 `tsurara check` 才会覆盖它；没有标记的文件，或路径与生成文件相同的文件，都是错误。外部后端从协议 2 开始返回清单（18.11）；使用协议 1 时，清单为 `null`。输入中还带有语言的选项（`options`，`Backend::options_json`：TypeScript 中为导入扩展名、布局和客户端模块），使添加的文件与生成的文件保持一致。

### 11.2 插件模块 {#112-plugin-modules}

`plugins:` 列出的模块每次运行只用一个进程即可参与多个阶段，这与每个阶段启动一个命令的钩子不同。tsurara 只启动每个模块一次（默认通过 `@tsurara/plugin` 的运行器用 `node` 启动；其他 SDK 使用另一个 `runtime` 命令），工作目录为列出它的文件所在的目录，并通过 stdio 使用 `tsurara_backend::session` 的会话协议通信：每行一条 JSON 消息，先发 `hello`（带协议版本；版本不同时会停止运行并给出两个版本），然后为插件声明的每个阶段发一次 `call`，以 `result` 或 `error` 作答。在每个阶段中，插件模块在钩子之后按列出的顺序运行。消息定义在 `spec/plugin-protocol.schema.json` 中（`SessionRequest`、`SessionResponse`）。

`@tsurara/plugin`（`packages/plugin`）是 TypeScript SDK：包括 `definePlugin({ name, transformDocument, transformModel, extend, transformFiles })`，模型、清单和输入的类型（由 tsurara 自身根据协议 schema 生成，即 `src/generated/protocol.ts`），`ts.file`（一个按目标扩展名从清单导入并输出标记的写入器），以及供插件作者测试用的 `runPlugin`（`@tsurara/plugin/testing`）。插件模块是由 Node 22.18 或更高版本通过类型剥离运行的 TypeScript，因此没有构建步骤。`tsurara init --plugin` 会写入一个骨架；`examples/plugin-swr` 会写出 SWR hook。

其他 SDK 使用相同的会话：Python 的 `tsurara-plugin`（`packages/plugin-python`，以 `python -m tsurara_plugin <module>` 运行）、`github.com/tsurara-openapi/tsurara/packages/plugin-go`（`packages/plugin-go`）以及 `tsurara-plugin` crate（`crates/tsurara-plugin`）。Python 和 Go 的类型由 tsurara 自己的 Python 和 Go 后端根据协议 schema 生成，这也检验了它们对 JSON Schema 的支持；Rust crate 使用真实的类型。

## 12. CLI {#12-cli}

| 命令 | 说明 |
|---|---|
| `tsurara generate [--config <path>] [--target <name>] [--strict] [--format json]` | 生成并写入文件 |
| `tsurara check [--format json]` | 把生成结果与磁盘上的文件（包括内置的运行时，7.5）进行比较，不同时以退出码 1 结束。还会检测 `@tsurara/client` 的版本不匹配（内置运行时除外）。用于 CI |
| `tsurara init` | 创建配置文件模板 |
| `tsurara inspect operations [--tag t] [--search text]` | 操作列表：id、方法、路径、摘要，以及生成的函数和文件 |
| `tsurara inspect operation <id or "METHOD /path">` | 参数、请求体、响应、生成的函数和类型、其他生成的内容（清单中的 `helpers`：查询选项、键、过滤器、Mock 处理器），以及目标语言的调用示例 |
| `tsurara inspect schema <name>` | 某个 schema（按定义中的名称或生成的名称指定）生成的名称、文件和声明 |
| `tsurara inspect warning <code>` | 某个警告代码的含义及解决方法（6.8） |

`--format json` 在 stdout 上打印一个 JSON 对象而不是多行文本，供脚本和编程智能体使用：对 `generate`，按目标列出写入、未变化和删除的文件以及警告（代码、文档、JSON Pointer、消息）；对 `check`，按目标列出差异和运行时问题；失败以 `error` 输出，退出码为 1。`spec/cli-output.schema.json` 根据 Rust 类型（`tsurara_cli::output`）生成。`inspect` 子命令接受 `--target`（有多个目标时必填）和 `--format json|text`，在不写入任何内容的情况下读取模型、清单（11.1）和生成的文件，并用 `Backend::example` 根据示例值（18.7.1）构建调用示例：一个放在生成代码旁边即可编译的文件（输出根目录下的 `example.ts`；包中的 `example.py`；`mod.rs` 旁边、以 `mod example;` 声明的 `example.rs`；包中的 `example.go`），并按各语言的方式处理 Result。不是普通标量的参数在 Rust 和 Go 中从 JSON 解码，在 Python 中通过 TypeDef 编解码器解码；非 JSON 的请求体留给应用填写。

### 12.1 MCP 服务器 {#121-mcp-server}

`tsurara mcp` 是同一个二进制文件中基于 stdio 的 Model Context Protocol 服务器：JSON-RPC 2.0，每行一条消息，在 `tsurara-cli/src/mcp.rs` 中不借助 SDK 实现（Rust 的 SDK 需要比 MSRV 更新的编译器）。它的工具是 `inspect`、`generate` 和 `check` 之上的薄层，同时返回简短文本和 CLI 的 JSON（`structuredContent`）：`list_targets`、`search_operations`（查询中的每个单词都必须是 id、方法、路径、摘要或标签中某个单词的开头；`offset` 和 `limit`，默认 50）、`describe_operation`（附带 107 中的调用示例）、`describe_schema`、`generate`（与 CLI 一样，只写入配置的输出目录）、`check`（偏差作为结果返回，而不是工具错误）以及 `explain_warning`。指南（`docs/guide/*`、`docs/languages/*`）在构建时嵌入，并作为资源列出（`tsurara://docs/guide/configuration.md`）。客户端的设置方法见 `docs/guide/ai.md`；`.claude-plugin/plugin.json` 把该服务器注册为 Claude Code 插件，插件中还包含 skill `skills/tsurara`（其代码块会针对生成的代码进行类型检查）。`tsurara init --agents` 把面向智能体的规则写入 `AGENTS.md` 或 `CLAUDE.md`，仓库根目录下的 `llms.txt`/`llms-full.txt` 为文档建立索引。

`tsurara check` 会发现定义与生成文件之间的偏差（忘记重新生成、手动编辑生成的文件），以及生成代码与 `@tsurara/client` 之间的版本偏差。防止服务器实际响应与定义之间的偏差，是后端契约测试等的职责。

## 13. 质量保证 {#13-quality-assurance}

- 语料库测试：根据大型真实定义（GitHub、Stripe、Kubernetes、OpenAI 等）和收集了边界情况的定义进行生成，并让输出通过 `tsc --noEmit`。会检查以下 tsconfig 组合。
  - `strict`、`erasableSyntaxOnly`、`verbatimModuleSyntax`、`exactOptionalPropertyTypes`、`noUncheckedIndexedAccess`、`isolatedDeclarations`
  - `moduleResolution` 设为 `nodenext` 和 `bundler`
- 映射表测试：6.4 中表格的每一行都是一个带有输入和期望输出的测试。期望输出会对照 JSON Schema 的含义进行检查。只比较打印出的类型字符串，无法发现期望值本身的错误（例如把 `prefixItems` 元组做成定长的错误）。
- 可赋值性测试：检查定义允许的值可以赋给生成的类型，而赋予定义不允许的值时 `@ts-expect-error` 成立（035 中的工作）。不承诺 TypeScript 能检查所有约束。对于 6.4.1 中近似处理的约束，测试会写明这些值是作为近似被接受的。
- 类型剥离检查：在 CI 中检查输出可以用 Node 的类型剥离导入并运行，并且能通过所支持的最低 TypeScript 版本（5.8）和开发所用版本的 `tsc`（`crates/tsurara-lang-typescript/tests/type_stripping.rs`；所有 tsc 测试都会运行两个版本）。
- 基于属性的测试：根据随机构建的 schema 进行生成，并检查能通过 `tsc`。`crates/tsurara-cli/tests/properties.rs` 用 proptest 构建定义（组合、可空值、带循环的引用、readOnly 和 writeOnly、判别字段、对命名构成压力的名称），在一次 `tsc`（最严格的 tsconfig）和 pyright 运行中检查所有用例，并以每步一次检查的方式缩小失败的用例；最小的定义保存在 `target/proptest-failures` 中，以便添加到 `corpus/edge-cases`。CI 以固定种子运行 48 个用例，每周的 workflow 以新种子运行 2000 个（`TSURARA_PROPTEST_CASES`、`TSURARA_PROPTEST_SEED`）。它发现了通过引用指向自身的别名，这类别名现在会变为 `unknown`，或在给出警告后失去这些引用。
- 快照测试：保存完整的输出，检测意外的变化。
- 运行时库测试：按 OpenAPI 的 style 测试序列化和响应解析。模拟各种失败，检查每种 Result `kind` 都能正确返回。
- E2E 测试：在两个应用中运行 `examples/pnpm-monorepo`，从生成一直到调用。
- 性能测量：在 CI 中记录大型定义的生成时间和 `tsc` 时间，并检测退化。比较从 barrel 导入和直接导入时的 Node 启动时间、开发服务器加载和 `tsc` 时间。`pnpm bench`（`scripts/bench.mjs`）针对语料库中的 GitHub（3.1）、Stripe、Kubernetes 和 OpenAI，测量 release 二进制文件的生成时间、对整个输出运行 `tsc --extendedDiagnostics`（时间和类型实例化次数），以及通过 barrel 和通过子路径导入一个操作时的 `tsc` 和启用类型剥离的 Node 启动时间。CI 的 `bench` 任务会把每次推送到 main 的结果与之前的结果比较（实例化超过 +5%、时间超过 +50%），并把结果保存为 artifact。尚未测量 Vite 开发服务器。

  2026-11-11 的结果（Apple silicon，TypeScript 7.0.2，Node 26）：

  | 定义 | 生成 | 对输出运行 `tsc` | 实例化 | Node 启动，barrel / 子路径 |
  |---|---|---|---|---|
  | GitHub 3.1 | 704 ms | 184 ms | 22 933 | 212 / 54 ms |
  | Stripe | 390 ms | 130 ms | 24 718 | 151 / 54 ms |
  | Kubernetes | 397 ms | 156 ms | 35 748 | 229 / 53 ms |
  | OpenAI | 313 ms | 107 ms | 13 313 | 115 / 53 ms |

  正如 9.2 所预期的，通过 barrel 导入会让 Node 加载所有操作模块（启动时间是从子路径导入一个操作的 2 到 4 倍）；无论哪种方式，`tsc` 的时间都很短。

### 13.1 测试语料库 {#131-test-corpus}

| 定义 | 来源 | 主要检查内容 |
|---|---|---|
| Petstore（2.0、3.0、3.1） | OpenAPI Initiative 和 Swagger 的官方示例 | 基本转换、Swagger 2.0 规范化 |
| GitHub REST API | github/rest-api-description | 大型定义、`oneOf`/`anyOf`、nullable |
| Stripe | stripe/openapi | `anyOf` 和可展开字段、urlencoded 请求体 |
| Kubernetes | kubernetes/kubernetes 中的 `api/openapi-spec` | 深层引用、`x-kubernetes-*` 扩展 |
| OpenAI | openai/openai-openapi | discriminator、顺序格式（`text/event-stream`）、multipart |
| 边界情况 | 在本仓库中编写 | 循环、保留字、特殊的属性名、各种判别字段模式 |

来源固定到某个提交哈希或标签，并用 sha256 校验（`corpus/sources.json`）：包括 3.0 和 3.1 两种描述的 GitHub、Stripe、Kubernetes（Swagger 2.0）、OpenAI（3.1）以及 Petstore 2.0。`pnpm corpus:fetch` 把它们下载到 `target/corpus`，`crates/tsurara-cli/tests/corpus.rs` 用 `tsurara` 二进制文件为每种语言生成每个定义，用 TypeScript 7.0.2 和 5.8 以 tsconfig 组合检查 TypeScript 输出，并用 pyright 检查 Python 输出。边界情况位于 `corpus/edge-cases`；在真实定义中发现的每个缺陷都会在那里添加一个，这样无需下载也能检查。无法解析的引用会让测试失败，因为在这些定义中，它意味着 tsurara 的缺陷。

## 14. 稳定性与版本管理 {#14-stability-and-versioning}

以下五项受稳定性承诺覆盖，只在 semver 主版本中改变。

1. 生成名称的规则
2. Result 的形状
3. OperationDef 格式
4. 配置文件的 schema
5. 外部程序与 tsurara 交换的 JSON：模型、清单，以及插件和外部后端的协议（`spec/sem-model.schema.json`、`spec/manifest.schema.json`、`spec/plugin-protocol.schema.json`）

第 1 项承诺的是命名规则，而不是在定义变化时个别名称永远不变。例如，添加一个 readOnly 属性会改变请求一侧的类型名（6.5），名称中的编号可能随定义的顺序而变（6.6）。这类变化可以通过 `tsurara check` 的差异和警告察觉。

第 5 项有自己的版本字段，使其他仓库中的插件和后端可以检查它们收到的内容：

- 兼容的变更保持版本不变：新增可选字段，或把字段改为可选。使用方忽略不认识的字段；Rust 类型就是这样做的，105 和 106 的 SDK 也必须如此。
- 其他所有变更都会改变版本（`semVersion`、`manifestVersion`、`protocol`）：删除字段、重命名、改为必需或改变类型，以及为枚举新增变体（新的类型种类或警告代码），因为使用方会对枚举进行穷尽匹配。
- CLI 只产生一种模型和清单版本。对于未列出当前 `semVersion` 的外部后端，它会拒绝并给出两个版本，而不是把模型降级转换；协议则保留只在可选部分上不同的旧版本（协议 1 和 2，18.11）。
- 对这三个 schema 的每一次变更，无论是否兼容，都会连同新 schema 的哈希记录在 `spec/CHANGELOG.md` 中；schema 发生变化却没有记录时，测试会失败。从首次发布起，每个被取代版本的 schema 都会保存为 `spec/versions/<schema>-<version>.json`。

在首次发布之前，`semVersion` 和 `manifestVersion` 保持为 1，变更日志记录变更但不提升版本；外部后端已经在协商的协议则从一开始就标注版本。

依赖保持在最低限度。生成器是单个二进制文件，`@tsurara/client` 只依赖标准 API。

内置运行时（7.5）是生成输出的一部分，而不是库：它的源码像生成的代码一样随生成器变化，上述承诺适用于生成的代码对它的使用（Result 的形状、OperationDef 格式），而不适用于它的内部文件。

## 15. 不在范围内 {#15-out-of-scope}

初始版本不处理以下内容。每一项都在结构上留有余地，可以在之后作为插件或 `@tsurara/client` 的功能加入。

- 从 `date-time` 到 `Date`、从 `int64` 到 `bigint` 的运行时转换
- 根据 `$dynamicRef` 生成泛型类型

校验的职责划分如下。tsurara 生成类型和调用函数，类型假定响应与定义一致。

- 校验 API 响应是否与定义一致：可选，通过 `validate` 选项和生成的 Zod schema 进行（8.7）。要防止服务器实现与定义之间的偏差，仍然最好依靠后端的契约测试（第 12 章）。
- 校验 UI 表单：不在 tsurara 的范围内。请求类型（`Writable` 类型）可以作为表单最终提交的值的契约，但校验输入过程中的值和显示错误信息是应用的职责。
- 为 Zod 生成 schema：`typescript.validators: zod`（8.7），与类型分开的文件。

## 16. 未决问题 {#16-open-questions}

| # | 问题 | 为何仍未决 |
|---|---|---|
| 1 | 把工作中使用的定义（或结构相似的定义）加入测试语料库 | 一旦提供了这样的定义就会加入。公开的定义已按 13.1 确定 |
| 3 | 是否引入记录已分配名称的锁文件（`tsurara.names.json` 之类） | 这是补充名称稳定性（6.6）的一个选项。先观察带警告地让冲突的派生名称让开是否足够，再作决定 |
| 4 | 是否提供只输出类型、不输出调用函数的模式 | 来自整合评审的提议，不属于需求。如果采纳，会另开一个 issue |

### 16.1 已决事项 {#161-decisions}

| 问题 | 决定 | 体现在 |
|---|---|---|
| 与全局名称冲突的 schema 名称 | 加上后缀 `Model`，仍冲突时再加编号 | 6.6 |
| Next.js 读取共享包所需的设置 | 只需在其 tsconfig 中设置 `allowImportingTsExtensions`；不需要 `transpilePackages`（Next.js 16.4，Turbopack 和 webpack） | 9.2 |
| 如何按 readOnly/writeOnly 拆分 | 原类型去掉 writeOnly，`Writable` 类型去掉 readOnly | 6.5 |
| Swagger 2.0 是否在最初的范围内 | 是 | 5.4 |
| `date-time` 的默认值 | `string`。`Date` 将来与运行时转换一起加入 | 10.4 |
| 测试语料库 | 13.1 中的定义 | 13.1 |
| TypeScript 和 Node 的最低版本 | TypeScript 5.8 或更高，Node 22 或更高 | 第 17 章 |
| 是否把带判别字段的父 schema 变为通过 allOf 继承它的子 schema 的联合 | 否。判别字段不改变校验结果，因此只添加用于判别的字面量 | 6.5 |
| 3.0 中写在 `$ref` 旁边的 `nullable` | 按规范忽略并给出警告。没有采纳兄弟键的兼容模式 | 6.3 |
| 派生的类型名与其他名称冲突时 | 其他名称保留它；派生名称在后缀前加上 `Operation`，并给出警告（参考 kubb） | 6.6 |
| 既在 JSON 中使用、又作为 multipart 请求体使用、且含有二进制部分的具名 schema | 具名类型遵循 JSON（`string`）；multipart 请求体把该 schema 内联展开，并把二进制部分设为 `Blob \| File` | 6.4 |
| 通配媒体类型的处理 | 按实际的 Content-Type 解析（`auto`），类型为可能值的联合。可通过配置视为 JSON | 8.5 |
| 生成 TypeScript 以外的语言 | 与语言无关的语义模型、共享的命名、降级和运行时契约，以及每种语言一个后端；TypeScript 第一，Python 第二 | 18 |
| 多语言设计中的未决问题（Q1 到 Q7） | 见 18.16 | 18.16 |

## 17. 支持的环境 {#17-supported-environments}

| 对象 | 最低版本 | 原因 |
|---|---|---|
| TypeScript | 5.8 | 引入 `erasableSyntaxOnly` 的版本。开发使用 7.0.2；CI 用两者进行类型检查 |
| Node | 22 | Node 20 的支持已于 2026 年 4 月结束。用类型剥离直接运行生成的代码需要 22.18 或更高版本 |
| Rust（构建生成器） | 1.85 | 使用 edition 2024 |
| Python（生成的代码和 `tsurara-client`） | 3.11 | 18.16，Q2 |

`@tsurara/client` 需要 `fetch`、`Request`、`Response`、`Headers`、`AbortController` 和 `URL`（仅其构造函数）。`ReadableStream`、`Blob`、`FormData`、`URLSearchParams`、`AbortSignal.any` 和 `DOMException` 存在时才会使用，因此在缺少其中一部分的环境（如 React Native）中客户端也能运行：没有它们时，请求、超时和中止仍能工作，React Native 的文件对象（`{ uri, name, type }`，通过 `reactNativeFile` 传入）会作为文件部分上传。流式响应需要支持流式响应体的 `fetch`（Expo 中为 `expo/fetch`）；没有时，`parseAs: 'stream'` 会返回 `kind: 'parse'`。在 Hermes 上，`runtimes/typescript/hermes`（`@tsurara/hermes-check`）会像 Metro 一样，用 React Native 自带的 `fetch`、`FormData` 和 `URL` polyfill 及其 Babel 预设打包客户端：由 React Native 0.88 的 `hermesc` 编译，并在最后一个 Hermes CLI 发布版本（v0.13.0，对应 React Native 0.75 的时期）的 VM 上运行 JSON 调用、basic 认证、使用 `reactNativeFile` 的 multipart 上传、超时、中止，以及没有流式 `fetch` 时流的 `parse` 失败。尚未在真机上验证 React Native 和 Expo。

## 18. 多种语言 {#18-multiple-languages}

tsurara 从一份 OpenAPI 定义为多种语言生成代码：目前是 TypeScript，接下来是 Python、Rust、C#、Go、PHP、Ruby、Kotlin、Java、Swift 和 GDScript，之后还会更多。本章描述的架构让添加新语言主要变成编写规则和打印器，而不是编写一个新的生成器。凡是与描述当前仅 TypeScript 实现的第 4、6、7、10、11 章不同之处，本章就是目标。

### 18.1 目标与非目标 {#181-goals-and-non-goals}

目标：

- G1. 无需改动 OpenAPI 文档的分析，即可把一种语言作为后端加入。
- G2. 每种语言都先有类型，再有调用函数和实现共享运行时契约（18.9）的运行时库。
- G3. 后端的大部分是共享的机制：命名（18.6）、降级（18.5）、值转换元数据（18.7）和格式化打印（18.8）。语言特有的部分是命名策略、能力集和打印器。
- G4. 语义模型与语言无关、可序列化并带有版本。它是 IR 插件以及以外部程序形式编写的后端（18.11）的输入。
- G5. 同一语言的其他输出（Zod schema、MSW 处理器、pydantic 模型）是构建在同一机制之上的后端或后端变体。

非目标：

- 与当前 crate API、配置键、OperationDef 形状或生成名称的兼容。tsurara 处于 0.x，只有一名开发者，因此允许在版本之间进行破坏性变更（2026-11-09 决定）。唯一的兼容规则是内部的：作为安全网，重构步骤保持 TypeScript 输出逐字节相同，有意的输出变更是单独的、经过评审的步骤。
- 现在就实现所有语言。TypeScript 和 Python 优先（18.14）。

### 18.2 语言调研 {#182-language-survey}

每种语言对生成器的需求。18.5 中的能力集和 18.7 中的转换策略都来自此表。

| 语言 | 类型系统 | 值转换（18.7） | 主要约束 |
|---|---|---|---|
| TypeScript | 结构化：联合、字面量、交叉、索引签名 | 无：解析后的 JSON 就是带类型的值 | `erasableSyntaxOnly`、`isolatedDeclarations` |
| Rust | 名义类型；带数据的 enum，没有继承 | 注解（serde） | 递归需要 `Box`；缺失与 `null` 的区分；带重命名的 snake_case 字段 |
| C# | 名义类型；单继承，没有联合 | 注解（System.Text.Json） | 多态只能通过类层次上的特性实现；可空引用类型 |
| Go | 名义类型；没有联合、没有继承，有嵌入 | 注解（struct 标签）加上用于联合的运行时辅助函数 | 可选值通过指针表示；导出名称和首字母缩略词（`ID`、`URL`）；每个目录一个包 |
| Kotlin | 名义类型；sealed class | 注解（kotlinx.serialization） | 类判别字段的约定 |
| Java | 名义类型；record、sealed interface，没有联合 | 注解（Jackson） | 包等于目录；文件名等于类名 |
| Swift | 名义类型；带关联值的 enum | 注解（Codable） | 缺失与 `null` 的区分；递归 struct 需要间接引用 |
| Python | 结构化（TypedDict）或名义（dataclass） | TypeDef 元数据（18.7）；pydantic 变体使用注解 | 同步和异步客户端；关键字作为字段名 |
| PHP | 名义类；有限的联合；没有泛型，元素类型只在 PHPDoc 中 | TypeDef 元数据 | 类型分散在原生声明和 PHPDoc 中；PSR-4 命名空间 |
| Ruby | 没有静态类型；RBS 签名 | TypeDef 元数据 | 每个单元两个文件（`.rb` 和 `.rbs`） |
| GDScript | 名义类型；没有联合、没有可空基本类型、除带类型的 `Array`/`Dictionary` 外没有泛型、只有整数枚举、全局 `class_name` | TypeDef 元数据 | JSON 数字被解析为浮点数；没有异常；HTTP 通过信号和 `await` 进行；`.uid` 附属文件 |

### 18.3 架构 {#183-architecture}

```
输入
  → tsurara-loader：DocumentSet
  → 插件（document 阶段）
  → tsurara-sem：分析 → sem::Model（可序列化，带版本）
  → 插件（model 阶段：Rust trait 或 `transformModel` 命令）
  → 后端（内置 crate，或外部程序；18.11）
      a. 命名：使用语言 NamingPolicy 的 tsurara-naming                 (18.6)
      b. 降级：使用语言 Capabilities 的 tsurara-lower → tir            (18.5)
      c. 运行时元数据：OperationDef 和 TypeDef                         (18.7, 18.9)
      d. 用 tsurara-pretty 打印、文件布局、标记                        (18.8)
  → 插件（files 阶段）
  → tsurara-cli：写入、删除过时文件、check
```

#### 18.3.1 Crate {#1831-crates}

| Crate | 内容 |
|---|---|
| `tsurara-loader` | 不变 |
| `tsurara-sem` | 语义模型、从 `DocumentSet` 构建它、共享的规范化、语义警告、serde 序列化 |
| `tsurara-naming` | 带作用域的名称分配和 `NamingPolicy` trait |
| `tsurara-lower` | 降级后的类型 IR（`tir`）、`Capabilities`、降级 pass 和校验器 |
| `tsurara-pretty` | 所有打印器共享的 Wadler 风格文档打印器 |
| `tsurara-backend` | 只有接口：`Backend` trait、`Output`、`Markers` 以及外部后端协议的类型。它不依赖任何语言 crate |
| `tsurara-lang-<language>` | 每种语言一个 crate：命名策略、能力、语言特有的 pass、打印器、布局、选项 |
| `tsurara-config` | 配置；每种语言的选项来自其后端 crate |
| `tsurara-cli` | `tsurara` 命令。它依赖所有内置的 `tsurara-lang-<language>` crate，并拥有把 `language` 值映射到后端的注册表，因此它下面的任何 crate 都不依赖语言 crate |
| `tsurara-testkit` | 各语言的检查器（18.12） |

原来的 `tsurara-codegen` crate 已经不存在：它的分析移到了 `tsurara-sem`，`emit.rs` 移到了 `tsurara-lang-typescript`。命名移到了 `tsurara-naming` 和 TypeScript 后端。`ir.rs` 是模型中与语言无关的类型 IR，由 `tsurara-lower` 和每个后端使用；只有它的变体 `Undefined`、`Ref`、`External` 和 `Builtin` 属于 TypeScript 的降级（它们从不出现在模型中，也不会被序列化）。`print.rs`（TypeScript 类型打印，规范化也用它来获得稳定的成员顺序）和 `options.rs`（通用选项）也留在 `tsurara-sem` 中；043 到 045 把仅 TypeScript 使用的选项和命名移了出去，留下了这些。

```rust
pub trait Backend {
    /// `typescript`, `go`, ... Used as the `language` value in the configuration.
    fn id(&self) -> &'static str;
    fn capabilities(&self) -> &Capabilities;
    fn naming(&self) -> &dyn NamingPolicy;
    fn markers(&self) -> &Markers;
    /// Parses and validates the language section of the configuration.
    fn options(&self, raw: &serde_json::Value) -> Result<Box<dyn Any>, OptionsError>;
    fn generate(&self, model: &sem::Model, common: &CommonOptions, opts: &dyn Any) -> Result<Output, Error>;
}
```

### 18.4 语义模型 {#184-semantic-model}

语义模型保存定义的含义。它不是所有语言类型系统的并集，也不包含为某种语言选定的标识符。

#### 18.4.1 Schema {#1841-schemas}

```rust
pub enum Schema {
    Any,
    Never,
    Null,
    Boolean,
    Integer { format: Option<String> },          // int32, int64, ...
    Number { format: Option<String> },           // float, double, decimal, ...
    String { format: Option<String>, content: Option<Content> },
    /// A raw byte value: only where the value is the HTTP body itself or a multipart part (6.4).
    Binary,
    Const(serde_json::Value),
    Enum(Enum),
    Ref(SchemaId),
    Array { items: Box<Schema>, unique: bool },
    Tuple(Tuple),
    Object(Object),
    Union(Union),
    /// `allOf`: the conjunction of its members, which may be any schemas (objects, references,
    /// scalars, unions). Only the inline objects among them are merged (see the rules below).
    AllOf(Vec<Schema>),
    Nullable(Box<Schema>),
    External(ExternalId),
}

pub struct Object {
    pub properties: Vec<Property>,
    /// `additionalProperties`, unwidened.
    pub additional: Option<Box<Schema>>,
    pub patterns: Vec<(String, Schema)>,
}

pub struct Property {
    /// The JSON key, exactly as in the definition. Backends assign member names (18.6).
    pub wire_name: String,
    pub schema: Schema,
    pub required: bool,
    pub read_only: bool,
    pub write_only: bool,
    pub default: Option<serde_json::Value>,
    pub doc: Option<Doc>,
    pub pointer: String,
}

pub struct Union {
    /// Members as written, including duplicates and nested unions (see the rules below).
    pub members: Vec<Schema>,
    /// `oneOf` is exclusive, `anyOf` is not.
    pub exclusive: bool,
    pub discriminator: Option<Discriminator>,
}

pub struct Discriminator {
    pub property: String,
    /// The values that select each member, in member order.
    pub values: Vec<Vec<String>>,
    /// `defaultMapping` (3.2).
    pub default: Option<SchemaId>,
}
```

哪些内容属于 `tsurara-sem` 的规则：

- 这里只保留在 JSON Schema 语义下精确的规范化：合并 `allOf` 成员中的内联对象、展平嵌套的 `anyOf` 并去除重复的 `anyOf` 成员（`anyOf` 满足结合律和幂等性）、把 nullable 的三种写法统一为 `Nullable`、静态解析 `$dynamicRef`、readOnly/writeOnly 分析。
- `oneOf` 保留其结构和重数。`oneOf: [A, A]` 会拒绝所有匹配 `A` 的值，嵌套的 `oneOf` 也不满足结合律，因此展平或去重会改变哪些值有效。联合类型本来就是包含性的后端（TypeScript）在自己的 pass 中展平和去重。
- 不是对象的 `allOf` 成员（标量、数组、联合）保留为 `AllOf` 的成员。TypeScript 像现在一样对它们求交；其他后端在降级中处理它们（18.5.3，pass 2）。
- 因为某种语言的类型系统而存在的内容，都移到该语言的 pass 中：把联合吸收为 `unknown`、扩宽索引签名、把判别字段表示为与字面量对象的交叉、把 `Nullable(X)` 表示为 `X | null`、把枚举表示为字面量联合。
- 继承的判别字段（通过 `allOf` 引用父 schema 的子 schema）作为标签（`Tag { property, values }`）保存在子 schema 的 `allOf` 成员中，而不是预先作为字面量对象应用。

在实现中，`Union` 名为 `Choice`（`tsurara_sem::ir::Choice`），`AllOf` 仍是共享 IR 中的交叉节点；它保留所有成员，只合并内联对象。
- 定义中的值（`const`、`enum`、`default`、`example`）保存为 JSON 值，而不是字符串。

#### 18.4.2 声明与内联候选 {#1842-declarations-and-inline-candidates}

```rust
pub struct SchemaDecl {
    pub id: SchemaId,
    /// The name the definition asks for (components key, title, or derived name), before any sanitizing.
    pub preferred_name: String,
    /// Whether the preferred name came from the definition and should be kept when valid.
    pub preserve: bool,
    /// `Read`, or `Write` for the `Writable` variant.
    pub mode: Mode,
    pub schema: Schema,
    pub inherited_discriminator: Option<(String, Vec<String>)>,
    pub doc: Option<Doc>,
    pub pointer: String,
}
```

每个内联对象、枚举和联合都是一个提升候选，带有自己的 `SchemaId`、由位置推导出的首选名称，以及一个 JSON Pointer：

- 所有者的首选名称加上转为 PascalCase 的属性名（`Pet` + `owner` → `PetOwner`），
- 数组条目用 `Item`，映射值用 `Value`，联合成员用成员索引（`PetKind1`），
- 对于操作，用操作的首选名称加上角色（`GetPetByIdQuery`、`GetPetById200`）。

在实现中，候选是 `Type::Inline { preferred_name, loc, ty }`，它包裹位于嵌套位置的内联对象、枚举和联合（也包括可空联合中的非 null 成员）：属性值、条目、映射值、联合成员，以及请求体、参数和响应头的 schema。`allOf` 成员不是候选，因为它们会合并到其所有者中。首选名称是所有者的首选名称（声明，或转为 PascalCase 的操作 id）加上路径：转为 PascalCase 的属性名或响应头名，条目用 `Item`（`prefixItems` 用 `Item1`、`Item2`），映射值用 `Value`，`oneOf`/`anyOf` 用从 1 开始的成员索引，请求体用 `Body`，响应用状态码（`200`、`Default`），参数用其 `name`（而不是索引）。`tsurara_backend::hoist::claim_candidates` 在声明和操作之后按模型顺序为它们命名，并遵循按 JSON Pointer 指定的 `naming.overrides`。

哪些候选会成为具名类型由降级（18.5）决定。TypeScript 后端命名的内容与现在完全相同：组件、通过 `$ref` 到达的每个非组件 schema（例如 `#/components/schemas/Pet/properties/owner`，无论是否有循环，参见 `Converter::ref_type`），以及从操作派生的类型。其他所有候选都保持内联。

#### 18.4.3 操作 {#1843-operations}

`Operation`、`Param`、`Body`、`Response` 和 `Status` 保持当前的含义，只有以下变化：

- 其中的类型是 `Schema`；响应头是 `Property` 值。
- 操作带有 `preferred_name`、`OpKind` 和一个指针；函数名和派生的类型名由后端分配。
- `ParseAs` 变为描述 HTTP 载荷的 `BodyKind`（json、text、binary、stream、none）。
- servers、标签以及安全要求和方案为运行时而保留（Q4）。

#### 18.4.4 外部类型 {#1844-external-types}

`x-tsurara-type` 和类型映射是按语言划分的。在语义模型中，被映射的 schema 保留它自己的 schema，外加一个 `ExternalId`；没有该 id 条目的后端使用 schema 并给出警告。

```yaml
# 在定义中
x-tsurara-type:
  typescript: { type: Uuid, import: { from: ./uuid, name: Uuid } }
  rust: { type: uuid::Uuid }
  go: { type: github.com/google/uuid.UUID }
```

#### 18.4.5 文档与警告 {#1845-docs-and-warnings}

`Doc` 保存描述和结构化的标签（`deprecated`、`default`、`example`、`format`，以及作为值而非字符串的约束）。每个打印器用自己的语法输出它们（JSDoc、rustdoc、XML 文档、docstring、PHPDoc、`##`）。

语义警告（无法解析的引用、被忽略的 `$ref` 兄弟键、被舍弃的 `not`/`if`/`then`/`else`、静态解析的 `$dynamicRef`）从不提及任何语言。降级和打印会产生指明语言的后端警告。

#### 18.4.6 序列化与不变量 {#1846-serialization-and-invariants}

`sem::Model` 实现了 `Serialize` 和 `Deserialize`，并带有 `sem_version`。其 JSON Schema 为 `spec/sem-model.schema.json`，与清单和插件协议的 schema 一起由 Rust 类型生成。JSON 形式就是 serde 的形式：字段和变体名使用 camelCase，枚举采用外部标签（`{ "scalar": { "kind": "integer", "format": "int64" } }`，单元变体为 `"unknown"` 这样的字符串），位置为 `{ "doc": url, "pointer": pointer }`，文档标签为 `[name, value]` 对，其值为定义中原样写出的 JSON。`semVersion`（`tsurara_sem::SEM_VERSION`，当前为 1）只在形式发生不兼容变化时才改变；使用方会拒绝不认识的版本。只有后端产生的类型（`Builtin`）从不出现在其中。外部后端和 `transformModel` 钩子接收的就是这种 JSON 形式（18.11），语义用例测试比较的也是它（18.12）。

顺序是模型的一部分：先按文档顺序排列组件，再按发现顺序排列提升候选，然后是操作，最后是 webhook。名称分配遵循这一顺序（18.6），因此它是一个有文档说明的不变量。

### 18.5 降级 {#185-lowering}

降级把语义模型转换为 `tir`，这是一种能表达任何语言所拥有的每种结构的类型 IR。后端声明它接受哪些结构，共享的 pass 改写其余部分。降级之后，校验器检查能力集之外的结构是否都已消失；如有违反，就是某个 pass 的缺陷。

#### 18.5.1 降级后的类型 IR {#1851-the-lowered-type-ir}

`tir` 包含具名声明和类型表达式。

- 声明：`Record`（字段带有传输名称、成员名称、存在性以及可选的基类）、`Enum`（值，开放或封闭）、`TaggedUnion`（判别属性、变体）、`UntaggedUnion`（成员，按顺序尝试解码）、`Alias`。
- 表达式：`Scalar`（bool、带宽度和符号的整数、带宽度的浮点数、decimal、string、bytes、date、date-time、uuid 等）、`List`、`Map`、`Tuple`、`Optional`、`Nullable`、`Any`、`Named`、`External`，以及供拥有这些结构的语言使用的结构化形式 `InlineRecord`、`Union`、`Intersection` 和 `Literal`。

#### 18.5.2 能力 {#1852-capabilities}

| 能力 | 含义 | 示例值 |
|---|---|---|
| `inline_records` | 其他类型内部的匿名对象类型 | TS、Go：yes（Go 后端仍可能出于可读的公开 API 的考虑按策略提升）；Python（TypedDict 需要具名声明，dataclass 是类）、Java、C#：no |
| `structural_unions` | 任意类型的联合 | TS、Python：yes；Rust、Swift：no（只有带标签的）；Go、Java、C#、GDScript：no |
| `tagged_unions` | 带数据的和类型，或带判别字段的 sealed 层次结构 | Rust、Swift、Kotlin、Java、C#：yes；Go、GDScript：no |
| `intersections` | `A & B` | 仅 TS |
| `inheritance` | 无、单继承或多继承（接口） | C#、Kotlin：单继承；Go、Rust：无 |
| `literal_types` | 字面量类型和 const 类型 | TS、Python |
| `enums` | 字符串值、仅整数或无 | GDScript：仅整数 |
| `tuples` | 定长和变长元组 | TS、Python、Rust、Swift |
| `presence` | 如何区分“缺失”和 `null` | TS：`?` 和 `\| null`；Rust：`Option<Option<T>>`；Go：指针加运行时包装 |
| `nullable_primitives` | `int` 等能否容纳 `null` | GDScript：no |
| `recursion_by_value` | 类型能否不经间接引用而包含自身 | Rust、Swift：no |
| `integer_widths` | 存在哪些整数和浮点数宽度 | TS：无（全部为 `number`）；Java：32/64 |
| `maps` | 值带类型的映射，以及带额外映射字段的记录 | 4.4 之前的 GDScript：仅无类型 |

#### 18.5.3 Pass {#1853-passes}

各 pass 按以下顺序运行。能力使某个 pass 不再必要时，就跳过它。

1. 用首选名称提升该语言无法内联书写的内联候选。
2. `allOf`：有 `intersections` 时为交叉类型。否则，当每个成员都是对象或指向对象的引用时：如果只有一个引用且 `inheritance` 允许，就用作基类，否则复制被引用声明的属性。当某个成员不是对象时（`allOf: [{ type: string }, { anyOf: [...] }]`），使用该语言能表达的最具体的成员，并警告其他约束被舍弃。
3. 带判别字段的联合：有 `tagged_unions` 时为带标签联合；否则为由运行时辅助函数解码的不带标签联合（18.7）。
4. 不带判别字段的联合：有 `structural_unions` 时为结构化联合；否则为不带标签联合，当成员无法区分时为 `Any` 并给出警告。
5. 枚举：允许的地方使用原生枚举，否则使用常量。开放与否按使用位置的方向决定，而不是按声明决定，也不取决于 `splitVisibility` 或 readOnly/writeOnly。降级会把每个使用位置标记为发送（请求体和参数、webhook 响应）或接收（响应、webhook 请求）。在接收值的位置，对于反序列化器遇到未列出的值就会失败的语言，枚举是开放的：值保存在兜底中（`Unknown(String)` 变体或以字符串为底层的值类型），`strictEnums` 选项可以关闭这一行为。在发送值的位置，枚举是封闭的。在两个方向上都使用的组件枚举会获得两种表示：一个封闭类型，以及一个在接收位置使用的开放类型（或者在语言允许时，使用一个开放类型，其构造函数只接受列出的值）。
6. 带判别字段的联合按同样的方向规则，为未列出的判别值获得同样的兜底。

TypeScript 在两个方向上都保持封闭的字面量联合（2026-11-09 决定）。接收到联合之外的值会让类型不准确，但永远不会在运行时失败，输出也保持逐字节相同。开放枚举只在未列出的值会导致解码失败的语言（Python 及之后的语言）中作为默认。
7. 字面量和 `const`：允许的地方使用字面量类型；否则使用底层标量，并把值写在文档中。
8. 存在性：可选和可空变为该语言的表示。区分缺失和 `null` 的包装类型只用于既可选又可空的属性（Q3）。
9. 元组：允许的地方使用元组；否则使用成员联合或 `Any` 的列表。
10. 递归：在 `recursion_by_value` 为 false 的地方加入间接引用。
11. 属性加 `additionalProperties`：一个额外的映射字段，序列化时展平。
12. 标量：根据 `format` 决定宽度；该语言没有对应类型的格式回退到基础类型。

在实现中，`tsurara-lower` 包含 `tir`（`tir.rs`）、`Capabilities`（带有预设 `ALL` 和 `MINIMAL`）、`lower` 和 `validate`。方向根据操作为每个声明计算（webhook 和回调方向相反；没有任何操作到达的声明视为两个方向），每个引用都带有其 `Site`，这样后端可以在发送值的位置输出封闭形式，在接收值的位置输出开放形式。pass 12 保留标量及其 `format`；每个后端把格式映射到自己的类型。TypeScript 保留自己的降级（`tsurara-lang-typescript/src/lower.rs`），因为它的 IR 是所有能力都开启时 `tir` 的结构化子集。

语言特有的 pass 在共享的 pass 之后运行，例如 TypeScript 的索引签名扩宽和判别字段交叉。每种语言都以 6.4.1 的形式在 `docs/languages/<language>.md` 中记录其近似。

### 18.6 命名 {#186-naming}

#### 18.6.1 上下文与作用域 {#1861-contexts-and-scopes}

每个标识符都属于一个上下文，每个上下文都有一个名称必须唯一的作用域：

| 上下文 | 作用域 | 示例 |
|---|---|---|
| 类型 | 命名空间（对大多数语言来说是整个输出） | `Pet`、`PetWritable`、`PetOwner` |
| 函数 | 命名空间 | `getPetById`、`get_pet_by_id` |
| 成员 | 一个声明 | 字段、枚举成员、联合变体 |
| 参数 | 一个函数 | 路径和查询参数的名称（在语言使用它们的情况下） |
| 常量 | 命名空间 | OperationDef、TypeDef、服务器列表 |
| 文件 | 目录；在语言或文件系统要求时不区分大小写 | `pet.go`、`Pet.java`、`pet_owner.py` |

转为 snake_case 之类的转换会让同一作用域内的名称发生冲突（`fooBar` 和 `foo_bar` 都会变成 `foo_bar`），因此成员按声明以与类型相同的规则分配。

#### 18.6.2 NamingPolicy {#1862-namingpolicy}

```rust
pub trait NamingPolicy {
    /// Converts a preferred name for a context (casing, initialisms, invalid characters).
    fn convert(&self, context: Context, raw: &str, preserve: bool) -> String;
    /// Words reserved in a context: keywords, globals, and members the language or library defines
    /// (`copy` on Kotlin data classes, `get`/`set`/`free` on GDScript objects).
    fn is_reserved(&self, context: Context, ident: &str) -> bool;
    /// Suffix for reserved names (`Model` for TypeScript types, `_` for Python members).
    fn reserved_suffix(&self, context: Context) -> &str;
    fn file_name(&self, decl_name: &str) -> String;
    fn fold_case(&self, context: Context) -> bool;
}
```

在实现中，模型按分析需要名称的顺序记录名称请求（`tsurara_sem::naming::NameRequest`），每个后端用 `tsurara_naming::Names` 及其策略重放它们；`Type::Named` 引用一个请求。`tsurara-naming` 中的分配算法是共享的：占用顺序遵循模型顺序（18.4.6）；保留名称加上后缀；剩余的冲突加上编号；已被占用的派生名称（`{P}Data`、`{P}Result` 等）让开为 `{P}Operation…`，而不改变函数名（6.6）。除 TypeScript 外，所有语言都在声明和操作之后占用提升的名称；TypeScript 保持当前的顺序。

#### 18.6.3 传输名称与覆盖 {#1863-wire-names-and-overrides}

成员保留其传输名称（18.4.1）。当成员名称不同时，打印器输出该语言的重命名（`#[serde(rename)]`、`[JsonPropertyName]`、struct 标签、`CodingKeys`），或由 TypeDef 记录它（18.7）。TypeScript 保持属性名不变，必要时加引号。

- `naming.overrides`（通用）把 JSON Pointer 映射到首选名称。在各语言的策略转换名称之前，它适用于所有语言。
- `<language>.naming.overrides` 把 JSON Pointer 映射到仅用于该语言的最终标识符。

指针可以指向 schema、属性、操作和提升候选。

### 18.7 值转换 {#187-value-conversion}

生成的代码包含声明、注解和注册，从不包含转换算法。每种语言使用以下三种策略之一：

| 策略 | 语言 | JSON 如何变成带类型的值 |
|---|---|---|
| 无 | TypeScript | 解析后的 JSON 就是值 |
| 注解 | Rust、C#、Go、Kotlin、Java、Swift、Python（pydantic 变体） | 由打印器输出的注解驱动该语言的序列化库。库无法表达的结构（不带标签的联合、开放枚举）使用运行时中的通用辅助函数，生成的代码注册它们但不实现它们 |
| TypeDef | Python（默认变体）、PHP、Ruby、GDScript | 生成器为每个声明输出一个 TypeDef，由运行时以通用方式转换值：重命名、嵌套记录、带兜底的枚举、联合、数字强制转换（GDScript 把所有 JSON 数字解析为浮点数）、日期 |

TypeDef 之于值，就像 OperationDef 之于请求。其格式由 `spec/type-def.schema.json` 定义，所有 TypeDef 运行时共享。它涵盖 TypeDef 语言可能从降级收到的每种 `tir` 结构：记录（字段带有传输名称、成员名称、类型、存在性、基类）、枚举（带有取决于方向的兜底）、带标签和不带标签的联合、元组、带格式的标量、列表、映射、外部类型（通过用户按名称向运行时注册的转换器解析），以及对其他 TypeDef 的引用。

TypeDef 运行时在两个方向上进行转换：

- 解码（JSON 到值）：重命名、嵌套记录、枚举和判别字段的兜底、联合的选择、数字强制转换、日期。
- 编码（值到 JSON）：反向的重命名和转换。缺失的可选字段被省略；只有显式为 null 的值才写出 `null`（pass 8 的存在性规则）。保存在兜底中的未列出枚举值按接收时的原样写回。

操作通过 OperationDef 选择其根 TypeDef：对于 TypeDef 语言，后端为每种请求体媒体类型、每个响应状态码和媒体类型，以及每个非标量参数添加一个类型引用。这些引用是 OperationDef 格式中的可选字段，因此不需要它们的运行时（TypeScript）会忽略它们。

#### 18.7.1 示例值 {#1871-sample-values}

所有语言的 Mock 都打印相同的值，由 `tsurara-sample` 根据模型一次性计算：每个声明一个 JSON 值，每个操作的每个参数、请求体（第一个有值的媒体类型）和响应体（按状态码和媒体类型；流没有）各一个。后端把它们打印为字面量。这些值是确定性的：它们来自定义和 JSON Pointer，从不来自时钟或随机源。

对于一个 schema，按以下顺序：

1. 当值具有 schema 的 JSON 类型（并且是其枚举或字面量值之一）时，使用其 `example`（或 `examples` 中的第一个），然后是其 `default`。不检查示例是否满足约束。
2. `const` 和第一个 `enum` 值；判别标签的第一个值。
3. 根据类型：`true`；整数为 `1`，数字为 `1.5`，并移到 `minimum`/`maximum` 范围内（包含或不包含，也包括 3.0 的布尔值），再向上调整到 `multipleOf` 的倍数；字符串按 `format` 决定（`date-time` 为 `2024-01-01T00:00:00Z`，`date`、`time`、`duration`，由 JSON Pointer 推导出的 `uuid`，`email`、`uri`、`uri-reference`、`hostname`、`ipv4`、`ipv6`、`byte`、`binary`），否则为属性或参数的名称（没有时为 `string`），用 `x` 填充到 `minLength` 并在 `maxLength` 处截断；数组为一个条目，或 `minItems` 份副本；元组为其必需条目以及直到 `minItems` 的剩余条目；对象包含每个有值的属性，包括可选属性；映射为空；任意类型的值为 `{}`。
4. 联合取第一个不是 `null` 且有值的成员（只有 `null` 时为 `null`）。与类型一样，不保持 `oneOf` 的互斥性。带判别字段的联合取第一个有标签值的成员并设置标签，除非该成员自身的属性不允许。
5. `allOf` 合并成员的对象，去掉被其他成员的 `additionalProperties` 拒绝的属性；不同的数组在 `[]` 处相交；对象与其他 JSON 类型的组合没有示例。不求解相互矛盾的组合。
6. 每个值中，一个声明最多进入两次。会再次进入它的可选属性或数组条目会被省略；必需的则变为 `{}` 并给出 `sample-cycle` 警告（这样的 schema 没有有限的值）。
7. 带 `pattern` 而没有示例的字符串一般无法生成：使用上面的占位值并给出 `sample-pattern` 警告。

方向遵循类型：请求体使用 `Writable` 声明（没有 readOnly 属性），响应使用原始声明（没有 writeOnly 属性，即使是必需的也一样，因为 OpenAPI 只在请求中要求它们）。

### 18.8 输出 {#188-output}

- 布局由后端决定：每个声明或每个模块一个文件、目录结构、索引文件（`index.ts`、`__init__.py`、`mod.rs`），以及文件之间如何相互引用。
- 需要命名空间的语言（Go 模块路径、Java/Kotlin 包、C# 命名空间、PHP 命名空间、Swift 模块、GDScript 的 `class_name` 前缀）在其语言部分中有一个必填选项。
- 默认不生成项目清单（`Cargo.toml`、`.csproj`、`go.mod`、`composer.json`、`pyproject.toml`、`Package.swift`）（Q5）。
- 内置运行时（7.5）是后端选择的输出中的一个目录，通过该语言已有的引用方式（相对导入、`runtimeCrate`、`runtimeModule`）访问。
- 标记：后端提供用其注释语法标记生成文件的行、记录所需运行时版本的文件和行，以及 CLI 会与过时生成文件一起删除的附属文件扩展名（Godot 为 `.uid`）。
- 打印器使用 `tsurara-pretty`，写出最终的、确定性的输出。由于 `tsurara check` 比较的是字节，后端不调用外部格式化工具。

### 18.9 运行时契约 {#189-runtime-contract}

每个运行时都实现同一份契约，这样无论哪种语言，生成的代码都能保持精简：

- OperationDef：请求和响应元数据的格式，由 `spec/operation-def.schema.json` 定义。后端把它输出为其语言的字面量；转换为 JSON 后，可以通过该 schema 的校验。
- TypeDef：见 18.7，用于采用 TypeDef 策略的运行时。
- Result 种类：`success`、`http`、`network`、`timeout`、`aborted`、`parse`、`unexpected`，以及保留的 `validation`，含义见 8.2。每种语言以符合其习惯的方式表示它们：TypeScript 中为带判别字段的联合类型，Rust 和 Swift 中为 enum，Kotlin、Java 和 C# 中为 sealed 层次结构，Go 中为带类型化错误的 `(T, error)`，GDScript（没有异常）中为结果对象。Python、PHP 和 Ruby 返回结果对象，并提供会抛出异常的 `unwrap`。契约不假定使用 promise；每个运行时自行选择同步、异步或两者兼有。
- 序列化与解析：参数 style、`explode`、`allowReserved`、`deepObject`、`content` 参数、按媒体类型（包括 multipart 的 `encoding`）构建的请求体，以及请求/响应体种类表（8.5）。
- 运行时能力：运行时声明它支持的请求/响应体种类、参数 style 和媒体类型。对于运行时无法执行的操作，后端会给出警告并省略其调用函数，而不是生成在运行时失败的代码。
- 版本：`OPERATION_DEF_VERSION` 和 TypeDef 版本是共享的。生成的代码所需的运行时版本范围按运行时划分，并通过后端的标记记录。

每个运行时都有两层。类型层是生成的声明在声明、编码和解码时所需的内容：可选和可空标记、联合类型辅助函数、文件值，以及在语言使用 TypeDef 时的 TypeDef 编解码器。它不依赖 HTTP 客户端，也不依赖异步运行时。客户端层是其余的一切：客户端、运行时的 OperationDef、Result、重试、序列。用 `operations: false`（18.10）生成的输出只使用类型层。按语言划分：

| 语言 | 类型层 | 客户端层 |
|---|---|---|
| TypeScript | 空：声明不导入任何东西（channel 解码器使用 `decodeMessage`，它不发送任何东西） | `@tsurara/client` |
| Python | `TypeDefs`、`File`、`MISSING`、`OperationDef`、`SecurityScheme`：只用标准库即可 `import tsurara_client` | 其余部分，在首次使用时导入；httpx 随 `http` extra（`tsurara-client[http]`）安装 |
| Rust | `Nullable`、`File`、`tagged_union!`、`serde`/`serde_json`（`default-features = false`） | `client` 特性（tokio），默认传输层使用 `reqwest` |
| Go | 唯一的包 `tsurara` 中的 `types.go` 和 `value.go`；没有操作的生成类型不导入 `net/http` | 包的其余部分。拆成子包只会移动名称：该模块没有依赖，类型用不到的部分会被链接器去掉 |

之后的运行时（Swift、Kotlin、C#、GDScript 等）从一开始就保持同样的划分，并且可以内置（7.5）：它们的源码既要能作为包使用，也要能作为用户项目中的一个目录使用。TypeDef 的解码和编码向量就是类型层的一致性测试：Python 在没有 httpx 的情况下运行它们。

每个运行时还有一个用于测试的 Mock 传输层：`@tsurara/client/testing`、`tsurara_client.testing`、Rust 的 `testing` 特性和 Go 的 `tsuraratest` 包。它在传输层的接缝处，由按方法和路径模板路由的处理器作答，遵循 `spec/README.md`（Mock transports）和 `spec/conformance/mock-routing.json` 中的路由规则和向量，因此生成的 Mock 和手写的测试在每种语言中都以相同的方式工作。

`spec/conformance/` 中的一致性测试向量是数据。请求向量给出一个 OperationDef 和一个输入，期望得到方法、URL、请求头和请求体。响应向量给出一个 OperationDef、状态码、响应头和响应体，期望得到 Result 种类和数据。解码向量给出一个 TypeDef 和 JSON，期望得到中立形式的解码值；编码向量给出一个 TypeDef 和中立的值，期望得到 JSON，其中包括省略与 null 的情况。非 JSON 的值使用带标签的形式。在后端输出调用函数之前，运行时必须通过其所声明功能的所有向量。

运行时位于 `runtimes/<language>/`。`@tsurara/client` 移到 `runtimes/typescript/`。

### 18.10 配置 {#1810-configuration}

一个目标生成一种语言。从一份定义生成两种语言，就是两个具有相同 `input` 的目标。

```yaml
targets:
  - name: web
    input: ./openapi.yaml
    output: ./web/src/generated
    language: typescript
    splitVisibility: true
    filter: { tags: [pets] }
    naming:
      overrides: { "#/components/schemas/Error": ApiError }
    typescript:
      importExtension: .js
      enumStyle: union
      typeMappings:
        uuid: { type: Uuid, import: { from: ./uuid, name: Uuid } }
  - name: server
    input: ./openapi.yaml
    output: ./server/api
    language: go
    go:
      package: github.com/example/server/api
      strictEnums: false
      typeMappings:
        uuid: { type: github.com/google/uuid.UUID }
```

- 通用键：`name`、`input`、`output`、`language`、`filter`、`splitVisibility`、`naming`、`hooks`。
- 所有依赖于语言的内容，包括 `typeMappings`、`overrides` 以及按最终标识符指定的 `naming.overrides`，都写在以该语言命名的部分中。写入所选语言以外的语言部分是错误。
- 配置的 JSON Schema 由通用部分和每个内置后端的选项组合而成。
- 删除当前顶层的 TypeScript 键（`importExtension`、`enumStyle`、`aggregateMaps`、`clientModule`、扁平的 `typeMappings` 和 `overrides`）。

### 18.11 插件与外部后端 {#1811-plugins-and-external-backends}

- 插件的 model 阶段接收 `sem::Model`。除了 Rust 的 `Plugin` trait，`transformModel` 钩子也像 `transformDocument` 一样，通过 stdin 以 JSON 传入模型，并从 stdout 读取转换后的模型。
- 外部后端是用 `language: { command: [tsurara-backend-elm] }` 选择的程序。CLI 会运行它两次：
  1. `describe`：程序把 `{ protocol, semVersions, markers }` 写到 stdout。`semVersions` 列出它接受的模型版本，`markers` 的内容与 `Backend::markers` 相同（生成文件标记、运行时版本标记、附属文件扩展名）。当前模型版本不在列表中时，CLI 会报错停止。
  2. `generate`：程序通过 stdin 接收 `{ protocol, semVersion, model, common, options }`，并把 `{ files, warnings }` 写到 stdout。

  CLI 像对待内置后端的结果一样对待它：过时文件的删除、附属文件和 `tsurara check` 都使用 `describe` 给出的标记。协议 1 只把语义模型交给程序；共享的命名和降级按下文提供（Q6）。

  协议 2 在 `generate` 的回答中加入可选的 `manifest`（11.1）；CLI 支持协议 1 和 2，并按程序在 `describe` 中给出的协议发送 `generate`。

  共享的降级和命名，在任一协议中都只提供给提出请求的程序：

  - `describe` 可以加入 `lowering: { capabilities }`（`tsurara_lower::Capabilities` 的标志，camelCase）和 `naming`，即以数据形式表示的命名策略（`tsurara_naming::data::DataPolicy`）：每个上下文（`type`、`function`、`member`、`parameter`、`constant`、`file`；缺失的使用 `type` 的设置）的 `case`（`pascal`、`camel`、`snake`、`screamingSnake`、`kebab`、`preserve`）、`digitPrefix`、`upperPrefix`（Go 的 `X`）、`fallback`、`ascii`（文件名）、`reserved` 和 `reservedSuffix`，以及在 Pascal 和 camel 写法中大写的 `initialisms`。`naming` 需要 `lowering`。
  - 这样 `generate` 还会收到 `lowered`，即按这些能力降级为 `tir` 的模型（其 JSON 形式是 `spec/plugin-protocol.schema.json` 的一部分，受 `semVersion` 约束），以及 `names`（`tsurara_lower::AllocatedNames`）：`lowered` 中每个声明的类型名、文件名和成员名（记录字段或枚举值），以及每个操作的函数名，由 `Names` 按策略分配。降级警告会加入程序的警告中。
  - 这套词汇可以表达 Go 的策略（有测试在边界情况语料库上比较数据形式与 `GoPolicy`）；内置后端保留它们的 Rust 策略，这些策略还会分配派生名称（`{P}Options`），并且拥有比 `names` 更多的作用域。超出这套词汇的规则需要使用 crate。
  - 用 Rust 编写的后端改为使用 crate：`tsurara-loader`、`tsurara-sem`、`tsurara-naming`、`tsurara-pretty`、`tsurara-lower`、`tsurara-sample` 和 `tsurara-backend` 以同一个版本发布，与 CLI 一起发布；每个 crate 的文档会指明其稳定 API。`examples/backend-rust` 针对打包后的这些 crate 构建，`examples/backend-typescript` 使用协议。

  实现：目标写作 `language: { command: [program, ...args], options: {...} }`；命令在配置文件的目录中运行，并追加 `describe` 或 `generate`。`describe` 打印 `{ "protocol": 1, "semVersions": [1], "markers": { "generated": "# Generated by ...", "version": { "file", "prefix" }, "sidecars": [".uid"] } }`（`version` 和 `sidecars` 是可选的）。`generate` 读取 `{ "protocol", "semVersion", "model", "common", "options" }`（模型和通用选项采用其 JSON 形式，18.4.6），并打印 `{ "files": [{ "path", "contents" }], "warnings": [...] }`，其中警告使用模型的警告形式，语言为 `external`。相关类型位于 `tsurara_backend::external`。

### 18.12 测试 {#1812-testing}

- 语义测试：6.4 中的映射表只针对语义模型的 JSON 形式检查一次。
- 用例文件：`expect` 是从语言到打印输出的映射；一个用例可以覆盖多种语言。
- 降级测试：每个 pass 都用小型能力集在 `tir` 上测试，校验器会在每个测试输出上运行。
- 检查器：`tsurara-testkit` 为每种语言提供一个检查器（`tsc`、`cargo check`、`dotnet build`、`go vet`、`kotlinc`、`javac`、`swiftc`、`mypy`/`pyright`、PHPStan、`steep`、`godot --headless --check-only`）。缺少工具链的检查器会跳过其测试，除非 `TSURARA_REQUIRE_CHECKERS` 列出了它。CI 为每种语言运行一个任务。
- 语料库：13.1 中的定义会为每种语言生成并检查。
- 运行时：每个运行时都运行所有一致性测试向量。
- 本仓库之外的后端：`tsurara test-backend --backend <command> --check <command>` 会在嵌入二进制文件的边界情况语料库以及定义目录（`--definitions`，用于真实定义语料库）上运行后端，并在每个输出目录中运行检查器命令；失败的定义会给出名称，其目录会被保留。`tsurara spec <dir>` 写出该版本的运行时契约（`spec/`：schema、`README.md`、一致性测试向量），这样外部的运行时就从用于测试的二进制文件中获取向量，而不是从代码检出中获取。基于属性的测试留在本仓库中：其定义生成器是基于 proptest 构建的测试代码。CI 对 `examples/backend-typescript` 运行该命令。

### 18.13 添加一种语言 {#1813-adding-a-language}

1. 在调研表（18.2）中添加一行。
2. 编写 `docs/languages/<language>.md`：能力、近似表、转换策略、布局、选项。
3. 实现 `NamingPolicy`：大小写、首字母缩略词、每个上下文的保留字、后缀、文件名。
4. 用 `tsurara-pretty` 实现打印器、布局和标记。
5. 在 `tsurara-testkit` 中加入检查器，并添加 CI 任务；运行语料库。
6. 在实验性标志之后发布仅类型的版本。
7. 在 `runtimes/<language>/` 中实现运行时，并通过一致性测试向量。
8. 输出调用函数。

其他仓库中的后端通过协议（18.11）遵循同样的步骤：在 `describe` 中以数据形式给出能力和命名策略（在 Rust 中则使用 crate），用带有自己检查器的 `tsurara test-backend` 代替语料库测试，并用 `tsurara spec` 获取向量。`docs/guide/backends.md` 是相应的指南，其中有仓库结构和已知后端的列表；`examples/backend-typescript` 是模板。

### 18.14 路线图 {#1814-roadmap}

| 语言 | 后端 | 运行时 | 说明 |
|---|---|---|---|
| TypeScript | 已存在；移到 `tsurara-lang-typescript` | `@tsurara/client` | 第一 |
| Python | 类型和调用函数；`docs/languages/python.md` | `runtimes/python` 中的 `tsurara-client`：httpx、同步和异步客户端、TypeDef 编解码器 | 第二 |
| Rust | 类型和调用函数，实验性；`docs/languages/rust.md` | `runtimes/rust` 中的 `tsurara-client`：`Transport` trait 之后的 reqwest、`tagged_union!` | 第三 |
| Go | 类型（实验性）和调用函数；`docs/languages/go.md` | `runtimes/go` 中的 `tsurara` 包：仅标准库，带 `*Failure[E]` 的 `(T, error)` | 与 Rust 同时；第一个没有联合类型的语言 |
| C#、Kotlin、Java、Swift、PHP、Ruby、GDScript | 之后按 18.13 立项 | 之后 | |

TypeScript 排在第一：它在共享的 crate 之上重建，并继续作为参考输出。Python 排在第二。它检验 TypeScript 不会用到的部分：提升为具名类型（dataclass）、带作用域的成员名（带传输名称的 snake_case）、按方向开放的枚举、双向的 TypeDef 策略，以及作为字段名的关键字。

Python 有结构化联合和多继承，因此不会检验为没有联合或继承的语言（Go、Java、C#、GDScript）准备的回退方案。在加入这样的语言之前，这些 pass 由使用小型能力集的降级测试覆盖。

### 18.15 迁移计划 {#1815-migration-plan}

重构步骤保持 TypeScript 输出逐字节相同（所有现有快照都不变）。有意改变输出的步骤会明确说明。041 依赖 029，因为目前 JSON 内部的 `contentMediaType` 字符串会变成 `Blob | File`（`table.yaml` 也这样期望）；029 有意改变这些快照并单独评审，这样 041 就能让其余部分保持不变。

| Issue | 变更 | 依赖 |
|---|---|---|
| 036 | 决定未决问题；把本文档合并到 design.md | — |
| 037 | 拆分为多个 crate；`Backend` trait 和注册表；TypeScript 移到 `tsurara-lang-typescript` | 036 |
| 038 | 模型中的整数、数字和格式 | 037 |
| 039 | 显式的枚举节点 | 037 |
| 040 | 结构化的判别字段；保留 `allOf` 的结构 | 037 |
| 041 | `Binary`、`BodyKind`、按语言划分的外部类型 | 037、016、029 |
| 042 | `tsurara-naming`：上下文、作用域、`NamingPolicy`、传输名称；模型不包含标识符 | 038–041、032 |
| 043 | 语义警告和后端警告 | 042、015 |
| 044 | 配置：`language`、语言部分、删除顶层键 | 042、016 |
| 045 | 可序列化、带版本的语义模型 | 042 |
| 047 | 运行时契约：OperationDef schema、Result 种类、运行时能力、一致性测试向量；移动 `@tsurara/client` | 036 |
| 048 | 带首选名称的提升候选 | 042 |
| 049 | CLI 中的后端标记和附属文件 | 037 |
| 050 | 语义用例测试、按语言的期望值、检查器框架 | 045 |
| 051 | `tsurara-lower`：`tir`、能力、共享 pass、校验器 | 048 |
| 052 | TypeDef 格式、与操作的绑定、解码和编码向量 | 047、051 |
| 053 | `tsurara-pretty`；移植 TypeScript 打印器 | 037 |
| 054 | 带 `describe` 的外部后端协议 | 045、044、049 |
| 055 | Python 后端，仅类型 | 043、044、049、050、051、052、053 |
| 056 | `transformModel` 钩子 | 045、017 |

### 18.16 已决事项 {#1816-decisions}

于 2026-11-10 决定（采纳了早期草稿中的提议）。

| # | 问题 | 决定 |
|---|---|---|
| Q1 | Python 的默认变体 | 带 TypeDef 的 dataclass；TypedDict 和 pydantic 之后作为变体提供 |
| Q2 | Python 生成代码的最低版本 | 3.11，即 3.10 于 2026 年 10 月结束支持后仍受支持的最旧版本。在提高最低版本之前不使用 `type` 语句（3.12） |
| Q3 | 何时区分缺失的属性和 `null` | 只对既可选又可空的属性区分；其他一切都使用该语言唯一的可选形式 |
| Q4 | 模型和运行时契约中的安全方案 | 保存在模型和 OperationDef 中；运行时向 `auth` 钩子请求凭据（8.1） |
| Q5 | 生成项目清单 | 默认关闭；如果用户有需求，之后提供按语言的选项 |
| Q6 | 供外部后端使用的共享命名和降级 | 已决定：发布的 crate，以及 `describe` 中的 `lowering`/`naming` 和 `generate` 中的 `lowered`/`names`（18.11） |
| Q7 | TypeScript 输出能否为遵循共享规则（格式化打印、带作用域的命名）而改变？ | 可以，但只能作为单独的步骤进行，并评审其快照差异 |

于 2026-11-09 决定：TypeScript 在两个方向上都保持封闭的枚举和判别字段；对于遇到未列出的值就会解码失败的语言，开放枚举是默认（18.5.3）。
