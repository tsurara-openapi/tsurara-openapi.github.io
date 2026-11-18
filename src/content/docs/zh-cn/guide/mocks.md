---
title: "Mock"
sourcePath: docs/guide/mocks.md
sourceHash: 83f0e4ae9519
---

`typescript.mocks` 会生成示例数据和请求处理器，让 UI 开发、Storybook 和测试无需服务器即可运行。这些值来自定义（其中的示例、默认值、枚举、格式和约束），每次运行都相同。

```yaml
typescript:
  mocks: msw     # MSW 请求处理器；用于 @tsurara/client/testing 的 mockFetch 时设为 `fetch`
```

所有内容都位于 `mocks/` 下，其他文件不会导入它，因此生产代码永远不会加载 `msw`。

## 工厂函数 {#factories}

`mocks/schemas/{Name}.ts` 中为每个 schema 提供 `mock{Name}()`。对象可以接受覆盖值：

```ts
import { mockPet } from './generated/mocks/schemas/Pet.ts';

const pet = mockPet({ name: 'Tama' }); // 使用示例值的 Pet，`name` 被替换
```

在其他 schema 内部使用的 schema 由它自己的工厂函数构建（`owner: mockOwner()`），因此每个值只定义一次。示例无法严格符合的类型（映射与成员不一致的判别字段、`allOf`、外部类型）会被断言为其类型。

## 处理器 {#handlers}

`mocks/operations/{function}.ts` 中为每个操作提供一个处理器。不带参数时，它用定义中第一个成功响应和示例值作答；参数可以是定义中声明的某个响应，或是一个接收请求并返回响应的函数：

```ts
import { setupServer } from 'msw/node';
import { handlers } from './generated/mocks/index.ts';
import { getPetByIdHandler } from './generated/mocks/operations/getPetById.ts';

const server = setupServer(...handlers);
server.use(getPetByIdHandler({ status: 404, body: { message: 'gone' } }));
server.use(getPetByIdHandler(({ params }) => ({ status: 200, body: mockPet({ id: Number(params.petId) }) })));
```

`{Op}MockResponse` 列出了定义中声明的状态码及其响应体类型，因此未声明的状态码或类型错误的响应体会成为类型错误。路径会转换为 MSW 路径（`*/pets/:petId`；`options.baseUrl` 会替换 `*`）；位于路径段中间的参数（`/files/{name}.{ext}`）用不带具名参数的正则表达式匹配。响应体按其媒体类型写入：JSON、文本，或字节（用于二进制和流式响应）。

## 不使用 MSW {#without-msw}

使用 `mocks: fetch` 时，同样的函数返回 `@tsurara/client/testing` 中 `mockFetch` 的路由，并由 `mocks/index.ts` 导出 `routes`：

```ts
import { createClient } from '@tsurara/client';
import { mockFetch } from '@tsurara/client/testing';
import { routes } from './generated/mocks/index.ts';

const mock = mockFetch(routes, { basePath: '/v1' });
const api = createClient({ baseUrl: 'https://api.test/v1', fetch: mock.fetch });
```

其他运行时也有相同的 Mock 传输层（`tsurara_client.testing`、Rust 的 `testing` 特性、Go 的 `tsuraratest` 包），`python.mocks`、`rust.mocks` 和 `go.mocks: true` 会生成它们各自的工厂函数和路由（[Python](../../languages/python/#mocks)、[Rust](../../languages/rust/#mocks)、[Go](../../languages/go/#mocks)）。
