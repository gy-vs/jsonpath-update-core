import { JsonPath, JsonPathTransformError } from './ast.js';
import { parsePath } from './parser.js';
import { Frame, queryFrames } from './evaluate.js';

/** A user-supplied rewrite. Returning a value replaces the node. */
export type Transform = (value: unknown, path: string) => unknown;

type Step = number | string;

interface OpNode {
  /** Lazily allocated; most trie nodes are leaves. */
  children: Map<Step, OpNode> | null;
  /** Transform applied to the node after matched descendants have run. */
  fn: Transform | null;
  /** Constant replacement, overrides every operation below this node. */
  replace: unknown;
  hasReplace: boolean;
  remove: boolean;
  /** Normalized path of the matched node (root is "$"). */
  path: string;
}

function newOpNode(path = '$'): OpNode {
  return {
    children: null,
    fn: null,
    replace: undefined,
    hasReplace: false,
    remove: false,
    path,
  };
}

type OperationKind = 'replace' | 'remove' | 'transform';

/**
 * Index the matched frames by their root-to-node step chain in a single
 * linear pass.
 *
 * Frames arrive in pre-order document order, so consecutive frames share a
 * prefix: each frame is walked up only until an ancestor mapped by a previous
 * frame is reached. Those upward steps amortize to O(n) over the nodelist,
 * which keeps an update over a structure nested thousands of levels deep
 * linear rather than quadratic. Normalized paths are composed incrementally
 * on trie nodes (O(1) per node) instead of rebuilt per result.
 *
 * Several query hits can land on the same node (a union whose selectors
 * overlap, or a wildcard combined with a name inside one bracket): they
 * collapse to a single trie node. A constant replace/remove wins over a
 * transform; repeated transforms compose in query result order.
 */
function buildTrie(frames: Frame[], kind: OperationKind, valueOrFn: unknown): OpNode {
  const trie = newOpNode();
  const nodeOf = new Map<Frame, OpNode>();
  // A query that matches the root itself is represented by the trie root.
  if (frames.length > 0) {
    let rootFrame: Frame = frames[0];
    while (rootFrame.parent !== null) rootFrame = rootFrame.parent;
    nodeOf.set(rootFrame, trie);
  }

  for (const frame of frames) {
    // Gather frames not yet indexed, innermost first, until a mapped ancestor
    // (the shared prefix) or the root.
    const chain: Frame[] = [];
    let anchor: Frame | null = frame;
    while (anchor !== null && !nodeOf.has(anchor)) {
      chain.push(anchor);
      anchor = anchor.parent;
    }

    let parentNode = anchor === null ? trie : nodeOf.get(anchor)!;
    let terminal = parentNode;
    for (let i = chain.length - 1; i >= 0; i--) {
      const f = chain[i];
      const step = f.key!;
      let map = parentNode.children;
      if (map === null) {
        map = new Map();
        parentNode.children = map;
      }
      let child = map.get(step);
      if (child === undefined) {
        child = newOpNode(f.parent === null ? '$' : parentNode.path + f.suffix);
        map.set(step, child);
      }
      nodeOf.set(f, child);
      parentNode = child;
      terminal = child;
    }
    // For a duplicate hit (already fully mapped), terminal is the existing node.
    if (chain.length === 0) terminal = nodeOf.get(frame)!;

    if (kind === 'replace') {
      terminal.replace = valueOrFn;
      terminal.hasReplace = true;
    } else if (kind === 'remove') {
      terminal.remove = true;
    } else {
      const fn = valueOrFn as Transform;
      const previous = terminal.fn;
      terminal.fn = previous === null ? fn : (v, p) => fn(previous(v, p), p);
    }
  }

  return trie;
}

/** Marker carried through a chain when a child is deleted. */
const DELETE = Symbol('jsonpath.delete');

function defineKey(target: Record<string, unknown>, key: string, value: unknown): void {
  // defineProperty avoids triggering any inherited setter (defense in depth).
  Object.defineProperty(target, key, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function callFn(fn: Transform, value: unknown, path: string): unknown {
  try {
    return fn(value, path);
  } catch (cause) {
    throw new JsonPathTransformError(path, cause);
  }
}

/**
 * Where a rebuilt node must be delivered.
 * - `root` : it is (a link of) the overall result.
 * - `exit` : put it in a multi-branch collector.
 * - `link` : patch one edge of a structurally-skipped single-branch container.
 */
type Target =
  | { t: 'root' }
  | { t: 'exit'; exit: ExitState; edge: Step }
  | { t: 'link'; link: LinkState; edge: Step };

/** Multi-branch container awaiting its children's rebuilt values. */
interface ExitState {
  node: OpNode;
  arr: unknown[];
  obj: Record<string, unknown> | null;
  collected: Map<Step, unknown>;
  /** Where this container itself goes once rebuilt. */
  target: Target;
}

/** Single-branch container dived through without a rebuild wrapper. */
interface LinkState {
  container: unknown[] | Record<string, unknown>;
  key: Step; // edge to the dive child
  isArr: boolean;
  target: Target; // where this container goes
}

interface EnterJob {
  t: 'enter';
  value: unknown;
  node: OpNode;
  target: Target;
}

interface ExitJob {
  t: 'exit';
  exit: ExitState;
}

type Job = EnterJob | ExitJob;

function childValue(container: unknown[] | Record<string, unknown>, key: Step, isArr: boolean): unknown {
  return isArr
    ? (container as unknown[])[key as number]
    : (container as Record<string, unknown>)[key as string];
}

/** Clone one container replacing (or deleting) exactly one edge. */
function withOneReplacement(
  container: unknown[] | Record<string, unknown>,
  key: Step,
  newChild: unknown | typeof DELETE,
  isArr: boolean,
): unknown {
  if (isArr) {
    const arr = container as unknown[];
    if (newChild === DELETE) return arr.filter((_, i) => i !== key);
    const nextArr = arr.slice();
    nextArr[key as number] = newChild;
    return nextArr;
  }
  const obj = container as Record<string, unknown>;
  const nextObj: Record<string, unknown> = {};
  for (const k of Object.keys(obj)) {
    if (k === key) {
      if (newChild === DELETE) continue;
      defineKey(nextObj, k, newChild);
    } else {
      defineKey(nextObj, k, obj[k]);
    }
  }
  return nextObj;
}

/** Rebuild a multi-branch container once all children have reported. */
function rebuild(exit: ExitState): unknown {
  const { arr, obj, collected, node } = exit;
  let rebuilt: unknown;

  if (obj === null) {
    if (!collectedHasDelete(collected)) {
      let changed = false;
      for (const [i, v] of collected) {
        if (v !== arr[i as number]) {
          changed = true;
          break;
        }
      }
      if (!changed) {
        rebuilt = arr;
      } else {
        const nextArr: unknown[] = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
          nextArr[i] = collected.has(i) ? collected.get(i) : arr[i];
        }
        rebuilt = nextArr;
      }
    } else {
      const nextArr: unknown[] = [];
      for (let i = 0; i < arr.length; i++) {
        const v = collected.has(i) ? collected.get(i) : arr[i];
        if (v !== DELETE) nextArr.push(v);
      }
      rebuilt = nextArr;
    }
  } else {
    let anyDelete = false;
    let anyChanged = false;
    for (const [k, v] of collected) {
      if (v === DELETE) anyDelete = true;
      else if (v !== obj[k as string]) anyChanged = true;
    }
    if (!anyDelete && !anyChanged) {
      rebuilt = obj;
    } else {
      const nextObj: Record<string, unknown> = {};
      for (const k of Object.keys(obj)) {
        const v = collected.has(k) ? collected.get(k) : obj[k];
        if (v === DELETE) continue;
        defineKey(nextObj, k, v);
      }
      rebuilt = nextObj;
    }
  }

  return node.fn !== null ? callFn(node.fn, rebuilt, node.path) : rebuilt;
}

function collectedHasDelete(collected: Map<Step, unknown>): boolean {
  for (const v of collected.values()) if (v === DELETE) return true;
  return false;
}

/**
 * Rebuild the value bottom-up according to the trie. Fully iterative, so
 * values nested thousands of levels deep do not consume the call stack.
 *
 * A container that is not itself transformed and has exactly one existing
 * child with an operation is "structurally skipped": the dive records a
 * {@link LinkState} rather than allocating a wrapper. When the dive
 * completes, links unwind innermost-first; a link allocates only if its
 * branch came back different, and if it is unchanged every link above it is
 * reused too. A no-op update of a value nested 8000 levels deep allocates
 * nothing; a changed leaf allocates exactly the ancestor chain.
 */
function applyOps(root: unknown, trie: OpNode): unknown {
  const jobs: Job[] = [{ t: 'enter', value: root, node: trie, target: { t: 'root' } }];
  let rootResult: unknown = root;

  while (jobs.length > 0) {
    const job = jobs.pop()!;

    if (job.t === 'exit') {
      deliver(job.exit.target, rebuild(job.exit));
      continue;
    }

    const { value, node, target } = job;

    if (node.remove) {
      deliver(target, DELETE);
      continue;
    }
    if (node.hasReplace) {
      deliver(target, node.replace);
      continue;
    }

    const isArr = Array.isArray(value);
    const isObj = value !== null && typeof value === 'object' && !isArr;

    if (!isArr && !isObj) {
      deliver(target, node.fn !== null ? callFn(node.fn, value, node.path) : value);
      continue;
    }

    if (node.children === null || node.children.size === 0) {
      deliver(target, node.fn !== null ? callFn(node.fn, value, node.path) : value);
      continue;
    }
    const childMap = node.children;

    const container = value as unknown[] | Record<string, unknown>;

    // Structural single-branch dive: this container has no operation of its
    // own and the only remaining work lies beneath exactly one existing child.
    // A leaf operation (remove/replace/transform on the current node) was
    // handled above, so reaching here means children carry the work.
    let single: { step: Step; childNode: OpNode } | null = null;
    if (node.fn === null && !node.hasReplace && !node.remove && childMap.size === 1) {
      const [step, childNode] = [...childMap.entries()][0];
      const exists = isArr
        ? (step as number) >= 0 && (step as number) < (container as unknown[]).length
        : Object.prototype.hasOwnProperty.call(container, step as string);
      if (exists) single = { step, childNode };
    }

    if (single !== null) {
      const link: LinkState = {
        container,
        key: single.step,
        isArr,
        target,
      };
      jobs.push({
        t: 'enter',
        value: childValue(container, single.step, isArr),
        node: single.childNode,
        target: { t: 'link', link, edge: single.step },
      });
      continue;
    }

    // Multi-branch region: collect all children, then rebuild on exit.
    const exit: ExitState = {
      node,
      arr: isArr ? (value as unknown[]) : [],
      obj: isObj ? (value as Record<string, unknown>) : null,
      collected: new Map(),
      target,
    };
    jobs.push({ t: 'exit', exit });

    const children: EnterJob[] = [];
    if (isArr) {
      const arr = value as unknown[];
      for (const step of childMap.keys()) {
        const i = step as number;
        if (i >= 0 && i < arr.length) {
          children.push({
            t: 'enter',
            value: arr[i],
            node: childMap.get(step)!,
            target: { t: 'exit', exit, edge: i },
          });
        }
      }
      // Document order fixes which transform error surfaces first.
      children.sort((a, b) => (a.target as { edge: number }).edge - (b.target as { edge: number }).edge);
    } else {
      const obj = value as Record<string, unknown>;
      for (const step of childMap.keys()) {
        const k = step as string;
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          children.push({
            t: 'enter',
            value: obj[k],
            node: childMap.get(step)!,
            target: { t: 'exit', exit, edge: k },
          });
        }
      }
    }
    for (let i = children.length - 1; i >= 0; i--) jobs.push(children[i]);
  }

  function deliver(initial: Target, initialValue: unknown): void {
    let target = initial;
    let v = initialValue;
    // Unwind the structural-dive chain iteratively so a multi-thousand-level
    // dive cannot grow the call stack.
    for (;;) {
      switch (target.t) {
        case 'root':
          rootResult = v === DELETE ? undefined : v;
          return;
        case 'exit':
          target.exit.collected.set(target.edge, v);
          return;
        case 'link': {
          const { link } = target;
          v =
            v === childValue(link.container, link.key, link.isArr)
              ? link.container // branch identical: reuse the whole subtree
              : withOneReplacement(link.container, link.key, v, link.isArr);
          target = link.target;
          break;
        }
      }
    }
  }

  return rootResult;
}

function run(
  root: unknown,
  expression: string | JsonPath,
  kind: OperationKind,
  valueOrFn: unknown,
): unknown {
  const path = typeof expression === 'string' ? parsePath(expression) : expression;
  const frames = queryFrames(root, path);
  if (frames.length === 0) return root;
  const trie = buildTrie(frames, kind, valueOrFn);
  return applyOps(root, trie);
}

/**
 * Replace every node matched by `expression` with `value`.
 * The input is not mutated; the return value reuses every untouched subtree
 * by reference. If nothing matches, the exact input reference is returned.
 */
export function replace<T>(root: T, expression: string | JsonPath, value: unknown): T {
  return run(root, expression, 'replace', value) as T;
}

/**
 * Delete every node matched by `expression`.
 *
 * All array indices in one expression are resolved against the *original*
 * array: `remove(data, '$.servers[0,2,-1]')` removes the original elements at
 * 0, 2 and the last index, regardless of the shifting that sequential
 * deletion would cause. Deleting the root yields `undefined`. An unmatched
 * expression returns the exact input reference.
 */
export function remove<T>(root: T, expression: string | JsonPath): T | undefined {
  return run(root, expression, 'remove', undefined) as T | undefined;
}

/**
 * Replace every node matched by `expression` with the result of `transform`
 * (called with the current value and its normalized path).
 *
 * Atomic: if the transform throws for any matched node, no part of the input
 * is changed and a {@link JsonPathTransformError} carrying `.path` and
 * `.cause` is thrown. When one matched node contains another (e.g. `$..a`),
 * transforms apply bottom-up — descendants first — so an outer transform
 * sees the already-transformed subtree; the result does not depend on the
 * traversal order.
 */
export function update<T>(
  root: T,
  expression: string | JsonPath,
  transform: Transform,
): T {
  return run(root, expression, 'transform', transform) as T;
}
