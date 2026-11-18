---
title: "Getting started"
sourcePath: README.md
sourceHash: 8218f166c4ab
---

tsurara generates types and one call function per operation from OpenAPI 3.0, 3.1, 3.2 and Swagger 2.0: TypeScript and Python, with Rust and Go experimental.
Calls return Results instead of throwing, and it can also generate TanStack Query helpers, Zod schemas and mocks, with an MCP server and a JSON CLI for coding agents.
It is a single binary that needs no Node to generate, and its thin output passes TypeScript's strictest options and is checked against real-world definitions in CI.

## Quick start

Requirements: Node 22.18 or later (to run the example below directly).

1. Install the generator and the runtime library:

   ```sh
   npm install --save-dev tsurara
   npm install @tsurara/client
   ```

   The `tsurara` package runs a native binary for macOS, Linux or Windows (x64 and arm64). Each [GitHub release](https://github.com/tsurara-openapi/tsurara/releases) also has the binaries as archives.

2. Create `tsurara.config.yaml` (or run `npx tsurara init`):

   ```yaml
   input: https://petstore3.swagger.io/api/v3/openapi.json
   output: src/generated
   typescript:
     importExtension: ts   # run directly with Node type stripping; use `js` (default) with tsc builds
   ```

3. Generate:

   ```sh
   npx tsurara generate
   ```

4. Call the API:

   ```ts
   // main.ts
   import { createClient, isHttpError, unwrap } from '@tsurara/client';
   import { getInventory, getPetById } from './src/generated/index.ts';

   const api = createClient({ baseUrl: 'https://petstore3.swagger.io/api/v3' });

   const inventory = unwrap(await getInventory(api)); // { [status: string]: number }
   console.log(inventory);

   const result = await getPetById(api, { path: { petId: 1 } });
   if (result.ok) console.log(result.data);
   else if (isHttpError(result, 404)) console.log('no such pet');
   else console.log('failed:', result.kind);
   ```

   ```sh
   node main.ts
   ```
