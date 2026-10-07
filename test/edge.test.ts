import { describe, expect, it } from 'vitest';
import {
  JsonPathCycleError,
  JsonPathTransformError,
  query,
  remove,
  replace,
  update,
  values,
} from '../src/index.js';

describe('shared subtrees (DAGs)', () => {
  it('query hits both references and update rewrites both locations', () => {
    const shared = { port: 80 };
    const doc = { primary: shared, secondary: shared };
    const hits = query(doc, '$..port');
    expect(hits.map((n) => n.path)).toEqual([
      "$['primary']['port']",
      "$['secondary']['port']",
    ]);

    const next = replace(doc, '$..port', 81) as typeof doc;
    expect(next.primary.port).toBe(81);
    expect(next.secondary.port).toBe(81);
    expect(doc.primary.port).toBe(80);
    // The two rewritten parents are independent containers.
    expect(next.primary).not.toBe(next.secondary);
  });

  it('an untouched shared subtree is reused in both places', () => {
    const keep = { only: 1 };
    const doc = { a: { x: keep }, b: { y: keep }, edit: 0 };
    const next = replace(doc, '$.edit', 1) as typeof doc;
    expect(next.a.x).toBe(keep);
    expect(next.b.y).toBe(keep);
  });
});

describe('nested matched ancestor and descendant ($..retry case)', () => {
  it('delete removes both the outer and inner matched nodes', () => {
    const doc = { retry: { inner: 1, retry: 2 }, sibling: { retry: 3 } };
    expect(remove(doc, '$..retry')).toEqual({ sibling: {} });
  });

  it('replace wins for the outer node and drops inner work deterministically', () => {
    const doc = { retry: { retry: 1 } };
    expect(replace(doc, '$..retry', 0)).toEqual({ retry: 0 });
  });

  it('transform runs bottom-up so the outer sees the transformed inner value', () => {
    const doc = { retry: { retry: 5, keep: 9 } };
    const next = update(doc, '$..retry', (v) =>
      typeof v === 'number' ? v + 1 : v,
    ) as typeof doc;
    expect(next).toEqual({ retry: { retry: 6, keep: 9 } });
  });
});

describe('update errors are atomic and localized', () => {
  it('reports the failing normalized path and leaves input intact', () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({ idx: i, cfg: { n: i } }));
    const original = JSON.stringify(docs);
    let count = 0;
    let err: unknown;
    try {
      update(docs, '$[*].cfg.n', (v, p) => {
        count++;
        if (count === 30) throw new Error('boom');
        return (v as number) + 1;
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonPathTransformError);
    expect((err as JsonPathTransformError).path).toBe('$[29][\'cfg\'][\'n\']');
    expect(JSON.stringify(docs)).toBe(original);
  });

  it('an error inside a recursive descent still changes nothing', () => {
    const doc = { a: { x: 1 }, b: { x: 2 }, c: { x: 3 } };
    let err: unknown;
    try {
      update(doc, '$..x', () => {
        throw new Error('no');
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JsonPathTransformError);
    expect(doc).toEqual({ a: { x: 1 }, b: { x: 2 }, c: { x: 3 } });
  });
});

describe('cycle safety on update', () => {
  it('a true cycle errors rather than hanging', () => {
    const doc: Record<string, unknown> = { child: {} };
    doc.child = doc;
    expect(() => values(doc, '$..child')).toThrow(JsonPathCycleError);
    expect(() => replace(doc, '$..child', 1)).toThrow(JsonPathCycleError);
  });
});

describe('ordering stability', () => {
  it('union, slice and descent results are stable across runs', () => {
    const doc = { list: [0, 1, 2, 3, 4], deep: [[5, 6], { list: [7, 8] }] };
    const exprs = ['$.list[0,2,-1]', '$.list[5:1:-1]', '$..list'];
    for (const e of exprs) {
      const first = JSON.stringify(query(doc, e));
      for (let i = 0; i < 10; i++) {
        expect(JSON.stringify(query(doc, e))).toBe(first);
      }
    }
  });
});

describe('overlapping unions (duplicate hits)', () => {
  it('query keeps duplicates and update applies the transform once per hit', () => {
    const d = [10, 20, 30];
    expect(query(d, '$[0,0,-1]').map((n) => n.path)).toEqual(['$[0]', '$[0]', '$[2]']);
    expect(update(d, '$[0,0,-1]', (v) => (v as number) + 1)).toEqual([12, 20, 31]);
    // replace/remove collapse to one node edit (a constant cannot compose).
    expect(replace(d, '$[0,0]', 99)).toEqual([99, 20, 30]);
    expect(remove(d, '$[0,0]')).toEqual([20, 30]);
  });
});
