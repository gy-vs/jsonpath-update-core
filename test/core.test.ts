import { describe, expect, it } from 'vitest';
import {
  CyclicReferenceError,
  JSONPathSyntaxError,
  parse,
  query,
} from '../src/index.js';

const doc = {
  servers: [
    { host: 'a.example', port: 80, retry: { count: 1, nested: { retry: 2 } } },
    { host: 'b.example', port: 8080, tags: ['x', 'y'] },
    { host: 'c.example', port: null },
  ],
  retry: 3,
  'weird.key': 4,
} as unknown;

describe('parse', () => {
  it('根查询', () => {
    expect(parse('$').segments).toEqual([]);
  });
  it('段前空白允许、整体首尾空白不允许', () => {
    expect(parse('$ .a [ 0 ]').segments).toHaveLength(2);
    expect(() => parse(' $')).toThrow(JSONPathSyntaxError);
    expect(() => parse('$ ')).toThrow(JSONPathSyntaxError);
  });
});

describe('基本选择器与规范路径', () => {
  it('点号成员名', () => {
    const r = query(doc, '$.retry');
    expect(r.map((n) => n.value)).toEqual([3]);
    expect(r[0].path).toBe("$['retry']");
    expect(r[0].keys).toEqual(['retry']);
  });

  it("方括号单/双引号与点号特殊键", () => {
    expect(query(doc, "$['weird.key']")[0].value).toBe(4);
    expect(query(doc, '$["weird.key"]')[0].path).toBe("$['weird.key']");
  });

  it('引号转义', () => {
    const d = { "a'b": { 'c\\d': 1, '\n': 2, '': 3 } } as unknown;
    expect(query(d, "$[\"a'b\"]['c\\\\d']")[0].path).toBe("$['a\\'b']['c\\\\d']");
    expect(query(d, "$[\"a'b\"]['\\n']")[0].value).toBe(2);
    expect(query(d, "$[\"a'b\"]['\\u000B']")[0].path).toBe("$['a\\'b']['\\u000b']");
    expect(query(d, "$[\"a'b\"]['\\u000b']")[0].value).toBe(3);
    expect(query(d, "$[\"a'b\"]['\\u0061']").length).toBe(0); // 解码后键是 'a'，不存在
  });

  it('通配对象与数组，数组按下标顺序', () => {
    const r = query(doc, '$.servers[*].host');
    expect(r.map((n) => n.value)).toEqual(['a.example', 'b.example', 'c.example']);
    expect(r.map((n) => n.path)).toEqual([
      "$['servers'][0]['host']",
      "$['servers'][1]['host']",
      "$['servers'][2]['host']",
    ]);
  });

  it('通配不作用于基本类型', () => {
    expect(query(1, '$.*')).toEqual([]);
    expect(query('s', '$.*')).toEqual([]);
    expect(query(null, '$.*')).toEqual([]);
  });

  it('名称选择器不作用于数组（数组没有 .length 这类成员）', () => {
    expect(query([1, 2, 3], '$.length')).toEqual([]);
  });
});

describe('下标', () => {
  it('正下标与负下标', () => {
    expect(query(doc, '$.servers[-1].host')[0].value).toBe('c.example');
    expect(query(doc, '$.servers[0].host')[0].value).toBe('a.example');
    expect(query(doc, '$.servers[9].host')).toEqual([]);
    expect(query(doc, '$.servers[-9].host')).toEqual([]);
  });
  it('负下标规范化为正路径', () => {
    expect(query([10, 20, 30], '$[-2]')[0].path).toBe('$[1]');
  });
});

describe('切片（RFC 2.3.4 例）', () => {
  const a = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
  it('常规起止与步长', () => {
    expect(query(a, '$[1:3]').map((n) => n.value)).toEqual(['b', 'c']);
    expect(query(a, '$[5:]').map((n) => n.value)).toEqual(['f', 'g']);
    expect(query(a, '$[1:5:2]').map((n) => n.value)).toEqual(['b', 'd']);
    expect(query(a, '$[::2]').map((n) => n.value)).toEqual(['a', 'c', 'e', 'g']);
  });
  it('负步长（旧脚本算错的重点）', () => {
    expect(query(a, '$[5:1:-1]').map((n) => n.value)).toEqual(['f', 'e', 'd', 'c']);
    expect(query(a, '$[::-1]').map((n) => n.value)).toEqual(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    expect(query(a, '$[5:1:-2]').map((n) => n.value)).toEqual(['f', 'd']);
    expect(query(a, '$[::-2]').map((n) => n.value)).toEqual(['g', 'e', 'c', 'a']);
  });
  it('越界与负边界归一化', () => {
    expect(query(a, '$[-3:]').map((n) => n.value)).toEqual(['e', 'f', 'g']);
    expect(query(a, '$[-3:-5]').map((n) => n.value)).toEqual([]);
    expect(query(a, '$[-3:-5:-1]').map((n) => n.value)).toEqual(['e', 'd']);
    expect(query(a, '$[100:200]').map((n) => n.value)).toEqual([]);
    expect(query(a, '$[-100:2]').map((n) => n.value)).toEqual(['a', 'b']);
    expect(query(a, '$[8:2:-1]').map((n) => n.value)).toEqual(['g', 'f', 'e', 'd']);
    // n_end = 7 + (-100) = -93；clamp 到 -1，while(-1 < i) 仍包含下标 0
    expect(query(a, '$[8:-100:-1]').map((n) => n.value)).toEqual(['g', 'f', 'e', 'd', 'c', 'b', 'a']);
    expect(query(a, '$[::0]')).toEqual([]); // step 0：选空，不抛错不卡死
  });
  it('确定性：多跑几次结果一致', () => {
    const once = query(a, '$[::-1]').map((n) => n.path);
    for (let k = 0; k < 10; k++) {
      expect(query(a, '$[::-1]').map((n) => n.path)).toEqual(once);
    }
  });
});

describe('递归下降', () => {
  it('前序：节点先于后代；数组按下标顺序', () => {
    expect(query(doc, '$..retry').map((n) => n.path)).toEqual([
      "$['retry']",
      "$['servers'][0]['retry']",
      "$['servers'][0]['retry']['nested']['retry']",
    ]);
  });

  it('RFC 2.5.2.3 的 $..[0]', () => {
    const d = { o: { j: 1, k: 2 }, a: [5, 3, [{ j: 4 }, { k: 6 }]] };
    expect(query(d, '$..[0]').map((n) => [n.path, n.value])).toEqual([
      ["$['a'][0]", 5],
      ["$['a'][2][0]", { j: 4 }],
    ]);
  });

  it('$..* 全值前序', () => {
    const d = { o: { j: 1, k: 2 }, a: [5, 3] };
    expect(query(d, '$..*').map((n) => n.path)).toEqual([
      "$['o']",
      "$['a']",
      "$['o']['j']",
      "$['o']['k']",
      "$['a'][0]",
      "$['a'][1]",
    ]);
  });

  it('递归下降并集', () => {
    const d = { o: { j: 1, k: 2 } };
    expect(query(d, "$..['j','k']").map((n) => n.value)).toEqual([1, 2]);
  });

  it('结果确定可复现', () => {
    const first = query(doc, '$..host').map((n) => n.path);
    for (let k = 0; k < 10; k++) {
      expect(query(doc, '$..host').map((n) => n.path)).toEqual(first);
    }
  });
});

describe('并集', () => {
  it('逗号分隔，按下标顺序拼接', () => {
    expect(query(['a', 'b', 'c', 'd', 'e', 'f'], '$[0,3,5]').map((n) => n.value)).toEqual([
      'a',
      'd',
      'f',
    ]);
  });
  it('重复命中保留（RFC 2.5.1.2）', () => {
    const r = query(['a', 'b'], '$[0,0]');
    expect(r.map((n) => n.value)).toEqual(['a', 'a']);
    expect(r.map((n) => n.path)).toEqual(['$[0]', '$[0]']);
  });
  it('混合选择器与切片', () => {
    const a = ['a', 'b', 'c', 'd', 'e', 'f'];
    expect(query(a, '$[0:2,5]').map((n) => n.value)).toEqual(['a', 'b', 'f']);
    const o = { a: 1, b: 2, c: 3 };
    expect(query(o, "$[*,'a']").map((n) => n.value)).toEqual([1, 2, 3, 1]);
  });
  it('支持括号内空白', () => {
    expect(query([1, 2, 3], '$[ 0 , 2 ]').map((n) => n.value)).toEqual([1, 3]);
  });

  it('切片空白遵循 ABNF：[start S] ":" S [end S] [":" [S step]]', () => {
    const a = [0, 1, 2, 3, 4, 5];
    expect(query(a, '$[1 : 3]').map((n) => n.value)).toEqual([1, 2]);
    expect(query(a, '$[ 1 : 5 : 2 ]').map((n) => n.value)).toEqual([1, 3]);
    expect(query(a, '$[ : : 2 ]').map((n) => n.value)).toEqual([0, 2, 4]);
    expect(query(a, '$[5 : 1 : -1]').map((n) => n.value)).toEqual([5, 4, 3, 2]);
    // 整数后紧跟非空白垃圾仍然非法
    expect(() => parse('$[1 2]')).toThrow(JSONPathSyntaxError);
  });
});

describe('语法错误与位置', () => {
  const bad = [
    '',
    'x',
    '$.',
    '$..',
    '$.. a',
    '$.&',
    '$.1',
    '$[]',
    '$[,0]',
    '$[0,]',
    '$[0 2]',
    '$.a[?@.x]',
    '$[?(@.a==1)]',
    '$[@.a]',
    '$[$.a]',
    '$[1:2:3:4]',
    '$[1:2:a]',
    '$[01]',
    '$[+1]',
    '$[-0]',
    '$[::01]',
    '$[9007199254740992]',
    "$['a]",
    "$[\"\\a\"]",
    "$['\\u123']",
    "$['\\uD800']",
    "$['\\uD800\\u1234']",
    "$['\\x00']",
    "$['a'",
    "$['a' 'b']",
    '$.a..b', // .. 后面可以接段，实际合法——从列表移除
  ];
  const actuallyValid = new Set(['$.a..b']);
  for (const expr of bad) {
    if (actuallyValid.has(expr)) {
      it(`${expr} 合法`, () => expect(() => query({}, expr)).not.toThrow());
      continue;
    }
    it(`拒绝 ${JSON.stringify(expr)}`, () => {
      try {
        parse(expr);
        throw new Error('应当抛错');
      } catch (e) {
        expect(e).toBeInstanceOf(JSONPathSyntaxError);
        expect(Number.isInteger((e as JSONPathSyntaxError).position)).toBe(true);
      }
    });
  }

  it('过滤器错误指明位置', () => {
    try {
      parse('$.a[?@.x]');
      throw new Error('应当抛错');
    } catch (e) {
      expect((e as JSONPathSyntaxError).position).toBe(4);
    }
  });
});

describe('别名与循环引用', () => {
  it('同一对象被两处引用，两处都命中', () => {
    const shared = { retry: 9 };
    const d = { x: shared, y: shared };
    const r = query(d, '$..retry');
    expect(r).toHaveLength(2);
    expect(r[0].path).toBe("$['x']['retry']");
    expect(r[1].path).toBe("$['y']['retry']");
  });

  it('真正绕回祖先的环报错并给出路径', () => {
    const d: Record<string, unknown> = { a: { b: {} } };
    d.a.b = d;
    expect(() => query(d, '$..x')).toThrow(CyclicReferenceError);
  });

  it('数组中的自环也报错', () => {
    const d: unknown[] = [1];
    d.push(d);
    expect(() => query(d, '$..*')).toThrow(CyclicReferenceError);
  });

  it('菱形引用（DAG）不是环', () => {
    const shared = { v: 1 };
    const d = { x: shared, y: shared, z: { nested: shared } };
    expect(query(d, '$..v')).toHaveLength(3);
  });
});

describe('深嵌套不爆栈', () => {
  it('5000 层对象的查询', () => {
    let d: any = { leaf: 1 };
    for (let i = 0; i < 5000; i++) d = { a: d };
    const r = query(d, '$..leaf');
    expect(r).toHaveLength(1);
    expect(r[0].path).toBe('$' + "['a']".repeat(5000) + "['leaf']");
  });
});
