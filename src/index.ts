export type Token = { kind: 'root' | 'field' | 'index' | 'wildcard'; value?: string | number };

export function parse(path: string): Token[] {
  if (!path.startsWith('$')) throw new Error('root');
  const out: Token[] = [{ kind: 'root' }];
  for (let i = 1; i < path.length; ) {
    const ch = path[i];
    if (ch === '.') {
      i++;
      if (path[i] === '*') { out.push({ kind: 'wildcard' }); i++; continue; }
      let j = i;
      while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
      out.push({ kind: 'field', value: path.slice(i, j) });
      i = j;
    } else if (ch === '[') {
      const end = path.indexOf(']', i + 1);
      if (end < 0) throw new Error('bracket');
      const inner = path.slice(i + 1, end);
      if (inner === '*') out.push({ kind: 'wildcard' });
      else if (/^-?\d+$/.test(inner)) out.push({ kind: 'index', value: Number(inner) });
      else if ((inner[0] === '"' || inner[0] === "'") && inner[inner.length - 1] === inner[0])
        out.push({ kind: 'field', value: inner.slice(1, -1) });
      else throw new Error('bracket');
      i = end + 1;
    } else throw new Error('path');
  }
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function children(v: unknown): [string | number, unknown][] {
  if (Array.isArray(v)) return v.map((c, i) => [i, c] as [number, unknown]);
  if (isObj(v)) return Object.keys(v).map(k => [k, v[k]] as [string, unknown]);
  return [];
}

export function query(value: unknown, tokens: Token[]): unknown[] {
  let current: unknown[] = [value];
  for (const token of tokens.slice(1)) {
    current = current.flatMap(item => {
      if (token.kind === 'wildcard' && (Array.isArray(item) || isObj(item)))
        return children(item).map(([, c]) => c);
      if (token.kind === 'field' && isObj(item)) {
        const hit = (item as Record<string, unknown>)[String(token.value)];
        return hit === undefined ? [] : [hit];
      }
      if (token.kind === 'index' && Array.isArray(item)) {
        const i = Number(token.value);
        return i >= 0 && i < item.length ? [item[i]] : [];
      }
      return [];
    });
  }
  return current;
}

export type Segment = string | number;
export type Action = number;

export type Hit = { path: Segment[]; value: unknown; action: Action };

export type UpdateError =
  | { code: 'cycle-input' }
  | { code: 'cycle-replacement'; action: Action; path: Segment[] }
  | { code: 'ancestor-descendant'; ancestor: Segment[]; descendant: Segment[] }
  | { code: 'duplicate-target'; path: Segment[] }
  | { code: 'delete-root' }
  | { code: 'invalid-path' }
  | { code: 'invalid-action'; action: Action }
  | { code: 'transform-threw'; action: Action; path: Segment[]; error: unknown };

export type UpdateFailure = UpdateError & { ok: false; hits: Hit[] };
export type UpdateResult =
  | { ok: true; value: unknown; hits: Hit[] }
  | UpdateFailure;

export type Update =
  | { path: string | Token[]; set: unknown }
  | { path: string | Token[]; delete: true }
  | { path: string | Token[]; apply: (node: unknown, path: Segment[]) => unknown };

const TOMBSTONE = Symbol('delete');

export function hasCycle(root: unknown): boolean {
  const stack: object[] = [];
  const visit = (v: unknown): boolean => {
    if (typeof v !== 'object' || v === null || typeof v === 'function') return false;
    if (stack.includes(v)) return true;
    stack.push(v);
    for (const [, c] of children(v)) if (visit(c)) return true;
    stack.pop();
    return false;
  };
  return visit(root);
}

type Terminal =
  | { kind: 'set'; value: unknown }
  | { kind: 'delete' }
  | { kind: 'apply'; fn: (node: unknown, path: Segment[]) => unknown };

class TrieNode {
  kids = new Map<string, TrieNode>();
  terminal: Terminal | null = null;
  constructor(readonly path: Segment[]) {}
  key(k: string | number) { return typeof k === 'number' ? `#${k}` : `'${k}`; }
  child(k: string | number): TrieNode {
    const key = this.key(k);
    let n = this.kids.get(key);
    if (!n) { n = new TrieNode([...this.path, k]); this.kids.set(key, n); }
    return n;
  }
}

function collect(
  value: unknown,
  tokens: Token[],
  action: Action,
  hits: Hit[],
  prefix: Segment[],
  depth = 0,
): void {
  if (depth >= tokens.length - 1) {
    hits.push({ path: prefix, value, action });
    return;
  }
  const token = tokens[depth + 1];
  if (token.kind === 'wildcard' && (Array.isArray(value) || isObj(value))) {
    for (const [k, c] of children(value)) collect(c, tokens, action, hits, [...prefix, k], depth + 1);
  } else if (token.kind === 'field' && isObj(value)) {
    const name = String(token.value);
    if (Object.prototype.hasOwnProperty.call(value, name))
      collect(value[name], tokens, action, hits, [...prefix, name], depth + 1);
  } else if (token.kind === 'index' && Array.isArray(value)) {
    const i = Number(token.value);
    if (i >= 0 && i < value.length)
      collect(value[i], tokens, action, hits, [...prefix, i], depth + 1);
  }
}

function samePath(a: Segment[], b: Segment[]): boolean {
  return a.length === b.length && a.every((s, i) => s === b[i]);
}

export function update(input: unknown, actions: Update | Update[]): UpdateResult {
  const list = Array.isArray(actions) ? actions : [actions];
  const hits: Hit[] = [];
  const fail = (e: UpdateError): UpdateResult => ({ ok: false, hits, ...e });

  if (hasCycle(input)) return fail({ code: 'cycle-input' });

  const root = new TrieNode([]);

  for (let a = 0; a < list.length; a++) {
    const spec = list[a];
    let tokens: Token[];
    try { tokens = typeof spec.path === 'string' ? parse(spec.path) : spec.path; }
    catch { return fail({ code: 'invalid-path' }); }
    if (tokens[0]?.kind !== 'root') return fail({ code: 'invalid-path' });

    let terminal: Terminal;
    if ('set' in spec) terminal = { kind: 'set', value: spec.set };
    else if ('delete' in spec && spec.delete === true) terminal = { kind: 'delete' };
    else if ('apply' in spec && typeof spec.apply === 'function') terminal = { kind: 'apply', fn: spec.apply };
    else return fail({ code: 'invalid-action', action: a });

    if (tokens.length === 1) {
      if (root.terminal) return fail({ code: 'duplicate-target', path: [] });
      if (terminal.kind === 'delete') return fail({ code: 'delete-root' });
      root.terminal = terminal;
      hits.push({ path: [], value: input, action: a });
      continue;
    }

    const found: Hit[] = [];
    collect(input, tokens, a, found, []);
    for (const hit of found) {
      let node = root;
      for (const seg of hit.path) node = node.child(seg);
      if (node.terminal) return fail({ code: 'duplicate-target', path: hit.path });
      node.terminal = terminal;
      hits.push(hit);
    }
  }

  const terminals: { node: TrieNode; terminal: Terminal }[] = [];
  const walk = (node: TrieNode): UpdateError | null => {
    if (node.terminal) {
      terminals.push({ node, terminal: node.terminal });
      if (node.kids.size)
        return { code: 'ancestor-descendant', ancestor: node.path, descendant: deepest(node).path };
    }
    for (const kid of node.kids.values()) {
      const err = walk(kid);
      if (err) return err;
    }
    return null;
  };
  const deepest = (node: TrieNode): TrieNode => {
    let n = node;
    while (n.kids.size) n = n.kids.values().next().value!;
    return n;
  };
  const conflict = walk(root);
  if (conflict) return fail(conflict);

  const results = new Map<TrieNode, unknown>();
  for (const { node, terminal } of terminals) {
    const hit = hits.find(h => samePath(h.path, node.path))!;
    if (terminal.kind === 'set') {
      if (hasCycle(terminal.value)) return fail({ code: 'cycle-replacement', action: hit.action, path: node.path });
      results.set(node, terminal.value);
    } else if (terminal.kind === 'delete') {
      results.set(node, TOMBSTONE);
    } else {
      let out: unknown;
      try { out = terminal.fn(hit.value, node.path); }
      catch (error) { return fail({ code: 'transform-threw', action: hit.action, path: node.path, error }); }
      if (hasCycle(out)) return fail({ code: 'cycle-replacement', action: hit.action, path: node.path });
      results.set(node, out);
    }
  }

  const rebuild = (v: unknown, plan: TrieNode | null): unknown => {
    if (!plan) return v;
    if (plan.terminal) return results.get(plan);
    if (Array.isArray(v)) {
      let changed = false;
      const next = v.map((c, i) => {
        const r = rebuild(c, plan.kids.get(`#${i}`) ?? null);
        if (r === TOMBSTONE || r !== c) changed = true;
        return r;
      }).filter(c => c !== TOMBSTONE);
      return changed ? next : v;
    }
    if (isObj(v)) {
      let changed = false;
      const next: Record<string, unknown> = {};
      for (const [k, c] of Object.entries(v)) {
        const r = rebuild(c, plan.kids.get(`'${k}`) ?? null);
        if (r === TOMBSTONE) { changed = true; continue; }
        next[k] = r;
        if (r !== c) changed = true;
      }
      return changed ? next : v;
    }
    return v;
  };

  return { ok: true, value: rebuild(input, root), hits };
}
