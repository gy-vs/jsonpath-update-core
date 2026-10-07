/**
 * 改写引擎：replace / remove / transform 共用同一套核心。
 *
 * 原子性保证（两阶段）：
 *   阶段 1：用 query 拿到全部命中点，对每个命中点（按结果顺序）计算新值。
 *           用户函数在这一阶段全部执行；任何一个抛错，立即返回 failure，
 *           此时尚未写入任何东西，输入对象与调用前逐字节相同（同引用）。
 *   阶段 2：沿“编辑树”惰性重建新根。只有通往被改节点的路径上的容器会被浅拷贝，
 *           未命中的子树原样复用（===），因此调用方可以直接用 === 判断变化范围。
 *
 * 与 query 的一一对应：阶段 1 处理的命中点数量恒等于 query 结果数，不多不少；
 * 每个命中点都会调用函数（含嵌套命中，保证任何一点抛错都能整体回滚）。
 *
 * 嵌套命中（如 $..retry 同时命中祖先和后代）的确定性规则：
 *   “最外层命中生效”。重建到一个带编辑的节点即整体替换/删除该子树，
 *   其内部命中点的编辑不再单独落地；但内部命中点的函数在阶段 1 仍会执行，
 *   因而内部函数抛错依旧导致整次调用失败。该规则与遍历顺序无关、可复现。
 *
 * 同一数组多个下标（含负下标、含重复）的删除以“原数组位置”为准，
 * 不受删除过程中下标移动的影响；重复命中删除同一个位置只生效一次。
 */

import { query } from './query.js';
import { parse as parsePath } from './parser.js';
import type {
  JSONPathQuery,
  PathNode,
  UpdateOp,
  UpdateResult,
} from './types.js';

const DELETE = Symbol('jsonpath.delete');

type PreparedEdit =
  | { type: 'value'; value: unknown }
  | { type: 'delete' };

interface TrieNode {
  children: Map<string, TrieNode>;
  edit?: PreparedEdit;
}

function newTrieNode(): TrieNode {
  return { children: new Map() };
}

function edgeKey(key: string | number): string {
  return typeof key === 'number' ? `i:${key}` : `s:${key}`;
}

/** 用户变换函数签名：拿到原值与规范路径，返回新值 */
export type ValueTransformer = (value: unknown, path: string) => unknown;

interface CoreOptions {
  op: UpdateOp;
  /** 每个命中点产出一条编辑；抛错由核心统一转成 failure */
  prepare: (node: PathNode, index: number) => PreparedEdit;
}

function updateCore(
  root: unknown,
  path: string | JSONPathQuery,
  options: CoreOptions,
): UpdateResult {
  const ast = typeof path === 'string' ? parsePath(path) : path;
  const matches = query(root, ast);

  // ---- 阶段 1：对所有命中点计算编辑（不触碰输入） ----
  // 原值直接缓存在命中点上，后续判定“值是否真的变化”无需再沿路径查找。
  const prepared: {
    keys: (string | number)[];
    edit: PreparedEdit;
    oldValue: unknown;
  }[] = [];
  for (let index = 0; index < matches.length; index++) {
    const node = matches[index];
    let edit: PreparedEdit;
    try {
      edit = options.prepare(node, index);
    } catch (error) {
      return {
        ok: false,
        value: root,
        changed: false,
        index,
        path: node.path,
        op: options.op,
        error,
      };
    }
    prepared.push({ keys: node.keys, edit, oldValue: node.value });
  }

  // ---- 组装编辑树（最外层命中生效，与插入顺序无关） ----
  // 同一位置出现多次（如 $[0,0]）时，按 query 结果顺序第一次出现的编辑生效。
  const rootTrie = newTrieNode();
  let hasEffectiveEdit = false;

  for (const { keys, edit, oldValue } of prepared) {
    let node = rootTrie;
    let shadowed = false;
    for (const key of keys) {
      if (node.edit !== undefined) {
        // 祖先已有编辑：此内层命中被遮蔽
        shadowed = true;
        break;
      }
      const ek = edgeKey(key);
      let child = node.children.get(ek);
      if (child === undefined) {
        child = newTrieNode();
        node.children.set(ek, child);
      }
      node = child;
    }
    if (shadowed) continue;
    if (node.edit !== undefined) continue; // 同一位置重复命中：首个编辑生效
    // 先记录终端编辑；其下可能已挂着更早插入的内层命中，统一在下方剪枝。
    node.edit = edit;
    if (edit.type === 'delete' || !Object.is(edit.value, oldValue)) {
      hasEffectiveEdit = true;
    }
  }

  // 剪枝：任何终端节点下方的编辑都失效（最外层命中生效）。
  // 建树时不剪是因为内层命中可能比外层命中更早插入（递归下降结果顺序使然）。
  pruneTerminals(rootTrie);

  if (!hasEffectiveEdit) {
    return { ok: true, changed: false, count: matches.length, value: root };
  }

  // ---- 阶段 2：惰性重建 ----
  const value = rebuild(root, rootTrie);
  return {
    ok: true,
    changed: !Object.is(value, root),
    count: matches.length,
    value,
  };
}

/** 深度优先（显式栈）剪掉所有终端节点的后代。 */
function pruneTerminals(root: TrieNode): void {
  const stack: TrieNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as TrieNode;
    if (node.edit !== undefined) {
      node.children.clear();
      continue;
    }
    for (const child of node.children.values()) stack.push(child);
  }
}

/**
 * 迭代式重建，不递归调用自身（深嵌套安全）。
 *
 * 每个活动帧表示一个“需要检查孩子是否变化”的容器。
 * 孩子完成时回报一条变化；没有任何变化的容器直接复用原引用。
 */
interface BuildFrame {
  orig: object;
  trie: TrieNode;
  parent: BuildFrame | null;
  key: string | number | null;
  /** 有效变化记录：被删除记 DELETE，其余记新值 */
  changes: Map<string, unknown>;
}

type Task =
  | { type: 'enter'; orig: unknown; trie: TrieNode; key: string | number | null; parent: BuildFrame | null }
  | { type: 'exit'; frame: BuildFrame };

function rebuild(root: unknown, rootTrie: TrieNode): unknown {
  // 根节点自身被命中（keys 为空）
  if (rootTrie.edit !== undefined) {
    if (rootTrie.edit.type === 'delete') return null;
    return rootTrie.edit.value;
  }
  if (rootTrie.children.size === 0) return root;

  const stack: Task[] = [
    { type: 'enter', orig: root, trie: rootTrie, key: null, parent: null },
  ];

  while (stack.length > 0) {
    const task = stack.pop() as Task;

    if (task.type === 'enter') {
      const { orig, trie, key, parent } = task;

      if (orig !== null && typeof orig === 'object') {
        const frame: BuildFrame = { orig, trie, parent, key, changes: new Map() };
        stack.push({ type: 'exit', frame });

        if (Array.isArray(orig)) {
          for (let i = orig.length - 1; i >= 0; i--) {
            const childTrie = trie.children.get(edgeKey(i));
            if (childTrie === undefined) continue; // 未命中：退出时自动复用 orig[i]
            pushChild(stack, orig[i], childTrie, i, frame);
          }
        } else {
          const keys = Object.keys(orig as Record<string, unknown>);
          for (let k = keys.length - 1; k >= 0; k--) {
            const name = keys[k];
            const childTrie = trie.children.get(edgeKey(name));
            if (childTrie === undefined) continue;
            pushChild(
              stack,
              (orig as Record<string, unknown>)[name],
              childTrie,
              name,
              frame,
            );
          }
        }
      } else {
        // 原始值是基本类型却仍走到这里：终端编辑已在 pushChild 处理，
        // 能进入 enter 的只剩“相等替换”这种无效编辑——无变化，忽略即可。
      }
      continue;
    }

    // exit：本容器的所有孩子都已处理
    const { frame } = task;
    if (frame.changes.size === 0) {
      // 无任何有效变化：整棵子树原样复用，不向父级回报
      continue;
    }

    const built = Array.isArray(frame.orig)
      ? buildArray(frame)
      : buildObject(frame);

    if (frame.parent === null) {
      return built;
    }
    frame.parent.changes.set(edgeKey(frame.key as string | number), built);
  }

  // 理论上不可达：hasEffectiveEdit 为 true 时必然有 exit 产生新根
  return root;
}

function pushChild(
  stack: Task[],
  origChild: unknown,
  childTrie: TrieNode,
  key: string | number,
  parent: BuildFrame,
): void {
  if (childTrie.edit !== undefined) {
    const edit = childTrie.edit;
    if (edit.type === 'delete') {
      parent.changes.set(edgeKey(key), DELETE);
    } else if (!Object.is(edit.value, origChild)) {
      // 值真的变了才回报；相等的替换保持 === 不变
      parent.changes.set(edgeKey(key), edit.value);
    }
    return;
  }
  if (origChild !== null && typeof origChild === 'object') {
    stack.push({ type: 'enter', orig: origChild, trie: childTrie, key, parent });
  }
  // 基本类型且无终端编辑：无变化，忽略
}

function buildArray(frame: BuildFrame): unknown[] {
  const orig = frame.orig as unknown[];
  const out: unknown[] = [];
  for (let i = 0; i < orig.length; i++) {
    const ek = edgeKey(i);
    if (!frame.changes.has(ek)) {
      out.push(orig[i]); // 未命中元素：原样复用
    } else {
      const v = frame.changes.get(ek);
      if (v !== DELETE) out.push(v);
      // 删除：跳过
    }
  }
  return out;
}

function buildObject(frame: BuildFrame): Record<string, unknown> {
  const orig = frame.orig as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(orig)) {
    const ek = edgeKey(name);
    const value: unknown = frame.changes.has(ek) ? frame.changes.get(ek) : orig[name];
    if (value === DELETE) continue;
    // "__proto__" 作为普通赋值会走到 setter、污染原型；按数据属性写入。
    if (name === '__proto__') {
      Object.defineProperty(out, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } else {
      out[name] = value;
    }
  }
  return out;
}

// ---------- 对外三个操作 ----------

/**
 * 常量替换：把每个命中节点替换为 value。
 * value 会被直接放入结果树（若同一 value 随多个命中点放入，则这些位置共享引用）。
 */
export function replace(
  root: unknown,
  path: string | JSONPathQuery,
  value: unknown,
): UpdateResult {
  return updateCore(root, path, { op: 'replace', prepare: () => ({ type: 'value', value }) });
}

/**
 * 函数变换：对每个命中节点调用 fn(原值, 规范路径)，用返回值替换。
 * fn 在任何一个命中点抛错，整次调用失败，输入原样返回。
 */
export function transform(
  root: unknown,
  path: string | JSONPathQuery,
  fn: ValueTransformer,
): UpdateResult {
  return updateCore(root, path, {
    op: 'transform',
    prepare: (node) => ({ type: 'value', value: fn(node.value, node.path) }),
  });
}

/**
 * 删除：数组按下标移除元素、对象删除成员。
 * 删除根节点返回 null。同一位置重复命中只删一次；
 * [0,2,-1] 这类多点删除以原数组位置为准，不受下标移动影响。
 */
export function remove(
  root: unknown,
  path: string | JSONPathQuery,
): UpdateResult {
  return updateCore(root, path, { op: 'delete', prepare: () => ({ type: 'delete' }) });
}
