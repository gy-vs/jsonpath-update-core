// JSONPath engine: query + atomic update.
//
// Path grammar (in addition to the original `$.field` / `$.*`):
//   $[0]          array index
//   $['a']        quoted object field
//   $[*]          wildcard bracket form

export type Token = {
  kind: 'root' | 'field' | 'index' | 'wildcard';
  value?: string | number;
};

/** A concrete, stable address of a node inside one specific input value. */
export type Segment = string | number;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const IDENT = /^[A-Za-z_$][\w$]*$/;
const DIGITS = /^\d+$/;
const QUOTED = /^(?:'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)")$/;

export function parse(path: string): Token[] {
  if (typeof path !== 'string' || !path.startsWith('$')) throw new Error('root');
  const tokens: Token[] = [{ kind: 'root' }];
  let i = 1;
  while (i < path.length) {
    const ch = path[i];
    if (ch === '.') {
      i++;
      if (i >= path.length) throw new Error('unexpected end after "."');
      if (path[i] === '.') throw new Error('empty field name');
      if (path[i] === '*') {
        tokens.push({ kind: 'wildcard' });
        i++;
      } else {
        const start = i;
        while (i < path.length && path[i] !== '.' && path[i] !== '[') i++;
        tokens.push({ kind: 'field', value: path.slice(start, i) });
      }
    } else if (ch === '[') {
      const close = path.indexOf(']', i + 1);
      if (close === -1) throw new Error('unterminated bracket');
      const inner = path.slice(i + 1, close);
      if (inner === '*') {
        tokens.push({ kind: 'wildcard' });
      } else if (DIGITS.test(inner)) {
        tokens.push({ kind: 'index', value: Number(inner) });
      } else {
        const m = QUOTED.exec(inner);
        if (!m) throw new Error(`unsupported bracket selector: [${inner}]`);
        const raw = m[1] !== undefined ? m[1] : m[2];
        tokens.push({ kind: 'field', value: raw.replace(/\\(['"\\])/g, '$1') });
      }
      i = close + 1;
    } else {
      throw new Error(`unexpected character "${ch}"`);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Query
// ---------------------------------------------------------------------------

export function query(value: unknown, tokens: Token[]): unknown[] {
  let current: unknown[] = [value];
  for (const token of tokens.slice(1)) {
    current = current.flatMap((item) => {
      if (token.kind === 'wildcard' && item && typeof item === 'object') {
        return Object.values(item as object);
      }
      if (token.kind === 'field' && item && typeof item === 'object') {
        return [(item as Record<string, unknown>)[String(token.value)]];
      }
      if (token.kind === 'index' && Array.isArray(item)) {
        const idx = token.value as number;
        return Number.isInteger(idx) && idx >= 0 && idx < item.length ? [item[idx]] : [];
      }
      return [];
    });
  }
  return current;
}

/** Canonical path rendering: `$`, `$.a`, `$['a-b']`, `$.arr[0]`. */
export function pathString(segments: Segment[]): string {
  let out = '$';
  for (const seg of segments) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else if (IDENT.test(seg)) out += `.${seg}`;
    else out += `[${JSON.stringify(seg)}]`;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Update API
// ---------------------------------------------------------------------------

export interface TransformContext {
  op: number;
  path: string;
  segments: Segment[];
}

export type Action =
  | { type: 'replace'; value: unknown }
  | { type: 'delete' }
  | { type: 'transform'; fn: (value: unknown, ctx: TransformContext) => unknown };

export interface UpdateOp {
  path: string | Token[];
  action: Action;
}

export interface Hit {
  /** Index of the operation that produced this hit. */
  op: number;
  /** Canonical path, e.g. `$.items[2]`. */
  path: string;
  segments: Segment[];
  /** Value reference from the original input snapshot. */
  value: unknown;
}

export type UpdateError =
  | { kind: 'parse'; op: number; message: string }
  | { kind: 'invalid-op'; op: number; message: string }
  | {
      kind: 'cycle';
      where: 'input' | 'replacement' | 'transform-output';
      op?: number;
      path?: string;
      message: string;
    }
  | { kind: 'conflict'; reason: 'ancestor-descendant'; ancestor: string; descendant: string }
  | { kind: 'conflict'; reason: 'duplicate-reference'; path: string; ops: [number, number] }
  | { kind: 'transform-failed'; op: number; path: string; cause: unknown };

export type UpdateResult<T> =
  | { ok: true; value: T; hits: Hit[] }
  /** On failure `value` is always the original input reference, untouched. */
  | { ok: false; value: T; hits: Hit[]; error: UpdateError };

interface Location {
  segments: Segment[];
  value: unknown;
}

/**
 * Locate every concrete node matched by `tokens` in `root`.
 * Only existing nodes are reported (a missing field is not a node).
 */
function locate(root: unknown, tokens: Token[]): Location[] {
  let frontier: Location[] = [{ segments: [], value: root }];
  for (const token of tokens.slice(1)) {
    const next: Location[] = [];
    for (const cur of frontier) {
      const v = cur.value;
      if (v === null || typeof v !== 'object') continue;
      if (token.kind === 'field') {
        const key = String(token.value);
        if (Object.prototype.hasOwnProperty.call(v, key)) {
          next.push({ segments: [...cur.segments, key], value: (v as Record<string, unknown>)[key] });
        }
      } else if (token.kind === 'index') {
        if (Array.isArray(v)) {
          const idx = token.value as number;
          if (Number.isInteger(idx) && idx >= 0 && idx < v.length) {
            next.push({ segments: [...cur.segments, idx], value: v[idx] });
          }
        }
      } else if (token.kind === 'wildcard') {
        if (Array.isArray(v)) {
          v.forEach((el, idx) => next.push({ segments: [...cur.segments, idx], value: el }));
        } else {
          for (const key of Object.keys(v as Record<string, unknown>)) {
            next.push({ segments: [...cur.segments, key], value: (v as Record<string, unknown>)[key] });
          }
        }
      }
    }
    frontier = next;
  }
  return frontier;
}

/** DFS over JSON-like data; returns the first cyclic path found. */
function detectCycle(root: unknown): string | undefined {
  const ancestors = new WeakSet<object>();
  const walk = (v: unknown, segments: Segment[]): string | undefined => {
    if (v === null || typeof v !== 'object') return undefined;
    if (ancestors.has(v)) return pathString(segments);
    ancestors.add(v);
    let found: string | undefined;
    if (Array.isArray(v)) {
      for (let i = 0; i < v.length && found === undefined; i++) {
        found = walk(v[i], [...segments, i]);
      }
    } else {
      for (const key of Object.keys(v as Record<string, unknown>)) {
        found = walk((v as Record<string, unknown>)[key], [...segments, key]);
        if (found !== undefined) break;
      }
    }
    ancestors.delete(v);
    return found;
  };
  return walk(root, []);
}

/** Deterministic document order: array indexes numerically, fields lexicographically. */
function compareSegments(a: Segment[], b: Segment[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i];
    const y = b[i];
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (typeof x === 'number') return -1;
    else if (typeof y === 'number') return 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return a.length - b.length;
}

class PlanNode {
  readonly children = new Map<Segment, PlanNode>();
  hit: Hit | null = null;
}

/** First terminal (hit) node in a plan subtree, in document order. */
function firstTerminal(node: PlanNode): Hit {
  const visit = (n: PlanNode): Hit | null => {
    if (n.hit) return n.hit;
    for (const seg of [...n.children.keys()].sort(compareKey)) {
      const found = visit(n.children.get(seg)!);
      if (found) return found;
    }
    return null;
  };
  return visit(node)!;
}

/** Key ordering matching compareSegments: numeric indexes before string fields. */
function compareKey(a: Segment, b: Segment): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'number') return -1;
  if (typeof b === 'number') return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

const DELETE = Symbol('jsonpath.delete');

/** Internal signal used to abort a partial rebuild atomically. */
class AbortBuild extends Error {
  constructor(readonly failure: UpdateError) {
    super('update aborted');
  }
}

/**
 * Apply one or more operations to every node matched by their JSONPaths,
 * atomically: either a structurally-shared new value is returned, or the
 * original input is returned untouched together with diagnostics.
 */
export function update<T>(
  input: T,
  operations: UpdateOp | readonly UpdateOp[],
): UpdateResult<T> {
  const ops = Array.isArray(operations) ? operations : [operations];
  const fail = (error: UpdateError, hits: Hit[] = []): UpdateResult<T> => ({
    ok: false,
    value: input,
    hits,
    error,
  });

  // ---- Phase 1: parse & validate (nothing is visited yet) ---------------
  const parsed: { tokens: Token[]; action: Action }[] = [];
  for (let op = 0; op < ops.length; op++) {
    const entry = ops[op];
    if (!entry || typeof entry !== 'object') {
      return fail({ kind: 'invalid-op', op, message: 'operation must be an object with a path and an action' });
    }
    if (typeof entry.path !== 'string' && !Array.isArray(entry.path)) {
      return fail({ kind: 'invalid-op', op, message: 'operation needs a string path and an action' });
    }
    let tokens: Token[];
    try {
      tokens =
        typeof entry.path === 'string' ? parse(entry.path) : (entry.path as Token[]);
    } catch (cause) {
      return fail({ kind: 'parse', op, message: (cause as Error).message });
    }
    if (tokens.length === 0 || tokens[0].kind !== 'root') {
      return fail({ kind: 'parse', op, message: 'path must start with "$"' });
    }
    const action = (entry as UpdateOp).action;
    if (!action || typeof action !== 'object') {
      return fail({ kind: 'invalid-op', op, message: 'missing action' });
    }
    if (action.type === 'replace') {
      if (!('value' in action)) {
        return fail({ kind: 'invalid-op', op, message: 'replace action needs a value' });
      }
    } else if (action.type === 'transform') {
      if (typeof action.fn !== 'function') {
        return fail({ kind: 'invalid-op', op, message: 'transform action needs a function' });
      }
    } else if (action.type !== 'delete') {
      return fail({ kind: 'invalid-op', op, message: `unknown action type: ${(action as Action).type}` });
    }
    parsed.push({ tokens, action });
  }

  // ---- Phase 2: reject cyclic structures before planning ----------------
  const inputCycle = detectCycle(input);
  if (inputCycle !== undefined) {
    return fail({
      kind: 'cycle',
      where: 'input',
      path: inputCycle,
      message: `cyclic structure in input at ${inputCycle}`,
    });
  }
  for (let op = 0; op < parsed.length; op++) {
    const action = parsed[op].action;
    if (action.type === 'replace') {
      const cycle = detectCycle(action.value);
      if (cycle !== undefined) {
        return fail({
          kind: 'cycle',
          where: 'replacement',
          op,
          path: cycle,
          message: `cyclic replacement value for operation ${op} at ${cycle}`,
        });
      }
    }
  }

  // ---- Phase 3: collect stable node paths on the original snapshot ------
  const hits: Hit[] = [];
  for (let op = 0; op < parsed.length; op++) {
    for (const loc of locate(input, parsed[op].tokens)) {
      hits.push({ op, segments: loc.segments, path: pathString(loc.segments), value: loc.value });
    }
  }
  hits.sort((a, b) => compareSegments(a.segments, b.segments));

  // ---- Phase 4: detect duplicate / ancestor-descendant conflicts --------
  const planRoot = new PlanNode();
  for (const hit of hits) {
    let node = planRoot;
    for (const seg of hit.segments) {
      if (node.hit) {
        return fail(
          { kind: 'conflict', reason: 'ancestor-descendant', ancestor: node.hit.path, descendant: hit.path },
          hits,
        );
      }
      let next = node.children.get(seg);
      if (!next) {
        next = new PlanNode();
        node.children.set(seg, next);
      }
      node = next;
    }
    if (node.hit) {
      return fail(
        { kind: 'conflict', reason: 'duplicate-reference', path: hit.path, ops: [node.hit.op, hit.op] },
        hits,
      );
    }
    if (node.children.size > 0) {
      // Defensive: hits are pre-sorted, so an ancestor terminal normally
      // arrives first and rejects when its descendant is inserted.
      const firstDescendant = firstTerminal(node);
      return fail(
        { kind: 'conflict', reason: 'ancestor-descendant', ancestor: hit.path, descendant: firstDescendant.path },
        hits,
      );
    }
    node.hit = hit;
  }

  // ---- Phase 5: rebuild structurally, applying actions ------------------
  const applyAction = (value: unknown, hit: Hit): unknown => {
    const action = parsed[hit.op].action;
    if (action.type === 'replace') return action.value;
    if (action.type === 'delete') return DELETE;
    let output: unknown;
    try {
      output = action.fn(value, { op: hit.op, path: hit.path, segments: hit.segments });
    } catch (cause) {
      throw new AbortBuild({ kind: 'transform-failed', op: hit.op, path: hit.path, cause });
    }
    const cycle = detectCycle(output);
    if (cycle !== undefined) {
      throw new AbortBuild({
        kind: 'cycle',
        where: 'transform-output',
        op: hit.op,
        path: cycle,
        message: `transform at ${hit.path} produced a cyclic value`,
      });
    }
    return output;
  };

  const rebuild = (current: unknown, plan: PlanNode): unknown => {
    if (plan.hit) return applyAction(current, plan.hit);
    if (plan.children.size === 0) return current; // nothing targeted below: share
    if (Array.isArray(current)) {
      // Plan deletions by original index; never mutate while traversing.
      const out: unknown[] = [];
      for (let i = 0; i < current.length; i++) {
        const child = plan.children.get(i);
        if (!child) {
          out.push(current[i]); // untouched element: shared by reference
          continue;
        }
        const rebuilt = rebuild(current[i], child);
        if (rebuilt !== DELETE) out.push(rebuilt);
      }
      return out;
    }
    if (current !== null && typeof current === 'object') {
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(current as Record<string, unknown>)) {
        const child = plan.children.get(key);
        if (!child) {
          out[key] = (current as Record<string, unknown>)[key]; // shared subtree
          continue;
        }
        const rebuilt = rebuild((current as Record<string, unknown>)[key], child);
        if (rebuilt !== DELETE) out[key] = rebuilt;
      }
      return out;
    }
    return current;
  };

  try {
    let value: unknown;
    if (planRoot.hit) {
      // Root node itself is the only hit (descendants would be a conflict).
      value = applyAction(input, planRoot.hit);
      if (value === DELETE) value = undefined;
    } else {
      value = rebuild(input, planRoot);
    }
    return { ok: true, value: value as T, hits };
  } catch (cause) {
    if (cause instanceof AbortBuild) return fail(cause.failure, hits);
    throw cause;
  }
}
