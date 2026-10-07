# jsonpath-update-core

A small, dependency-free TypeScript JSONPath library for **querying** and
**immutably updating** JSON-like data. It implements the selector subset of
[RFC 9535](https://www.rfc-editor.org/rfc/rfc9535) (JSONPath), parses and
evaluates expressions itself, and ships no command-line entry point — it is an
importable ESM library.

```ts
import { query, replace, remove, update } from 'jsonpath-update-core';

query(config, '$.servers[*].port');
replace(config, '$.servers[0,2,-1].enabled', false);
remove(config, '$.servers[0,2,-1]');
update(config, '$..retry.count', (n) => (n as number) + 1);
```

## Supported syntax

| Feature | Example |
| --- | --- |
| Root | `$` |
| Dot member | `$.store.book` |
| Bracket member (quoted, escapes supported) | `$['store']["book"]` |
| Wildcard | `$.servers.*`, `$[*]` |
| Index, positive and negative | `$.servers[2]`, `$.servers[-1]` |
| Slice `start:end:step`, every part optional | `$[1:5]`, `$[::-1]`, `$[5:1:-1]`, `$[::2]` |
| Recursive descent | `$..retry`, `$..[0]`, `$..*` |
| Bracket union (commas, any selectors) | `$[0,2,-1]`, `$['a','b']`, `$[0:3,-1]` |

Slice semantics follow RFC 9535 (Python-style normalization), including
negative steps and out-of-range bounds; **a step of `0` selects nothing**
(rather than looping forever). Whitespace is allowed where the RFC grammar
allows it (e.g. `$[ 1 : 5 : 2 ]`).

Filter expressions (`?…`), script expressions (`(…)`) and the current-node
identifier (`@`) are **not** supported. Writing one is a syntax error that
reports the offending position:

```ts
try { parse('$[?@.x]'); }
catch (e) { e.position; } // -> 2
```

## API

### `parse(expression): JsonPath`

Parse an expression into an AST you can reuse across many calls. Every query
or update also accepts a raw string.

### `query(root, expression): PathNode[]`

Return matched nodes in RFC 9535 document order, each with its normalized
path:

```ts
query({ a: [1, 2] }, '$.a[*]');
// [ { value: 1, path: "$['a'][0]" },
//   { value: 2, path: "$['a'][1]" } ]
```

- Order, slice values (negative/overflowing step and bounds) and recursive
  descent traversal follow RFC 9535 and are deterministic; repeated runs
  return identical results.
- A value referenced from two places (a shared subtree) is matched through
  both locations. A genuinely cyclic reference raises `JsonPathCycleError`
  instead of looping.
- All traversal is iterative, so structures nested thousands of levels deep
  do not overflow the call stack.

`values(root, expression)` is a convenience returning only the values.

### `replace(root, expression, value): root`

Replace every matched node with a constant. Returns a new structure; the
input is never mutated and every untouched subtree is reused by reference,
so callers can locate changes with `===`. If nothing matches, the exact
input reference is returned.

### `remove(root, expression): root | undefined`

Delete every matched node. All indices in a single expression resolve against
the **original** array — the shifting caused by deleting earlier elements is
not observed:

```ts
remove({ servers: [0, 1, 2, 3, 4] }, '$.servers[0,2,-1]');
// { servers: [1, 3] }
```

Deleting the root yields `undefined`.

### `update(root, expression, transform): root`

Replace every matched node with `transform(value, normalizedPath)`.

- **Atomic:** if the transform throws on any matched node, no part of the
  input is changed. A `JsonPathTransformError` is thrown carrying `.path`
  (the normalized path that failed) and `.cause` (the original error).
- The set of nodes touched is exactly the set returned by `query` with the
  same expression — no more, no fewer.
- When one matched node contains another (e.g. `$..retry` matching both an
  object and a member inside it), transforms apply **bottom-up**: descendants
  are transformed first, so an outer transform observes the already
  transformed subtree. The outcome is independent of traversal order.
- When a union selects the same node more than once, `query` reports it that
  many times and `update` runs the transform that many times (composed in
  result order). A constant `replace`/`remove` collapses to a single edit,
  since a constant cannot compose with itself.

## Guarantees and limits

- **Immutability / structural sharing.** Inputs are never mutated. Unchanged
  subtrees keep their object identity; a transform that returns an equal
  value leaves that node `===`-identical. Only ancestor paths of changed
  nodes are allocated.
- **Shared vs cyclic references.** Shared subtrees are visited and rewritten
  through each referencing edge; true cycles raise `JsonPathCycleError`.
- **Performance.** Query plus update over roughly 100k nodes (or chains a few
  thousand levels deep) runs in about a second, with O(1) call-stack depth.
  See `test/perf.test.ts`.
- **No evaluator dependency.** The parser and evaluator are self-contained
  (this library does not use `jsonpath`, `jsonpath-plus`, or similar).

## Errors

All errors extend `JsonPathError`:

- `JsonPathSyntaxError` — invalid expression, with `.position` (0-based offset).
- `JsonPathCycleError` — a cyclic reference, with `.path`.
- `JsonPathTransformError` — a transform threw, with `.path` and `.cause`.

## Development

```sh
npm install
npm test       # vitest, including the bundled RFC 9535 compliance suite
npm run build  # tsc -> dist/ (no type errors)
```
