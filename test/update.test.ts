import { describe, expect, it } from 'vitest';
import {
  JsonPathTransformError,
  query,
  remove,
  replace,
  update,
  values,
} from '../src/index.js';

describe('replace', () => {
  it('replaces all matched nodes', () => {
    const doc = { a: 1, b: { a: 2 } };
    const next = replace(doc, '$..a', 9);
    expect(next).toEqual({ a: 9, b: { a: 9 } });
    expect(doc).toEqual({ a: 1, b: { a: 2 } }); // untouched input
  });

  it('reuses untouched subtrees by reference', () => {
    const doc = { keep: { x: 1 }, edit: [1, 2, 3], other: 4 };
    const next = replace(doc, '$.edit[0]', 99) as typeof doc;
    expect(next.edit).toEqual([99, 2, 3]);
    expect(next.keep).toBe(doc.keep);
    expect(next).not.toBe(doc);
    expect(next.edit).not.toBe(doc.edit);
  });

  it('returns the exact input when nothing matches', () => {
    const doc = { a: 1 };
    expect(replace(doc, '$.b', 9)).toBe(doc);
    expect(replace(doc, '$..z', 9)).toBe(doc);
  });

  it('corresponds one-to-one with query hits', () => {
    const doc = { list: [1, 2, 3, 4], extra: 5 };
    const hits = values(doc, '$.list[0,2,-1]');
    const next = replace(doc, '$.list[0,2,-1]', 0) as typeof doc;
    expect(hits).toEqual([1, 3, 4]);
    expect(next.list).toEqual([0, 2, 0, 0]);
  });
});

describe('remove', () => {
  it('deletes original indices despite shifting (the servers[0,2,-1] case)', () => {
    const servers = [
      { id: 0 },
      { id: 1 },
      { id: 2 },
      { id: 3 },
      { id: 4 },
    ];
    const doc = { servers };
    const next = remove(doc, '$.servers[0,2,-1]') as typeof doc;
    expect(next.servers.map((s) => s.id)).toEqual([1, 3]);
    expect(doc.servers.map((s) => s.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it('deletes object members', () => {
    const doc = { a: 1, b: 2, c: 3 };
    expect(remove(doc, "$['a','c']")).toEqual({ b: 2 });
    expect(doc).toEqual({ a: 1, b: 2, c: 3 });
  });

  it('deletes by recursive descent including nested hits', () => {
    const doc = { retry: 1, child: { keep: 1, retry: 2 } };
    expect(remove(doc, '$..retry')).toEqual({ child: { keep: 1 } });
  });

  it('deleting the root yields undefined', () => {
    expect(remove({ a: 1 }, '$')).toBeUndefined();
    expect(remove([1, 2], '$[0:2]')).toEqual([]);
  });

  it('keeps references to untouched siblings', () => {
    const keep = { deep: {} };
    const doc = { a: { gone: 1 }, keep };
    const next = remove(doc, '$.a.gone') as typeof doc;
    expect(next.keep).toBe(keep);
  });
});

describe('update with transform functions', () => {
  it('maps every hit and passes the normalized path', () => {
    const doc = { a: 1, b: 2 };
    const paths: string[] = [];
    const next = update(doc, '$[*]', (v, p) => {
      paths.push(p);
      return (v as number) + 10;
    });
    expect(next).toEqual({ a: 11, b: 12 });
    expect(paths).toEqual(["$['a']", "$['b']"]);
  });

  it('is atomic: a throw leaves the input completely unchanged', () => {
    const doc = { a: 1, b: { c: 2 }, d: [3, 4] };
    const snapshot = JSON.stringify(doc);
    let err: unknown;
    try {
      update(doc, '$..*', (v, p) => {
        if (p === "$['b']") throw new Error('boom on file 30');
        return v;
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonPathTransformError);
    expect((err as JsonPathTransformError).path).toBe("$['b']");
    expect(((err as JsonPathTransformError).cause as Error)?.message).toBe(
      'boom on file 30',
    );
    expect(JSON.stringify(doc)).toBe(snapshot);
  });

  it('applies nested transforms bottom-up deterministically', () => {
    const doc = { retry: { count: 1, retry: 5 } };
    const seen: unknown[] = [];
    const next = update(doc, '$..retry', (v) => {
      seen.push(v);
      return typeof v === 'number' ? v + 1 : v;
    }) as typeof doc;
    expect(next.retry.retry).toBe(6);
    // inner number transformed first, outer object sees the changed subtree
    expect(seen[0]).toBe(5);
    expect(seen[1]).toEqual({ count: 1, retry: 6 });
    // run again to prove the result is stable/deterministic
    const again = update(doc, '$..retry', (v) => (typeof v === 'number' ? v + 1 : v));
    expect(again).toEqual(next);
  });

  it('untouched === identity everywhere else', () => {
    const leaf = { z: [1, 2] };
    const doc = { untouched: leaf, edit: { x: 1 } };
    const next = update(doc, '$.edit.x', (v) => (v as number) * 10) as typeof doc;
    expect(next.untouched).toBe(leaf);
    expect(next.edit).not.toBe(doc.edit);
  });

  it('can transform the root itself', () => {
    expect(update(5, '$', (v) => (v as number) + 1)).toBe(6);
  });

  it('query and update agree on exactly which nodes are touched', () => {
    const doc = { servers: [{ port: 80 }, { port: 81 }], meta: { port: 82 } };
    const queried = query(doc, '$..port').map((n) => n.path);
    const paths: string[] = [];
    update(doc, '$..port', (v, p) => {
      paths.push(p);
      return v;
    });
    expect(paths).toEqual(queried);
  });
});

describe('immutability under === comparisons', () => {
  it('a no-op transform returning equal values keeps object identity', () => {
    const doc = { a: [1, 2], b: 3 };
    const next = update(doc, '$..*', (v) => v) as typeof doc;
    expect(next).toBe(doc);
  });

  it('never mutates nested arrays even on index edit', () => {
    const arr = [1, 2, 3];
    const doc = { arr };
    const next = replace(doc, '$.arr[1]', 20) as typeof doc;
    expect(arr).toEqual([1, 2, 3]);
    expect(next.arr).toEqual([1, 20, 3]);
    expect(next.arr[0]).toBe(arr[0]);
  });
});
