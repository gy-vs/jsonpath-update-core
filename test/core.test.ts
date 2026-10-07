import { describe, expect, it } from 'vitest';
import {
  JsonPathSyntaxError,
  parse,
  query,
  sliceIndices,
  values,
} from '../src/index.js';

const store = {
  name: 'demo',
  servers: [
    { host: 'a', port: 80 },
    { host: 'b', port: 81 },
    { host: 'c', port: 82 },
    { host: 'd', port: 83 },
  ],
  retry: { count: 3, retry: 2 },
  nested: { a: { b: [{ x: 1 }, { x: 2 }] } },
};

describe('root and basic members', () => {
  it('queries the root', () => {
    expect(query(store, '$')).toEqual([{ value: store, path: '$' }]);
  });

  it('reads dotted members', () => {
    expect(values(store, '$.name')).toEqual(['demo']);
    expect(query(store, '$.name')[0].path).toBe("$['name']");
  });

  it('reads bracketed single/double quoted members with escapes', () => {
    const doc = { "a'b": 1, 'c"d': 2, 'e\\f': 3, g: 4 };
    expect(values(doc, "$[\"a'b\"]")).toEqual([1]);
    expect(values(doc, "$['c\"d']")).toEqual([2]);
    expect(values(doc, "$['e\\\\f']")).toEqual([3]);
    expect(query(doc, "$[\"a'b\"]")[0].path).toBe("$['a\\'b']");
  });

  it('parses unicode and short escapes', () => {
    const doc = { 'é': 1, '\n': 2, '好': 3 };
    expect(values(doc, "$['\\u00e9']")).toEqual([1]);
    expect(values(doc, "$['\\n']")).toEqual([2]);
    expect(values(doc, '$.好')).toEqual([3]);
  });

  it('returns nothing for missing members and primitives as containers', () => {
    expect(query(store, '$.missing')).toEqual([]);
    expect(query(1, '$.x')).toEqual([]);
    expect(query(null, '$.x')).toEqual([]);
    expect(query('s', '$[0]')).toEqual([]);
  });
});

describe('wildcard', () => {
  it('lists object members and array elements', () => {
    expect(values({ a: 1, b: 2 }, '$.*')).toEqual([1, 2]);
    expect(values([10, 20, 30], '$[*]')).toEqual([10, 20, 30]);
  });

  it('produces normalized paths in document order', () => {
    expect(query([10, 20], '$[*]').map((n) => n.path)).toEqual(['$[0]', '$[1]']);
    expect(query({ a: 1, b: 2 }, '$.*').map((n) => n.path)).toEqual([
      "$['a']",
      "$['b']",
    ]);
  });
});

describe('indices', () => {
  it('handles positive and negative indices', () => {
    expect(values([1, 2, 3], '$[0]')).toEqual([1]);
    expect(values([1, 2, 3], '$[-1]')).toEqual([3]);
    expect(values([1, 2, 3], '$[-3]')).toEqual([1]);
  });

  it('returns nothing out of bounds', () => {
    expect(query([1], '$[3]')).toEqual([]);
    expect(query([1], '$[-2]')).toEqual([]);
  });

  it('does not match object keys that look numeric', () => {
    expect(query({ '0': 'x' }, '$[0]')).toEqual([]);
  });
});

describe('slices', () => {
  const a = [0, 1, 2, 3, 4, 5, 6];

  it.each([
    ['[5:1:-1]', [5, 4, 3, 2]],
    ['[::-1]', [6, 5, 4, 3, 2, 1, 0]],
    ['[::1]', a],
    ['[:]', a],
    ['[1:5]', [1, 2, 3, 4]],
    ['[1:5:2]', [1, 3]],
    ['[-3:]', [4, 5, 6]],
    ['[:-5]', [0, 1]],
    ['[-100:2]', [0, 1]],
    ['[0:-100]', []],
    ['[100:200]', []],
    ['[6:0:-2]', [6, 4, 2]],
    ['[-1:-3:-1]', [6, 5]],
    ['[-100::-1]', []],
    ['[0:-100:-1]', [0]],
    ['[7:-3:-2]', [6]],
    ['[-3:-7:-1]', [4, 3, 2, 1]],
    ['[2:-100:-1]', [2, 1, 0]],
  ])('slice %s -> %j', (expr, want) => {
    expect(values(a, '$' + expr)).toEqual(want);
  });

  it('step zero selects nothing and never hangs', () => {
    expect(values(a, '$[::0]')).toEqual([]);
    expect(sliceIndices(a.length, null, null, 0)).toEqual([]);
  });

  it('allows whitespace around slice colons', () => {
    expect(values(a, '$[ 1 : 5 : 2 ]')).toEqual([1, 3]);
    expect(values(a, '$[::]')).toEqual(a);
  });
});

describe('recursive descent', () => {
  it('visits node then descendants in pre-order document order', () => {
    const doc = {
      o: { j: 1, k: 2 },
      a: [5, 3, [{ j: 4 }, { k: 6 }]],
    };
    expect(query(doc, '$..j').map((n) => n.path)).toEqual([
      "$['o']['j']",
      "$['a'][2][0]['j']",
    ]);
    expect(query(doc, '$..j').map((n) => n.value)).toEqual([1, 4]);
  });

  it('descending wildcard enumerates every node', () => {
    const doc = { a: [1, { b: 2 }] };
    expect(query(doc, '$..*').map((n) => n.path)).toEqual([
      "$['a']",
      "$['a'][0]",
      "$['a'][1]",
      "$['a'][1]['b']",
    ]);
  });

  it('descends into arrays by index', () => {
    expect(values([[1], [2, [3]]], '$..[0]')).toEqual([[1], 1, 2, 3]);
  });

  it('handles shared subtrees (visited via both parents)', () => {
    const shared = { retry: 7 };
    const doc = { a: shared, b: shared };
    expect(values(doc, '$..retry')).toEqual([7, 7]);
  });

  it('reports true cycles rather than looping', () => {
    const doc: Record<string, unknown> = { a: 1 };
    doc.self = doc;
    expect(() => query(doc, '$..a')).toThrow(/cyclic reference/);
  });
});

describe('unions', () => {
  it('concatenates selector results in written order', () => {
    expect(values(['a', 'b', 'c', 'd'], '$[0,2,-1]')).toEqual(['a', 'c', 'd']);
    expect(values({ x: 1, y: 2, z: 3 }, "$['x','z']")).toEqual([1, 3]);
  });

  it('mixes selectors and tolerates whitespace', () => {
    expect(values([0, 1, 2, 3], '$[ 0 , -1 ]')).toEqual([0, 3]);
  });

  it('keeps duplicates when selectors overlap', () => {
    expect(values([0, 1, 2], '$[0, 0]')).toEqual([0, 0]);
  });

  it('chained after descent', () => {
    const doc = { list: [{ x: 1 }, { x: 2 }], other: { x: 3 } };
    expect(values(doc, "$..['x']")).toEqual([1, 2, 3]);
  });
});

describe('parser errors point at a position', () => {
  it.each([
    ['', 0],
    ['a', 0],
    ['.a', 0],
    ['$..', 3],
    ['$.', 2],
    ['$[]', 2],
    ['$[', 1],
    ["$['a'", 1],
    ['$[1,]', 4],
    ['$[,1]', 2],
    ['$[01]', 2],
    ['$[-0]', 2],
    ['$[9007199254740992]', 2],
    ['$[?@.x]', 2],
    ['$[(1+1)]', 2],
    ['$["\\\'"]', 3],
    ["$['\\\"']", 3],
    ['$["\\uD800"]', 3],
    ['$.. ', 3],
    ['$ ', 1],
  ])('rejects %j at position %d', (expr, pos) => {
    try {
      parse(expr);
      throw new Error('expected syntax error for ' + expr);
    } catch (e) {
      expect(e).toBeInstanceOf(JsonPathSyntaxError);
      expect((e as JsonPathSyntaxError).position).toBe(pos);
    }
  });

  it('accepts segments preceded by whitespace incl newlines', () => {
    expect(values({ a: { b: 1 } }, "$ \n ['a']\t['b']")).toEqual([1]);
  });
});

describe('repeatability', () => {
  it('returns identical results on repeated runs', () => {
    const doc = { servers: [{ x: 1 }, { x: [{ y: 2 }] }] };
    const first = JSON.stringify(query(doc, '$..x'));
    for (let i = 0; i < 5; i++) {
      expect(JSON.stringify(query(doc, '$..x'))).toBe(first);
    }
  });

  it('accepts a pre-parsed AST', () => {
    const ast = parse('$.name');
    expect(values(store, ast)).toEqual(['demo']);
    expect(values(store, ast)).toEqual(['demo']);
  });
});
