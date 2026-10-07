/**
 * 查询求值器（RFC 9535 第 2.3–2.5 节语义）。
 *
 * 实现要点：
 *  - 全程显式栈迭代，不使用递归，几千层嵌套不会打爆调用栈。
 *  - 递归下降按“节点先于后代、数组按下标顺序”的前序 DFS 访问；
 *    对象按自身属性顺序（JSON 文本顺序）访问，结果确定可复现。
 *  - 并集按选择器出现顺序拼接，同一节点被多个选择器命中时保留重复。
 *  - 别名引用（同一对象被两处引用）两处都会命中；真正绕回祖先的环报错。
 */

import { CyclicReferenceError } from './errors.js';
import { parse as parsePath } from './parser.js';
import { buildNormalizedPath } from './path.js';
import type {
  JSONPathQuery,
  PathNode,
  Selector,
} from './types.js';

/** 遍历帧：沿 parent 链可还原出节点在文档中的完整位置 */
interface Frame {
  value: unknown;
  parent: Frame | null;
  key: string | number | null;
  /** 惰性缓存的规范路径与路径分段 */
  path: string | null;
  keys: (string | number)[] | null;
}

function makeFrame(value: unknown, parent: Frame | null, key: string | number | null): Frame {
  return { value, parent, key, path: null, keys: null };
}

/** 沿父链一次性收集路径分段（非负下标 / 对象键），并缓存路径与分段。 */
function materialize(frame: Frame): { path: string; keys: (string | number)[] } {
  if (frame.path !== null && frame.keys !== null) {
    return { path: frame.path, keys: frame.keys };
  }
  const keys: (string | number)[] = [];
  // 找到已经物化过的最近祖先即可复用其前缀
  let stop: Frame | null = null;
  for (let f: Frame | null = frame; f !== null && f.parent !== null; f = f.parent) {
    keys.push(f.key as string | number);
    if (f.parent.keys !== null) {
      stop = f.parent;
      break;
    }
  }
  keys.reverse();
  const prefix = stop?.keys ?? [];
  const fullKeys = prefix.concat(keys);
  const path = buildNormalizedPath(fullKeys);
  frame.path = path;
  frame.keys = fullKeys;
  return { path, keys: fullKeys };
}

function isContainer(v: unknown): v is Record<string, unknown> | unknown[] {
  return v !== null && typeof v === 'object';
}

/**
 * 对一个容器节点施加子段的全部选择器。
 * 选择器之间不去重（RFC 2.5.1.2：被多个选择器命中的节点保留多次）。
 */
function applySelectors(selectors: Selector[], node: unknown, parent: Frame, out: Frame[]): void {
  for (const sel of selectors) {
    switch (sel.kind) {
      case 'name': {
        // 名称选择器只作用于对象（RFC 2.3.1.2）
        if (node !== null && typeof node === 'object' && !Array.isArray(node)) {
          if (Object.prototype.hasOwnProperty.call(node, sel.name)) {
            out.push(makeFrame((node as Record<string, unknown>)[sel.name], parent, sel.name));
          }
        }
        break;
      }
      case 'wildcard': {
        if (Array.isArray(node)) {
          for (let i = 0; i < node.length; i++) {
            out.push(makeFrame(node[i], parent, i));
          }
        } else if (node !== null && typeof node === 'object') {
          for (const key of Object.keys(node as Record<string, unknown>)) {
            out.push(makeFrame((node as Record<string, unknown>)[key], parent, key));
          }
        }
        break;
      }
      case 'index': {
        if (Array.isArray(node)) {
          const i = sel.index < 0 ? node.length + sel.index : sel.index;
          if (i >= 0 && i < node.length) {
            out.push(makeFrame(node[i], parent, i));
          }
        }
        break;
      }
      case 'slice': {
        if (Array.isArray(node)) {
          selectSlice(node, sel.start, sel.end, sel.step, parent, out);
        }
        break;
      }
    }
  }
}

/**
 * RFC 9535 2.3.4.2.2 的切片算法。
 * 注意 start/end 归一化时不做 clamp，clamp 只发生在 Bounds()；
 * step === 0 时选空（不抛错、不循环）。
 */
function selectSlice(
  arr: unknown[],
  start: number | null,
  end: number | null,
  step: number | null,
  parent: Frame,
  out: Frame[],
): void {
  const len = arr.length;
  const s = step ?? 1;
  if (s === 0) return;

  const norm = (i: number): number => (i >= 0 ? i : len + i);

  if (s > 0) {
    const nStart = start === null ? 0 : norm(start);
    const nEnd = end === null ? len : norm(end);
    const lower = Math.min(Math.max(nStart, 0), len);
    const upper = Math.min(Math.max(nEnd, 0), len);
    for (let i = lower; i < upper; i += s) {
      out.push(makeFrame(arr[i], parent, i));
    }
  } else {
    const nStart = start === null ? len - 1 : norm(start);
    const nEnd = end === null ? -len - 1 : norm(end);
    const upper = Math.min(Math.max(nStart, -1), len - 1);
    const lower = Math.min(Math.max(nEnd, -1), len - 1);
    for (let i = upper; lower < i; i += s) {
      out.push(makeFrame(arr[i], parent, i));
    }
  }
}

/** 迭代式 DFS 任务 */
type WalkTask =
  | { type: 'enter'; frame: Frame }
  | { type: 'exit'; value: object };

/**
 * 递归下降：访问输入节点自身及其全部后代（前序），
 * 对每个访问到的节点施加一次选择器集合，结果按访问顺序拼接（RFC 2.5.2.2）。
 *
 * ancestors 记录当前 DFS 根链上的容器：进入压入、退出弹出。
 * 别名（菱形引用）不是环，可以正常命中两次；绕回祖先才报 CyclicReferenceError。
 */
function descendantWalk(
  rootFrame: Frame,
  selectors: Selector[],
  out: Frame[],
): void {
  const stack: WalkTask[] = [{ type: 'enter', frame: rootFrame }];
  const ancestors = new Set<object>();

  while (stack.length > 0) {
    const task = stack.pop() as WalkTask;

    if (task.type === 'exit') {
      ancestors.delete(task.value);
      continue;
    }

    const { frame } = task;
    const node = frame.value;

    // R_i：对此节点施加一次子段
    applySelectors(selectors, node, frame, out);

    if (!isContainer(node)) continue;

    if (ancestors.has(node as object)) {
      throw new CyclicReferenceError(materialize(frame).path);
    }
    ancestors.add(node as object);
    stack.push({ type: 'exit', value: node as object });

    if (Array.isArray(node)) {
      // 逆序压栈，保证弹出时下标 0 先访问
      for (let i = node.length - 1; i >= 0; i--) {
        stack.push({ type: 'enter', frame: makeFrame(node[i], frame, i) });
      }
    } else {
      const keys = Object.keys(node as Record<string, unknown>);
      for (let k = keys.length - 1; k >= 0; k--) {
        const key = keys[k];
        stack.push({
          type: 'enter',
          frame: makeFrame((node as Record<string, unknown>)[key], frame, key),
        });
      }
    }
  }
}

function queryAst(root: unknown, ast: JSONPathQuery): Frame[] {
  let current: Frame[] = [makeFrame(root, null, null)];
  for (const segment of ast.segments) {
    const next: Frame[] = [];
    if (segment.kind === 'child') {
      for (const frame of current) {
        applySelectors(segment.selectors, frame.value, frame, next);
      }
    } else {
      for (const frame of current) {
        descendantWalk(frame, segment.selectors, next);
      }
    }
    current = next;
  }
  return current;
}

/**
 * 执行 JSONPath 查询。
 *
 * @param root 任意 JSON 值（对象 / 数组 / 基本类型）
 * @param path 表达式字符串，或 parse() 得到的 AST
 * @returns 命中节点列表，顺序确定、多次运行一致；每项带规范路径
 */
export function query(root: unknown, path: string | JSONPathQuery): PathNode[] {
  const ast = typeof path === 'string' ? parsePath(path) : path;
  const frames = queryAst(root, ast);
  return frames.map((frame) => {
    const { path: np, keys } = materialize(frame);
    return { value: frame.value, path: np, keys };
  });
}

