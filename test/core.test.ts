import { expect, it, describe } from 'vitest';
import { parse, pathString, query, update } from '../src/index.js';

describe('query (existing API)', () => {
  it('queries', () => expect(query({ a: 1 }, parse('$.a'))).toEqual([1]));

  it('supports array indexes and bracket fields', () => {
    const data = { items: [10, 20, 30], 'weird key': 1 };
    expect(query(data, parse('$.items[1]'))).toEqual([20]);
    expect(query(data, parse("$['weird key']"))).toEqual([1]);
    expect(query(data, parse('$.items[*]'))).toEqual([10, 20, 30]);
  });

  it('out-of-range indexes produce no results', () => {
    expect(query({ a: [] }, parse('$.a[0]'))).toEqual([]);
  });
});

describe('update basics', () => {
  it('replaces matched nodes structurally without mutating input', () => {
    const input = { a: 1, b: { c: 2 } };
    const result = update(input, { path: '$.a', action: { type: 'replace', value: 9 } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ a: 9, b: { c: 2 } });
    expect(input).toEqual({ a: 1, b: { c: 2 } });
  });

  it('reports hits in deterministic document order', () => {
    const input = { arr: [{ n: 1 }, { n: 2 }, { n: 3 }] };
    const result = update(input, {
      path: '$.arr[*].n',
      action: { type: 'replace', value: 0 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.hits.map((h) => h.path)).toEqual(['$.arr[0].n', '$.arr[1].n', '$.arr[2].n']);
    expect(result.hits.map((h) => h.value)).toEqual([1, 2, 3]);
  });

  it('transforms values and shares unchanged subtrees', () => {
    const shared = { keep: { deep: true } };
    const input = { a: 1, shared };
    const result = update(input, {
      path: '$.a',
      action: { type: 'transform', fn: (v) => (v as number) + 1 },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ a: 2, shared: { keep: { deep: true } } });
    expect((result.value as typeof input).shared).toBe(shared);
  });

  it('passes context (op, path, segments) to transform functions', () => {
    const input = { a: [1, 2] };
    const seen: string[] = [];
    const result = update(input, {
      path: '$.a[*]',
      action: { type: 'transform', fn: (_v, ctx) => void seen.push(pathString(ctx.segments)) },
    });
    expect(result.ok).toBe(true);
    expect(seen).toEqual(['$.a[0]', '$.a[1]']);
  });
});

describe('object key deletion', () => {
  it('deletes a single key', () => {
    const input = { a: 1, b: 2 };
    const result = update(input, { path: '$.a', action: { type: 'delete' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ b: 2 });
    expect(input).toEqual({ a: 1, b: 2 });
  });

  it('deletes multiple keys in one atomic batch', () => {
    const input = { a: 1, b: 2, c: 3 };
    const result = update(input, [
      { path: '$.a', action: { type: 'delete' } },
      { path: '$.c', action: { type: 'delete' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ b: 2 });
  });
});

describe('array deletion by original index', () => {
  it('removes multiple indexes planned against the original array', () => {
    const input = { xs: [0, 1, 2, 3, 4] };
    const result = update(input, [
      { path: '$.xs[0]', action: { type: 'delete' } },
      { path: '$.xs[2]', action: { type: 'delete' } },
      { path: '$.xs[4]', action: { type: 'delete' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ xs: [1, 3] });
    expect(input).toEqual({ xs: [0, 1, 2, 3, 4] });
  });

  it('mixes deletion and transform in one batch by original indexes', () => {
    const result = update([10, 20, 30, 40], [
      { path: '$[1]', action: { type: 'delete' } },
      { path: '$[0]', action: { type: 'transform', fn: (v) => (v as number) * 100 } },
      { path: '$[3]', action: { type: 'delete' } },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([1000, 30]);
  });
});

describe('root replacement', () => {
  it('replaces the whole document', () => {
    const result = update({ a: 1 }, { path: '$', action: { type: 'replace', value: [1, 2] } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([1, 2]);
    expect(result.hits[0].path).toBe('$');
    expect(result.hits[0].segments).toEqual([]);
  });

  it('transforms the root', () => {
    const result = update({ a: 1 }, {
      path: '$',
      action: { type: 'transform', fn: (v) => ({ wrapped: v }) },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ wrapped: { a: 1 } });
  });

  it('deleting the root yields undefined', () => {
    const result = update({ a: 1 }, { path: '$', action: { type: 'delete' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });
});

describe('duplicate-reference conflicts', () => {
  it('rejects the same node matched by two operations', () => {
    const input = { a: 1 };
    const result = update(input, [
      { path: '$.a', action: { type: 'replace', value: 2 } },
      { path: "$['a']", action: { type: 'replace', value: 3 } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'conflict', reason: 'duplicate-reference', path: '$.a' });
    expect(result.hits).toHaveLength(2);
    // Original reference returned untouched.
    expect(result.value).toBe(input);
  });
});

describe('ancestor/descendant conflicts', () => {
  it('rejects when an ancestor and its descendant are both targeted', () => {
    const input = { a: { b: 1 } };
    const result = update(input, [
      { path: '$.a.b', action: { type: 'replace', value: 2 } },
      { path: '$.a', action: { type: 'delete' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({
      kind: 'conflict',
      reason: 'ancestor-descendant',
      ancestor: '$.a',
      descendant: '$.a.b',
    });
    expect(result.value).toBe(input);
    expect(input).toEqual({ a: { b: 1 } });
  });

  it('rejects root together with any other hit', () => {
    const result = update({ a: 1 }, [
      { path: '$', action: { type: 'replace', value: null } },
      { path: '$.a', action: { type: 'delete' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'conflict', reason: 'ancestor-descendant' });
  });
});

describe('transform failures are atomic', () => {
  it('returns unmodified input and hit diagnostics when a function throws', () => {
    const input = { a: 1, b: 2, c: 3 };
    const boom = new Error('boom');
    const result = update(input, [
      { path: '$.a', action: { type: 'transform', fn: () => 9 } },
      {
        path: '$.b',
        action: {
          type: 'transform',
          fn: () => {
            throw boom;
          },
        },
      },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'transform-failed', op: 1, path: '$.b' });
    expect((result.error as { cause?: unknown }).cause).toBe(boom);
    // Diagnostics still describe everything that was matched on the snapshot.
    expect(result.hits.map((h) => h.path)).toEqual(['$.a', '$.b']);
    // Nothing was applied: same reference and unchanged content.
    expect(result.value).toBe(input);
    expect(input).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('aborts later transforms once one fails', () => {
    const calls: string[] = [];
    const result = update({ a: 1, b: 2 }, [
      { path: '$.a', action: { type: 'transform', fn: () => { throw new Error('x'); } } },
      { path: '$.b', action: { type: 'transform', fn: () => void calls.push('b') } },
    ]);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe('cyclic structures are rejected', () => {
  it('refuses cyclic input with a diagnostic path', () => {
    const input: Record<string, unknown> = { a: 1 };
    input.self = input;
    const result = update(input, { path: '$.a', action: { type: 'replace', value: 2 } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'cycle', where: 'input' });
    expect(result.value).toBe(input);
  });

  it('refuses cyclic replacement values before touching anything', () => {
    const cyc: Record<string, unknown> = {};
    cyc.loop = cyc;
    const input = { a: 1 };
    const result = update(input, { path: '$.a', action: { type: 'replace', value: cyc } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'cycle', where: 'replacement', op: 0 });
  });

  it('refuses cyclic transform output atomically', () => {
    const input = { a: 1, b: 2 };
    const cyc: Record<string, unknown> = {};
    cyc.loop = cyc;
    const result = update(input, [
      { path: '$.b', action: { type: 'transform', fn: () => 5 } },
      { path: '$.a', action: { type: 'transform', fn: () => cyc } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'cycle', where: 'transform-output', path: '$.loop' });
    expect(result.value).toBe(input);
  });
});

describe('parse errors and invalid operations', () => {
  it('reports the failing operation index', () => {
    const result = update({ a: 1 }, [
      { path: '$.a', action: { type: 'delete' } },
      { path: 'oops.a', action: { type: 'delete' } },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'parse', op: 1 });
  });

  it('rejects unknown action types', () => {
    const result = update({ a: 1 }, {
      path: '$.a',
      action: { type: 'upsert' } as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatchObject({ kind: 'invalid-op' });
  });
});

describe('empty/no-op batches', () => {
  it('shares the input when nothing matches', () => {
    const input = { a: 1 };
    const result = update(input, { path: '$.missing.deep', action: { type: 'delete' } });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
    expect(result.hits).toEqual([]);
  });

  it('empty operation list is a no-op sharing the reference', () => {
    const input = { a: 1 };
    const result = update(input, []);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe(input);
  });
});
