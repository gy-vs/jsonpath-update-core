/**
 * 官方一致性测试套件（CTS）运行器。
 * 数据来自 https://github.com/jsonpath-standard/jsonpath-compliance-test-suite
 *
 * 本库不实现过滤器，因此 selector 含 "?" 的用例一律跳过；
 * invalid_selector 用例要求必须抛 JSONPathSyntaxError；
 * 非确定序（results/results_paths 给出多个可接受答案）时，对象按插入序遍历，
 * 我们的确定结果（值 + 规范路径）必须同时落在同一组答案内。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { JSONPathSyntaxError, query, type PathNode } from '../../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));

interface CtsCase {
  name: string;
  selector: string;
  document: unknown;
  result?: unknown[];
  results?: unknown[][];
  result_paths?: string[];
  results_paths?: string[][];
  invalid_selector?: boolean;
}

const files = [
  ['basic.json', 'basic.json'],
  ['name_selector.json', 'name.json'],
  ['index_selector.json', 'index.json'],
  ['slice_selector.json', 'slice.json'],
  ['whitespace/selectors.json', 'ws.json'],
] as const;

function loadCases(file: string): CtsCase[] {
  // 测试文件本身就在 test/cts/ 目录内，数据文件与其同级
  const raw = readFileSync(join(here, file), 'utf8');
  return (JSON.parse(raw) as { tests: CtsCase[] }).tests;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

for (const [title, file] of files) {
  describe(`CTS: ${title}`, () => {
    const cases = loadCases(file);
    for (const c of cases) {
      // 过滤器选择器形如 [? ...（? 紧跟 [ 与可选空白）；字符串里的 \? 不算
      const isFilter = /\[\s*\?/.test(c.selector);
      if (isFilter) continue; // 过滤器不在本库范围

      it(`${c.name}  ${c.selector}`, () => {
        if (c.invalid_selector) {
          expect(() => query(c.document, c.selector)).toThrow(JSONPathSyntaxError);
          return;
        }

        let nodes: PathNode[];
        try {
          nodes = query(c.document, c.selector);
        } catch (e) {
          throw new Error(`合法表达式却抛错: ${(e as Error).message}`);
        }
        const values = nodes.map((n) => n.value);
        const paths = nodes.map((n) => n.path);

        if (c.results !== undefined) {
          const idx = c.results.findIndex((answer) => same(answer, values));
          expect(idx, `值序列 ${JSON.stringify(values)} 不在可接受答案中`).toBeGreaterThanOrEqual(0);
          if (c.results_paths) {
            expect(paths).toEqual(c.results_paths[idx]);
          }
        } else {
          if (c.result !== undefined) {
            expect(same(values, c.result)).toBe(true);
          }
          if (c.result_paths) {
            expect(paths).toEqual(c.result_paths);
          }
        }
      });
    }
  });
}
