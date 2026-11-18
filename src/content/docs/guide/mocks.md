---
title: "Mocks"
sourcePath: docs/guide/mocks.md
sourceHash: 83f0e4ae9519
---

`typescript.mocks` generates sample data and request handlers, so that UI development, Storybook and tests run without a server. The values come from the definition (its examples, defaults, enums, formats and constraints) and are the same on every run.

```yaml
typescript:
  mocks: msw     # MSW request handlers; or `fetch` for mockFetch of @tsurara/client/testing
```

Everything is under `mocks/`, which nothing else imports, so production code never loads `msw`.

## Factories

`mocks/schemas/{Name}.ts` has `mock{Name}()` for every schema. Objects take overrides:

```ts
import { mockPet } from './generated/mocks/schemas/Pet.ts';

const pet = mockPet({ name: 'Tama' }); // a Pet with the sample values, `name` replaced
```

A schema used inside another is built by its own factory (`owner: mockOwner()`), so a value is defined once. Types that the samples cannot follow exactly (discriminators whose mappings disagree with the members, `allOf`, external types) are asserted to their type.

## Handlers

`mocks/operations/{function}.ts` has a handler per operation. Without arguments it answers with the first documented success and the samples; the argument is a response the definition documents, or a function of the request that returns one:

```ts
import { setupServer } from 'msw/node';
import { handlers } from './generated/mocks/index.ts';
import { getPetByIdHandler } from './generated/mocks/operations/getPetById.ts';

const server = setupServer(...handlers);
server.use(getPetByIdHandler({ status: 404, body: { message: 'gone' } }));
server.use(getPetByIdHandler(({ params }) => ({ status: 200, body: mockPet({ id: Number(params.petId) }) })));
```

`{Op}MockResponse` lists the documented statuses with their body types, so an undocumented status or a body of the wrong type is a type error. Paths become MSW paths (`*/pets/:petId`; `options.baseUrl` replaces `*`); a parameter inside a segment (`/files/{name}.{ext}`) is matched with a RegExp, without named parameters. Bodies are written as their media type: JSON, text, or bytes for binary and streamed responses.

## Without MSW

With `mocks: fetch`, the same functions return routes for `mockFetch` of `@tsurara/client/testing`, and `mocks/index.ts` exports `routes`:

```ts
import { createClient } from '@tsurara/client';
import { mockFetch } from '@tsurara/client/testing';
import { routes } from './generated/mocks/index.ts';

const mock = mockFetch(routes, { basePath: '/v1' });
const api = createClient({ baseUrl: 'https://api.test/v1', fetch: mock.fetch });
```

The other runtimes have the same mock transport (`tsurara_client.testing`, the Rust `testing` feature, the Go package `tsuraratest`), and `python.mocks`, `rust.mocks` and `go.mocks: true` generate their factories and routes ([Python](../../languages/python/#mocks), [Rust](../../languages/rust/#mocks), [Go](../../languages/go/#mocks)).
