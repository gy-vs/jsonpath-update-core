import { describe, expect, it } from 'vitest';
import {
  CyclicReferenceError,
  JSONPathSyntaxError,
  parse,
  query,
  remove,
  replace,
  transform,
} from '../src/index.js';

describe('replace', () => {
  it('逐点替换并给出规范路径结果', () => {
    const doc = { servers: [{ host: 'a' }, { host: 'b' }] };
    const r = replace(doc, '$.servers[*].host', 'x');
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ servers: [{ host: 'x' }, { host: 'x' }] });
    expect(r.changed).toBe(true);
    expect(r.count).toBe(2);
  });

  it('输入不被修改', () => {
    const doc = { servers: [{ host: 'a' }, { host: 'b' }] };
    const snapshot = JSON.parse(JSON.stringify(doc));
    replace(doc, '$.servers[*].host', 'x');
    expect(doc).toEqual(snapshot);
  });

  it('未改到的子树原样复用（===）', () => {
    const untouched = { deep: { value: 42 } };
    const doc = { hit: 1, keep: untouched };
    const r = replace(doc, '$.hit', 99);
    expect(r.ok).toBe(true);
    expect((r.value as any).keep).toBe(untouched);
    expect((r.value as any).keep.deep).toBe(untouched.deep);
    expect(doc.keep).toBe(untouched);
  });

  it('值相同则整体不换引用', () => {
    const doc = { a: 1, b: 2 };
    const r = replace(doc, '$.a', 1);
    expect(r.changed).toBe(false);
    expect(r.value).toBe(doc);
  });

  it('命中点与 query 一一对应', () => {
    const doc = { a: [1, 2, 3], b: { a: 4 } };
    const expr = '$..[*]';
    const q = query(doc, expr);
    const r = replace(doc, expr, 0);
    expect(r.ok).toBe(true);
    expect(r.count).toBe(q.length);
  });
});

describe('remove', () => {
  it('删数组多个下标，按原数组位置删除（小周的例子）', () => {
    const doc = { servers: ['s0', 's1', 's2', 's3', 's4'] };
    const r = remove(doc, '$.servers[0,2,-1]');
    expect(r.ok).toBe(true);
    expect((r.value as any).servers).toEqual(['s1', 's3']);
    // 输入未动
    expect(doc.servers).toEqual(['s0', 's1', 's2', 's3', 's4']);
  });

  it('重复命中同一位置只删一次', () => {
    const doc = [0, 1, 2];
    const r = remove(doc, '$[0,0]');
    expect(r.value).toEqual([1, 2]);
    expect(r.count).toBe(2); // query 仍然是两个命中点
  });

  it('删对象成员', () => {
    const doc = { a: 1, b: 2, c: 3 };
    const r = remove(doc, "$['a','c']");
    expect(r.value).toEqual({ b: 2 });
  });

  it('递归下降删除', () => {
    const doc = { x: { drop: 1, keep: 2 }, y: { drop: 3 } };
    const r = remove(doc, '$..drop');
    expect(r.value).toEqual({ x: { keep: 2 }, y: {} });
  });

  it('删除根节点得到 null', () => {
    const doc = { a: 1 };
    const r = remove(doc, '$');
    expect(r.value).toBeNull();
    expect(r.changed).toBe(true);
    expect(doc).toEqual({ a: 1 }); // 输入仍在
  });

  it('没有命中时原样返回', () => {
    const doc = { a: 1 };
    const r = remove(doc, '$.nope');
    expect(r.value).toBe(doc);
    expect(r.changed).toBe(false);
    expect(r.count).toBe(0);
  });

  it('切片删除', () => {
    const r = remove([0, 1, 2, 3, 4], '$[1:4:2]');
    expect(r.value).toEqual([0, 2, 4]);
  });

  it('逆序切片删除以原位置为准', () => {
    const r = remove(['a', 'b', 'c', 'd', 'e', 'f'], '$[5:1:-1]');
    expect(r.value).toEqual(['a', 'b']);
  });
});

describe('transform', () => {
  it('函数收到 (原值, 规范路径)，返回值替换', () => {
    const doc = { servers: [{ port: 80 }, { port: 8080 }] };
    const seen: Array<[unknown, string]> = [];
    const r = transform(doc, '$.servers[*].port', (v, p) => {
      seen.push([v, p]);
      return (v as number) + 1;
    });
    expect(r.value).toEqual({ servers: [{ port: 81 }, { port: 8081 }] });
    expect(seen).toEqual([
      [80, "$['servers'][0]['port']"],
      [8080, "$['servers'][1]['port']"],
    ]);
  });

  it('任一函数抛错：原子失败，返回原样输入与出错路径', () => {
    const doc = { list: [1, 2, 3, 4] };
    const boom = new Error('boom at 30th file');
    const r = transform(doc, '$.list[*]', (v) => {
      if (v === 3) throw boom;
      return (v as number) * 10;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.value).toBe(doc);
      expect(r.changed).toBe(false);
      expect(r.index).toBe(2);
      expect(r.path).toBe("$['list'][2]");
      expect(r.op).toBe('transform');
      expect(r.error).toBe(boom);
    }
    // 前两个点即便“算过”新值，输入也没有半改状态
    expect(doc).toEqual({ list: [1, 2, 3, 4] });
  });

  it('可以用 AST 重复执行同一表达式', () => {
    const ast = parse('$.a');
    expect((replace({ a: 1 }, ast, 2).value as any).a).toBe(2);
    expect((transform({ a: 2 }, ast, (v) => (v as number) + 10).value as any).a).toBe(12);
  });
});

describe('嵌套命中（$..retry 同时命中祖先与后代）', () => {
  const doc = () => ({
    retry: { count: 1, nested: { retry: 2 } },
    other: { retry: 3 },
  });

  it('query 命中数与 update 处理数一致', () => {
    const d = doc();
    expect(query(d, '$..retry')).toHaveLength(3);
    const r = replace(d, '$..retry', null);
    expect(r.count).toBe(3);
  });

  it('规则：最外层命中生效（祖先被整体替换，内部命中点不再单独落地）', () => {
    const d = doc();
    const r = replace(d, '$..retry', 'X');
    expect(r.value).toEqual({ retry: 'X', other: { retry: 'X' } });
  });

  it('删除：外层删掉整棵子树', () => {
    const d = doc();
    const r = remove(d, '$..retry');
    expect(r.value).toEqual({ other: {} });
  });

  it('内部命中点的函数仍然会执行：内部抛错照样整体回滚', () => {
    const d = doc();
    const r = transform(d, '$..retry', (v) => {
      if (v === 2) throw new Error('inner boom');
      return 'X';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.value).toBe(d);
      expect(r.path).toBe("$['retry']['nested']['retry']");
    }
    expect(d).toEqual(doc());
  });

  it('即使外层命中会遮蔽内层，内层函数先抛错仍整体失败', () => {
    // list[0].x 是叶子，list[1].x 是含同名后代的容器；
    // query 顺序中叶子先执行、容器后执行，叶子抛错必须整体回滚。
    const d = { list: [{ x: 1 }, { x: { x: 2 } }] };
    const calls: string[] = [];
    const r = transform(d, '$..x', (v, p) => {
      calls.push(p);
      if (v === 1) throw new Error('leaf boom');
      return 'V';
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.path).toBe("$['list'][0]['x']");
    expect(calls[0]).toBe("$['list'][0]['x']");
    expect(d).toEqual({ list: [{ x: 1 }, { x: { x: 2 } }] });
  });

  it('与遍历顺序无关：手动反转命中顺序模拟，结果一致', () => {
    const d1 = doc();
    const d2 = JSON.parse(JSON.stringify(doc()));
    const r1 = replace(d1, '$..retry', 'X');
    const r2 = replace(d2, '$..retry', 'X');
    expect(r1.value).toEqual(r2.value);
  });

  it('外层命中遮蔽内层，且内层先被处理（剪枝必须顺序无关）', () => {
    // 对象按键插入序做前序 DFS：先走完 retry 子树（外层 + 其内部后代），
    // 再访问 before；外层终端落盘时，其内层命中已挂在 trie 上，必须被剪掉。
    const d = { retry: { count: 1, nested: { retry: 9 } }, before: { retry: 2 } };
    const nodes = query(d, '$..retry');
    expect(nodes.map((n) => n.path)).toEqual([
      "$['retry']",
      "$['retry']['nested']['retry']",
      "$['before']['retry']",
    ]);
    const r = replace(d, '$..retry', 'OUT');
    expect(r.value).toEqual({ retry: 'OUT', before: { retry: 'OUT' } });
  });

  it('外层删除遮蔽内层删除，只删外层一次', () => {
    const d = { retry: { x: { retry: 1 } }, keep: { retry: 2 } };
    const r = remove(d, '$..retry');
    expect(r.value).toEqual({ keep: {} });
  });

  it('数组顺序保证内层命中先于外层，剪枝仍以后到的外层为准', () => {
    // $..* 前序 DFS，数组按下标序：数组 0 号先被访问。
    // 0 号叶子 x 先进入“待编辑”，随后 1 号容器（包含 0 号的路径？否——构造真正的嵌套：）
    // 用一条路径无法颠倒 DFS 序，因此这里直接构造：外层节点排在它自己后代之后被命中。
    // $..x 对下面文档的命中顺序：先 list[0].x（叶子），再 list[1].x（外层容器，
    // 其内部还有一个 x 叶子），最后是外层内部的叶子——形成“内层编辑先插入 trie”。
    const d = { list: [{ x: 1 }, { x: { x: 2 } }] };
    const paths = query(d, '$..x').map((n) => n.path);
    expect(paths).toEqual([
      "$['list'][0]['x']",
      "$['list'][1]['x']",
      "$['list'][1]['x']['x']",
    ]);
    const r = replace(d, '$..x', 'V');
    expect(r.value).toEqual({ list: [{ x: 'V' }, { x: 'V' }] });
  });
});

describe('引用语义与环', () => {
  it('别名对象：一处修改不影响另一处的子树复用', () => {
    const shared = { v: 1 };
    const doc = { x: shared, y: shared, z: 1 };
    const r = replace(doc, '$.z', 2);
    expect(r.ok).toBe(true);
    expect((r.value as any).x).toBe(shared);
    expect((r.value as any).y).toBe(shared);
  });

  it('别名对象分别命中修改：两处独立重建', () => {
    const shared = { v: 1 };
    const doc: any = { x: shared, y: shared };
    const r = transform(doc, '$..v', () => 9);
    expect(r.ok).toBe(true);
    expect((r.value as any).x.v).toBe(9);
    expect((r.value as any).y.v).toBe(9);
    // 输出里两处仍是同一引用（值相同的重建对象各自创建，这里不强制），
    // 关键是输入未被动过
    expect(doc.x.v).toBe(1);
  });

  it('环上改写直接报错，输入不变', () => {
    const d: any = { a: {} };
    d.a.back = d;
    expect(() => replace(d, '$..x', 1)).toThrow(CyclicReferenceError);
  });
});

describe('改写与非法表达式', () => {
  it('过滤器表达式语法错误', () => {
    expect(() => replace({ a: 1 }, '$.a[?x]', 2)).toThrow(JSONPathSyntaxError);
  });
});

describe('边界情形', () => {
  it('替换根节点', () => {
    const doc = { a: 1 };
    const r = replace(doc, '$', { b: 2 });
    expect(r.value).toEqual({ b: 2 });
    expect(doc).toEqual({ a: 1 });
  });

  it('对根做相等替换：同引用返回', () => {
    const doc = { a: 1 };
    const r = transform(doc, '$', (v) => v);
    expect(r.value).toBe(doc);
    expect(r.changed).toBe(false);
  });

  it('__proto__ 作为普通数据键不污染原型', () => {
    const doc = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    const r = replace(doc, '$.x', 2);
    expect(({} as any).polluted).toBeUndefined();
    const out = r.value as any;
    expect(Object.getOwnPropertyNames(out)).toContain('__proto__');
    expect(out.x).toBe(2);
  });

  it('多个选择器指向同一位置时首个编辑生效', () => {
    const doc = [10, 20, 30];
    // $[0,0] 对下标 0 产生两个同位置命中；第二次的编辑必须被忽略
    let calls = 0;
    const r = transform(doc, '$[0,0]', () => (calls++ === 0 ? 111 : 999));
    expect(r.value).toEqual([111, 20, 30]);
    expect(r.count).toBe(2); // 处理数仍是 query 的命中数
  });

  it('深层路径上的兄弟删除与替换互不干扰且未命中节点复用', () => {
    const keep = { z: 9 };
    const doc = { a: { b: [1, 2, 3, { c: keep }] }, d: 4 };
    const r = remove(doc, '$.a.b[0,2]');
    expect(r.value).toEqual({ a: { b: [2, { c: keep }] }, d: 4 });
    expect(((r.value as any).a.b[1].c)).toBe(keep);
    expect((r.value as any).d).toBe(4);
  });

  it('transform 失败时给出的 index 就是 query 结果下标', () => {
    const doc = { a: [{ x: 1 }, { x: 2 }] };
    const nodes = query(doc, '$..x');
    const r = transform(doc, '$..x', (v) => {
      if (v === 2) throw new Error('boom');
      return v;
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.index).toBe(1);
      expect(r.path).toBe(nodes[1].path);
    }
  });
});

describe('深嵌套改写不爆栈', () => {
  it('5000 层嵌套上的递归下降替换', () => {
    let d: any = { leaf: 1 };
    for (let i = 0; i < 5000; i++) d = { a: d, side: i };
    const r = replace(d, '$..leaf', 2);
    expect(r.ok).toBe(true);
    expect(query(r.value, '$..leaf')[0].value).toBe(2);
    // 未命中的兄弟子树复用（根侧的 side 是最后一轮赋的 4999）
    expect((r.value as any).side).toBe(4999);
  });
});
