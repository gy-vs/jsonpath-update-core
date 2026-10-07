/**
 * 性能基准（不作为普通正确性测试的重点，用 .perf.test.ts 命名方便单独跑）。
 *
 * 场景按运维实际配置建模：
 *  1. 宽树：约十万节点，递归下降查询 + transform 更新，要求 1 秒量级。
 *  2. 深树：数千层单链，递归下降查询 + 删除，验证不靠递归、不爆栈。
 */
import { describe, expect, it } from 'vitest';
import { query, remove, replace, transform } from '../src/index.js';

function countNodes(v: unknown): number {
  let n = 0;
  const stack: unknown[] = [v];
  while (stack.length) {
    const cur = stack.pop();
    n++;
    if (Array.isArray(cur)) stack.push(...cur);
    else if (cur && typeof cur === 'object') for (const k of Object.keys(cur)) stack.push((cur as any)[k]);
  }
  return n;
}

describe('性能：十万节点宽树', () => {
  // 500 个服务 × 每个 10 个实例 × 每实例约 20 个字段 ≈ 10w+ 节点
  const services = 500;
  const instances = 10;
  const fields = 20;

  function build() {
    const doc: any = { services: [] as any[] };
    for (let s = 0; s < services; s++) {
      const svc: any = { name: `svc-${s}`, instances: [] as any[] };
      for (let i = 0; i < instances; i++) {
        const inst: any = { id: `${s}-${i}`, retry: { count: 3, backoff: '1s' } };
        for (let f = 0; f < fields; f++) inst[`field_${f}`] = f;
        svc.instances.push(inst);
      }
      doc.services.push(svc);
    }
    return doc;
  }

  it('节点规模符合预期', () => {
    const n = countNodes(build());
    expect(n).toBeGreaterThan(100_000);
  });

  it('$..count 递归下降查询在 1 秒内完成', () => {
    const doc = build();
    const t0 = performance.now();
    const r = query(doc, '$..count');
    const ms = performance.now() - t0;
    expect(r.length).toBe(services * instances);
    expect(r[0].value).toBe(3);
    console.log(`宽树递归下降查询：${ms.toFixed(0)} ms，命中 ${r.length}`);
    expect(ms).toBeLessThan(1000);
  });

  it('查询 + transform 一次更新在 1 秒左右完成', () => {
    const doc = build();
    const t0 = performance.now();
    const q = query(doc, '$..backoff');
    const r = transform(doc, '$..backoff', (v) => v + '!');
    const ms = performance.now() - t0;
    expect(q.length).toBe(services * instances);
    expect(r.ok).toBe(true);
    expect((r.value as any).services[0].instances[0].retry.backoff).toBe('1s!');
    // 输入未动
    expect(doc.services[0].instances[0].retry.backoff).toBe('1s');
    console.log(`宽树查询+更新：${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1500);
  });

  it('全树通配 + replace 后未命中子树仍复用（结构共享规模检查）', () => {
    const doc = build();
    const shared = doc.services[100].instances[5];
    const r = replace(doc, '$.services[0].name', 'renamed');
    expect((r.value as any).services[100].instances[5]).toBe(shared);
  });
});

describe('性能：数千层深树', () => {
  const depth = 4000;

  function build() {
    let d: any = { tail: 1 };
    for (let i = 0; i < depth; i++) d = { child: d, n: i };
    return d;
  }

  it('$..tail 查询不爆栈且够快', () => {
    const doc = build();
    const t0 = performance.now();
    const r = query(doc, '$..tail');
    const ms = performance.now() - t0;
    expect(r.length).toBe(1);
    expect(r[0].value).toBe(1);
    console.log(`深树(${depth}层)查询：${ms.toFixed(0)} ms，路径长度 ${r[0].path.length}`);
    expect(ms).toBeLessThan(500);
  });

  it('深树上的删除与替换不爆栈', () => {
    const doc = build();
    const t0 = performance.now();
    const r = remove(doc, '$..tail');
    expect(r.ok).toBe(true);
    const r2 = replace(doc, '$..tail', 99);
    expect(r2.ok).toBe(true);
    expect(query(r2.value, '$..tail')[0].value).toBe(99);
    const ms = performance.now() - t0;
    console.log(`深树(${depth}层)删除+替换+查询：${ms.toFixed(0)} ms`);
    expect(ms).toBeLessThan(1000);
  });
});

describe('step=0 不卡死（旧脚本的死循环场景）', () => {
  it('十万级数组上的 [::0] 立即返回空', () => {
    const big = new Array(100_000).fill(0).map((_, i) => i);
    const t0 = performance.now();
    const r = query(big, '$[::0]');
    expect(r).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});
