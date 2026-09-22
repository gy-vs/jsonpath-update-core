# JSONPath engine

TypeScript library for JSON query and update.

Run `npm install`, then `npm test` and `npm run build`.

## API

- `parse(path)` — parse `$.a.b[0]`, `$['x']`, `$[*]` style paths into tokens.
- `query(value, tokens)` — return matched nodes in document order.
- `update(input, action | action[])` — atomic replace/delete/transform of all matches.

```ts
update(doc, [
  { path: '$.users[*].name', set: 'anon' },
  { path: '$.users[0]', delete: true },
  { path: '$.meta.updatedAt', apply: () => Date.now() },
]);
// -> { ok: true, value, hits } or { ok: false, code, hits, ... }
```

Guarantees: the input is never mutated; array deletes are planned by original
index and applied in one pass; unchanged subtrees are shared structurally;
ancestor/descendant and duplicate-target conflicts, root deletion, cyclic
input/replacements and thrown transforms all abort the batch atomically with a
diagnostic error code.
