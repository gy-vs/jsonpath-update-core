# JSONPath engine

TypeScript library for JSON query and update.

Run `npm install`, then `npm test` and `npm run build`.

## Query

```ts
import { parse, query } from './src/index.js';

query({ a: 1 }, parse('$.a')); // [1]
```

Supported path syntax: `$.field`, `$.*`, `$[0]`, `$['a b']`, `$[*]`,
combined freely (e.g. `$.items[*].name`).

## update(input, operations)

Apply `replace`, `delete` or `transform` actions to every node matched by one
or more JSONPaths, **atomically**: either a new structurally-shared value is
returned, or the original input is returned untouched with diagnostics.

The input is never mutated. Array deletions are planned by original index, so
multiple deletions in one batch do not shift while traversing.

```ts
import { update } from './src/index.js';

const input = { items: [1, 2, 3] };

const r = update(input, [
  { path: '$.items[0]', action: { type: 'replace', value: 9 } },
  { path: '$.items[2]', action: { type: 'delete' } },
  { path: '$.items[1]', action: { type: 'transform', fn: (v, ctx) => v * 10 } },
]);
// r.ok === true, r.value === { items: [9, 20] }, input unchanged
// r.hits is sorted in deterministic document order and carries path/segments/value
```

### Result

- Success: `{ ok: true, value, hits }` — untouched subtrees are shared by
  reference.
- Failure: `{ ok: false, value: input, hits, error }` — `value` is the
  original input reference. Error kinds:
  - `parse` / `invalid-op` — bad path or action (includes operation index)
  - `cycle` — cyclic input, replacement value, or transform output
  - `conflict: 'duplicate-reference'` — the same node matched twice
  - `conflict: 'ancestor-descendant'` — a hit is inside another hit
  - `transform-failed` — a transform function threw (cause is attached); all
    hits remain listed, no other action is applied

The root node (`$`) may itself be replaced, transformed, or deleted
(deleting the root yields `undefined`).
