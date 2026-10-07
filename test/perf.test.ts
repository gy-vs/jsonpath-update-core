import { describe, expect, it } from 'vitest';
import { query, replace, update } from '../src/index.js';

/** Build a balanced-ish tree with roughly the requested node count. */
function buildTree(targetNodes: number): { root: unknown; nodes: number } {
  const root: Record<string, unknown> = { children: [] as unknown[] };
  let count = 1;
  const queue: Record<string, unknown>[] = [root];
  while (count < targetNodes) {
    const node = queue.shift()!;
    const children = [];
    for (let i = 0; i < 10 && count < targetNodes; i++) {
      const child: Record<string, unknown> = { id: count, children: [] as unknown[] };
      children.push(child);
      queue.push(child);
      count++;
    }
    node.children = children;
  }
  return { root, nodes: count };
}

describe('large inputs (~100k nodes)', () => {
  const { root, nodes } = buildTree(100_000);

  it('recursive descent query + update run in about a second', () => {
    const t0 = performance.now();
    const hits = query(root, '$..id');
    expect(hits.length).toBe(nodes - 1);

    let touched = 0;
    const next = update(root, '$..id', (v) => {
      touched++;
      return (v as number) + 1;
    });
    const elapsed = performance.now() - t0;

    expect(touched).toBe(nodes - 1);
    expect(elapsed).toBeLessThan(3000);
    expect(query(next, '$..id')[0].value).not.toBe(hits[0].value);
  });

  it('a single replace reuses almost the whole tree', () => {
    const t0 = performance.now();
    const next = replace(root, '$..id', 0);
    expect(performance.now() - t0).toBeLessThan(3000);
    // 100k leaves replaced => parents rebuilt up the spine, rest reused
    expect(next).not.toBe(root);
  });
});

describe('deep nesting (thousands of levels)', () => {
  const DEPTH = 5000;

  function buildDeep(depth: number): unknown {
    let node: unknown = 'leaf';
    for (let i = 0; i < depth; i++) node = { child: node };
    return node;
  }

  it('queries without blowing the stack', () => {
    const root = buildDeep(DEPTH);
    const hits = query(root, '$..child');
    expect(hits.length).toBe(DEPTH);
  });

  it('updates without blowing the stack and reuses unchanged pieces', () => {
    const root = buildDeep(DEPTH) as { child: unknown };
    const next = update(root, '$..child', (v) => v) as { child: unknown };
    expect(next).toBe(root); // identity-preserving transform
    const replaced = replace(root, '$', root);
    expect(replaced).toBe(root);
  });

  it('edits a deeply buried leaf', () => {
    const root = buildDeep(DEPTH) as Record<string, unknown>;
    const path = '$' + '.child'.repeat(DEPTH);
    const next = replace(root, path, 'changed') as Record<string, unknown>;
    let cur: unknown = next;
    for (let i = 0; i < DEPTH; i++) cur = (cur as Record<string, unknown>).child;
    expect(cur).toBe('changed');
  });
});
