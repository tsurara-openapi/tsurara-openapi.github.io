---
title: "React and TanStack Query"
sourcePath: docs/guide/react.md
sourceHash: 09418daf7502
---

A walk through [`examples/react-tanstack`](https://github.com/tsurara-openapi/tsurara/tree/7c43bb18c3cbc4d44d58c4d5517b666325d04f97/examples/react-tanstack), a small Next.js app (App Router) over a card API: a search list read page by page, a detail page, an edit form, two tenants, tests with MSW, and server rendering. Everything that talks to the API is generated code and `@tsurara/client`; the app writes no query keys, no `queryFn`s and no type assertions.

## Start

```sh
tsurara init --preset react-query   # writes tsurara.config.yaml and prints the packages to install
npm install @tsurara/client @tanstack/react-query zod
npm install --save-dev msw
tsurara generate
```

The preset turns on query options (`query: tanstack`), Zod response schemas (`validators: zod`) and MSW handlers (`mocks: msw`), with extensionless imports, which Vite and Next.js resolve (Turbopack does not map `.js` imports to `.ts` files). The [configuration](../configuration/) lists every key.

## The client and the QueryClient

`src/api.ts` makes a client per session: the session's token in `auth`, and its tenant as the `queryScope`, which goes first in every query key of that client ([scopes](../client/#scopes-tenants-several-apis-logout)). The `QueryClient` retries with `queryRetry()` and reports statuses the definition does not document ([errors and retries](../client/#errors-and-retries)):

```ts
export const createApi = (session: Session): Client =>
  createClient({ baseUrl, queryScope: { tenant: session.tenant }, auth: () => session.token });

export const makeQueryClient = (report = …): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: queryRetry(), staleTime: 30_000 } },
    queryCache: new QueryCache({ onError: (e) => { if (e instanceof ApiError && e.result.kind === 'http' && !e.result.documented) report(e); } }),
  });
```

`src/query-client.ts` follows TanStack's advice for server rendering: a new `QueryClient` per request on the server, so that requests and tenants never share a cache, and one for the page's life in the browser.

## The list: search and infinite scrolling

The definition writes the pagination on the operation, `x-tsurara-pagination: { param: query.cursor, next: /nextCursor }`, so `listCards` gets infinite query options ([infinite queries](../client/#infinite-queries)). The list (`src/components/CardList.tsx`) is one call, and hovering a card prefetches its detail:

```tsx
const cards = useInfiniteQuery(listCardsInfiniteQueryOptions(api, search === '' ? {} : { query: { q: search } }));
// …
onMouseEnter={() => void queryClient.prefetchQuery(getCardQueryOptions(api, { path: { cardId: card.id } }))}
```

Errors are branched on with the Result's information: `isHttpError(cards.error.result, 401)` for a signed-out session, `cards.error?.kind === 'network'` for a retry button.

## Editing: optimistic updates, 422 and the cache

`src/cards.ts` spreads the generated mutation options and adds the app's cache policy: the change shows at once, a refused change is rolled back, and a success replaces the card's entry and refetches every list of the tenant:

```ts
export const updateCardOptions = (api: Client, queryClient: QueryClient, scope: QueryScope) => ({
  ...updateCardMutationOptions(api),
  onMutate: async (input: UpdateCardData) => {
    const key = getCardQueryKey({ path: input.path }, scope);
    await queryClient.cancelQueries({ queryKey: key });
    const previous = queryClient.getQueryData(key); // Card | undefined
    if (previous) queryClient.setQueryData(key, { ...previous, ...input.body });
    return { previous };
  },
  onError: (_e, input, context) => { if (context?.previous) queryClient.setQueryData(…, context.previous); },
  onSuccess: async (card: Card) => {
    queryClient.setQueryData(getCardQueryKey({ path: { cardId: card.id } }, scope), card);
    await queryClient.invalidateQueries(listCardsQueryFilter(scope));
  },
});

// The documented 422 body, typed:
export const fieldErrors = (error: ApiError<UpdateCardResult> | null) =>
  error && isHttpError(error.result, 422) ? error.result.error.fields : undefined;
```

## Tenants

`src/session.tsx` switches tenants by dropping what the previous one cached, `queryClient.removeQueries(queryScopeFilter(scope))`, then making a client for the next session. Entries of other tenants stay.

## Server rendering

The pages (`app/page.tsx`, `app/cards/[cardId]/page.tsx`) prefetch on the server with the same options and hand the cache to the browser:

```tsx
export default async function Home() {
  return (
    <HydrationBoundary state={await prefetchCardList(await requestSession())}>
      <CardList />
    </HydrationBoundary>
  );
}
```

Keys hold only JSON values, so they hash the same in the browser after `dehydrate` on the server. The pages are dynamic (`export const dynamic = 'force-dynamic'`), since what they show depends on who is signed in.

## Tests

`test/` runs with Vitest and MSW, using the generated handlers (`listCardsHandler`, `getCardHandler`, `updateCardHandler`) with responses per test:

- `cards.test.ts`: pages in order and the end of the list, the optimistic update seen by the server and kept, the rollback and the typed field errors of a 422, the lists refetched after an edit, tenants kept apart, and the retries (a 503 three times in all, a documented 404 once).
- `components.test.tsx` (happy-dom): the list loads the next page on demand; a refused edit shows the field error and the title rolls back.
- `ssr.test.tsx`: the server makes a `QueryClient` per request, and two concurrent renders for different tenants each contain only their own cards.

MSW 3 names the option for requests without a handler `onUnhandledFrame` (`server.listen({ onUnhandledFrame: 'error' })`). In a browser-like test environment, give the page the API's origin (`environmentOptions.happyDOM.url`) so that requests with an `Authorization` header are not preceded by a CORS preflight that no handler answers.
