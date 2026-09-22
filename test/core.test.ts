import { expect, it } from 'vitest';
import { hasCycle, parse, query, update } from '../src/index.js';

it('queries fields and indexes in document order', () => {
  expect(query({ a: 1 }, parse('$.a'))).toEqual([1]);
  expect(query({ a: { b: [10, 20] } }, parse('$.a.b[1]'))).toEqual([20]);
  expect(query([{ x: 1 }, { x: 2 }], parse('$[*].x'))).toEqual([1, 2]);
  expect(query({ a: 1 }, parse('$.missing'))).toEqual([]);
});

it('replaces multiple matches on stable snapshot, never mutating input', () => {
  const input = { users: [{ n: 'a' }, { n: 'b' }], keep: { v: 1 } };
  const frozen = structuredClone(input);
  const r = update(input, { path: '$.users[*].n', set: 'x' });
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  expect(r.value).toEqual({ users: [{ n: 'x' }, { n: 'x' }], keep: { v: 1 } });
  expect(input).toEqual(frozen);
  expect(r.hits.map(h => h.path)).toEqual([['users', 0, 'n'], ['users', 1, 'n']]);
  expect((r.value as any).keep).toBe(input.keep);
});

it('deletes several array elements by original index in one pass', () => {
  const input = { xs: [0, 1, 2, 3, 4] };
  const r = update(input, [
    { path: '$.xs[1]', delete: true },
    { path: '$.xs[3]', delete: true },
  ]);
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value).toEqual({ xs: [0, 2, 4] });
    expect(input.xs).toEqual([0, 1, 2, 3, 4]);
  }
});

it('deletes object keys by stable paths', () => {
  const input = { a: 1, b: 2, c: { d: 3, e: 4 } };
  const r = update(input, [
    { path: '$.a', delete: true },
    { path: '$.c.d', delete: true },
  ]);
  expect(r.ok && r.value).toEqual({ b: 2, c: { e: 4 } });
});

it('rejects ancestor and descendant matching in the same batch atomically', () => {
  const input = { a: { b: 1 } };
  const r = update(input, [
    { path: '$.a', set: 9 },
    { path: '$.a.b', set: 8 },
  ]);
  expect(r).toMatchObject({ ok: false, code: 'ancestor-descendant' });
  expect(input).toEqual({ a: { b: 1 } });
});

it('rejects the same node reached by two selectors', () => {
  const input = { items: [{ id: 1 }, { id: 2 }] };
  const r = update(input, [
    { path: '$.items[0].id', set: 9 },
    { path: "$['items'][0]['id']", set: 8 },
  ]);
  expect(r).toMatchObject({ ok: false, code: 'duplicate-target' });
});

it('applies independent transforms when the same node is referenced twice via a diamond', () => {
  const shared = { v: 1 };
  const input = { x: shared, y: shared };
  const r = update(input, {
    path: '$[*].v',
    apply: n => (n as number) + 1,
  });
  expect(r.ok && r.value).toEqual({ x: { v: 2 }, y: { v: 2 } });
  expect(shared).toEqual({ v: 1 });
});

it('replaces the whole root', () => {
  const input = { a: 1 };
  const r = update(input, { path: '$', set: { b: 2 } });
  expect(r.ok && r.value).toEqual({ b: 2 });
  expect(input).toEqual({ a: 1 });
});

it('refuses to delete the root', () => {
  expect(update({ a: 1 }, { path: '$', delete: true })).toMatchObject({ ok: false, code: 'delete-root' });
});

it('returns unmodified input identity and diagnostics when a transform throws', () => {
  const input = { a: { v: 1 }, b: { v: 2 } };
  const r = update(input, {
    path: '$[*].v',
    apply: (n, p) => { if (p[0] === 'b') throw new Error('boom'); return (n as number) * 10; },
  });
  expect(r).toMatchObject({
    ok: false,
    code: 'transform-threw',
    path: ['b', 'v'],
  });
  if (!r.ok && r.code === 'transform-threw') expect((r.error as Error).message).toBe('boom');
  expect(input).toEqual({ a: { v: 1 }, b: { v: 2 } });
});

it('shares untouched subtrees structurally', () => {
  const deep = { z: [1, 2, 3] };
  const input = { a: { n: 1 }, b: deep };
  const r = update(input, { path: '$.a.n', set: 2 });
  expect(r.ok && (r.value as any).b).toBe(deep);
  expect(r.ok && (r.value as any).a).not.toBe(input.a);
});

it('rejects cyclic input and cyclic replacement values atomically', () => {
  const cyc: any = { a: 1 };
  cyc.self = cyc;
  expect(update(cyc, { path: '$.a', set: 2 })).toMatchObject({ ok: false, code: 'cycle-input' });
  expect(hasCycle(cyc)).toBe(true);

  const repl: any = {};
  repl.loop = repl;
  const r = update({ a: 1 }, { path: '$.a', set: repl });
  expect(r).toMatchObject({ ok: false, code: 'cycle-replacement', path: ['a'] });
});

it('treats a batch as atomic: any failure leaves the input untouched', () => {
  const input = { a: 1, b: 2 };
  const r = update(input, [
    { path: '$.a', set: 9 },
    { path: '$.b', apply: () => { throw new Error('x'); } },
  ]);
  expect(r.ok).toBe(false);
  expect(input).toEqual({ a: 1, b: 2 });
});

it('reports no hits for a missing path and returns the same input', () => {
  const input = { a: 1 };
  const r = update(input, { path: '$.nope.deep', set: 1 });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.hits).toEqual([]);
    expect(r.value).toBe(input);
  }
});

it('emits deterministic, path-sorted hit diagnostics', () => {
  const input = { a: [1, 2], b: [3] };
  const r = update(input, { path: '$.*[*]', apply: n => (n as number) + 1 });
  expect(r.ok && r.hits.map(h => h.path)).toEqual([['a', 0], ['a', 1], ['b', 0]]);
});
