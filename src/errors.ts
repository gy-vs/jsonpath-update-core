/**
 * 库内抛出的两类错误：
 *  - JSONPathSyntaxError：表达式不合法（含不支持的过滤器 ?...）
 *  - CyclicReferenceError：被查询的数据中存在真正的循环引用
 */

export class JSONPathSyntaxError extends SyntaxError {
  /** 0 起的字符下标，指向出错位置 */
  readonly position: number;
  /** 1 起，便于人读 */
  readonly column: number;
  /** 出错位置附近的表达式片段（^ 指向下标 position） */
  readonly excerpt: string;

  constructor(message: string, expression: string, position: number) {
    const pos = Math.max(0, Math.min(position, expression.length));
    const from = Math.max(0, pos - 12);
    const to = Math.min(expression.length, pos + 12);
    const prefix = from > 0 ? '…' : '';
    const suffix = to < expression.length ? '…' : '';
    const snippet = prefix + expression.slice(from, to) + suffix;
    const caret = ' '.repeat(prefix.length + (pos - from)) + '^';
    super(`${message}（位置 ${pos}）\n  ${snippet}\n  ${caret}`);
    this.name = 'JSONPathSyntaxError';
    this.position = pos;
    this.column = pos + 1;
    this.excerpt = expression.slice(from, to);
  }
}

export class CyclicReferenceError extends Error {
  /** 形成环的那个位置的规范路径（尽量给出） */
  readonly path: string;

  constructor(path: string) {
    super(`检测到循环引用，路径 ${path} 绕回了自己的祖先；JSON 数据不允许环`);
    this.name = 'CyclicReferenceError';
    this.path = path;
  }
}
