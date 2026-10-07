import { JsonPath, JsonPathCycleError, Segment, Selector } from './ast.js';
import { parsePath } from './parser.js';

/** One node of a query result: its value and RFC 9535 normalized path. */
export interface PathNode {
  value: unknown;
  path: string;
}

/**
 * A live frame during evaluation. Frames are chained to their parent, so a
 * normalized path is built once per chain and cached.
 */
export interface Frame {
  value: unknown;
  parent: Frame | null;
  /** Edge from the parent: number for array indices, string for object keys. */
  key: number | string | null;
  /** Normalized-path suffix from the parent, e.g. `['x']` or `[3]`. */
  suffix: string;
  /** Lazily memoized full normalized path. */
  np: string | null;
}

function isContainer(v: unknown): v is unknown[] | Record<string, unknown> {
  return v !== null && typeof v === 'object';
}

/**
 * Return the RFC 9535 normalized path of a frame. Paths are built lazily and
 * memoized: visiting a large structure for descent only pays for path strings
 * that are actually observed (the matched results), and shared ancestors are
 * built at most once.
 */
export function framePath(frame: Frame): string {
  if (frame.np !== null) return frame.np;
  // Collect the frames up to (but not including) an ancestor whose path is
  // already known, or all the way to the root. Done iteratively so values
  // nested thousands of levels deep cannot overflow the call stack.
  const chain: Frame[] = [];
  let anchor: Frame = frame;
  while (anchor.np === null) {
    chain.push(anchor);
    if (anchor.parent === null) break;
    anchor = anchor.parent;
  }
  // chain is innermost-first; anchor is the nearest known (or root) frame.
  let path = anchor.np ?? '$';
  for (let i = chain.length - 1; i >= 0; i--) {
    const f = chain[i];
    path = f.parent === null ? '$' : path + f.suffix;
    f.np = path;
  }
  return frame.np!;
}

function makeFrame(parent: Frame | null, key: number | string | null, value: unknown): Frame {
  const suffix =
    parent === null
      ? ''
      : typeof key === 'number'
        ? `[${key}]`
        : `[${escapeNormalized(key as string)}]`;
  return { value, parent, key, suffix, np: parent === null ? '$' : null };
}

/** Escape a member name for a normalized path (RFC 9535, single-quoted). */
function escapeNormalized(name: string): string {
  let out = "'";
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    switch (ch) {
      case "'":
        out += "\\'";
        break;
      case '\\':
        out += '\\\\';
        break;
      case '\b':
        out += '\\b';
        break;
      case '\f':
        out += '\\f';
        break;
      case '\n':
        out += '\\n';
        break;
      case '\r':
        out += '\\r';
        break;
      case '\t':
        out += '\\t';
        break;
      default: {
        const code = ch.charCodeAt(0);
        if (code < 0x20) {
          out += '\\u' + code.toString(16).padStart(4, '0');
        } else {
          // Surrogate halves and astral characters are appended as-is: a given
          // name always yields the same (unique) string.
          out += ch;
        }
      }
    }
  }
  return out + "'";
}

/**
 * Evaluate a parsed (or string) JSONPath against `root`.
 * Results are in document order per RFC 9535 and repeatable across runs.
 */
export function queryFrames(root: unknown, expression: string | JsonPath): Frame[] {
  const segments = typeof expression === 'string' ? parsePath(expression) : expression;
  let current: Frame[] = [makeFrame(null, null, root)];
  for (const segment of segments) {
    const next: Frame[] = [];
    if (segment.kind === 'child') {
      for (const frame of current) applySelectors(frame, segment.selectors, next);
    } else {
      for (const frame of current) descend(frame, segment.selectors, next);
    }
    current = next;
  }
  return current;
}

export function query(root: unknown, expression: string | JsonPath): PathNode[] {
  return queryFrames(root, expression).map((frame) => ({
    value: frame.value,
    path: framePath(frame),
  }));
}

/** Convenience: return only the matched values (in document order). */
export function values(root: unknown, expression: string | JsonPath): unknown[] {
  return queryFrames(root, expression).map((frame) => frame.value);
}

/** Apply a bracket of selectors to one frame, in union (written) order. */
function applySelectors(frame: Frame, selectors: Selector[], out: Frame[]): void {
  for (const selector of selectors) {
    switch (selector.kind) {
      case 'name':
        matchName(frame, selector.name, out);
        break;
      case 'wildcard':
        matchWildcard(frame, out);
        break;
      case 'index':
        matchIndex(frame, selector.index, out);
        break;
      case 'slice':
        matchSlice(frame, selector.start, selector.end, selector.step, out);
        break;
    }
  }
}

function matchName(frame: Frame, name: string, out: Frame[]): void {
  const v = frame.value;
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    if (Object.prototype.hasOwnProperty.call(v, name)) {
      out.push(makeFrame(frame, name, (v as Record<string, unknown>)[name]));
    }
  }
}

function matchIndex(frame: Frame, index: number, out: Frame[]): void {
  const v = frame.value;
  if (Array.isArray(v)) {
    const i = index < 0 ? v.length + index : index;
    if (i >= 0 && i < v.length) out.push(makeFrame(frame, i, v[i]));
  }
}

function matchWildcard(frame: Frame, out: Frame[]): void {
  const v = frame.value;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) out.push(makeFrame(frame, i, v[i]));
  } else if (v !== null && typeof v === 'object') {
    for (const key of Object.keys(v as Record<string, unknown>)) {
      out.push(makeFrame(frame, key, (v as Record<string, unknown>)[key]));
    }
  }
}

/**
 * Slice normalization. Equivalent to Python's slice adjustment (which RFC
 * 9535 follows): normalize against the length, clamp, then step while the
 * index relation to the end bound holds. A step of 0 selects nothing.
 */
export function sliceIndices(
  len: number,
  start: number | null,
  end: number | null,
  step: number | null,
): number[] {
  const k = step ?? 1;
  if (k === 0) return [];
  let s: number;
  let e: number;
  if (k > 0) {
    s = start === null ? 0 : start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    e = end === null ? len : end < 0 ? Math.max(len + end, 0) : Math.min(end, len);
  } else {
    s =
      start === null
        ? len - 1
        : start < 0
          ? Math.max(len + start, -1)
          : Math.min(start, len - 1);
    e =
      end === null
        ? -1
        : end < 0
          ? Math.max(len + end, -1)
          : Math.min(end, len - 1);
  }
  const indices: number[] = [];
  if (k > 0) for (let i = s; i < e; i += k) indices.push(i);
  else for (let i = s; i > e; i += k) indices.push(i);
  return indices;
}

function matchSlice(
  frame: Frame,
  start: number | null,
  end: number | null,
  step: number | null,
  out: Frame[],
): void {
  const v = frame.value;
  if (Array.isArray(v)) {
    for (const i of sliceIndices(v.length, start, end, step)) {
      out.push(makeFrame(frame, i, v[i]));
    }
  }
}

type EnterEvent = { type: 'enter'; frame: Frame };
type ExitEvent = { type: 'exit'; value: object };
type WalkEvent = EnterEvent | ExitEvent;

/**
 * Recursive descent (RFC 9535 2.5.2): visit the input node and every
 * descendant in pre-order document order (arrays in index order), applying
 * the selector bracket to each visited node. Fully iterative.
 *
 * A value already present on the current ancestor chain is a true cycle and
 * raises {@link JsonPathCycleError}; the same value referenced from two
 * unrelated places (a shared subtree) is visited normally.
 */
function descend(root: Frame, selectors: Selector[], out: Frame[]): void {
  const ancestors = new Set<object>();
  const stack: WalkEvent[] = [{ type: 'enter', frame: root }];
  while (stack.length > 0) {
    const event = stack.pop()!;
    if (event.type === 'exit') {
      ancestors.delete(event.value);
      continue;
    }
    const frame = event.frame;
    const value = frame.value;

    if (isContainer(value)) {
      if (ancestors.has(value)) {
        throw new JsonPathCycleError(framePath(frame));
      }
      ancestors.add(value);
      stack.push({ type: 'exit', value });
    }

    // R_i: apply the child segment to the visited node before its descendants.
    applySelectors(frame, selectors, out);

    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ type: 'enter', frame: makeFrame(frame, i, value[i]) });
      }
    } else if (isContainer(value)) {
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj);
      for (let i = keys.length - 1; i >= 0; i--) {
        const key = keys[i];
        stack.push({ type: 'enter', frame: makeFrame(frame, key, obj[key]) });
      }
    }
  }
}
