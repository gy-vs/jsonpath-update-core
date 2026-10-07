/**
 * 手写递归下降解析器，严格实现 RFC 9535 附录 A 的 ABNF（去掉过滤器）。
 *
 * 与 ABNF 的唯一有意偏差：过滤器 selector（?...）属于合法 ABNF，
 * 但本库不实现，遇到时抛出带位置的 JSONPathSyntaxError。
 */

import { JSONPathSyntaxError } from './errors.js';
import type {
  IndexSelector,
  JSONPathQuery,
  NameSelector,
  Segment,
  Selector,
  SliceSelector,
  WildcardSelector,
} from './types.js';

const BLANK = new Set([' ', '\t', '\n', '\r']);

/** name-first = ALPHA / "_" / 非 ASCII（跳过代理码点） */
function isNameFirst(code: number): boolean {
  return (
    (code >= 0x41 && code <= 0x5a) || // A-Z
    (code >= 0x61 && code <= 0x7a) || // a-z
    code === 0x5f || // _
    (code >= 0x80 && code <= 0xd7ff) ||
    code >= 0xe000
  );
}

/** name-char = name-first / DIGIT */
function isNameChar(code: number): boolean {
  return isNameFirst(code) || (code >= 0x30 && code <= 0x39);
}

class Parser {
  private i = 0;

  constructor(private readonly src: string) {}

  parse(): JSONPathQuery {
    if (this.src.length === 0 || this.src[0] !== '$') {
      throw new JSONPathSyntaxError('JSONPath 必须以 $ 开头', this.src, 0);
    }
    this.i = 1;

    const segments: Segment[] = [];
    for (;;) {
      if (this.i >= this.src.length) break;
      // segments = *(S segment)：段前允许空白
      this.skipBlank();
      if (this.i >= this.src.length) {
        throw new JSONPathSyntaxError('表达式末尾不允许空白', this.src, this.i);
      }
      segments.push(this.parseSegment());
    }
    return { expression: this.src, segments };
  }

  private skipBlank(): void {
    while (this.i < this.src.length && BLANK.has(this.src[this.i])) this.i++;
  }

  private parseSegment(): Segment {
    const c = this.src[this.i];
    if (c === '.') {
      if (this.src[this.i + 1] === '.') {
        this.i += 2;
        // .. 后面紧跟空白是非法的（空白只允许出现在段与段之间）
        if (BLANK.has(this.src[this.i] ?? '')) {
          throw new JSONPathSyntaxError('".." 后不能有空白', this.src, this.i);
        }
        if (this.src[this.i] === '[') {
          return { kind: 'descendant', selectors: this.parseBracketed() };
        }
        return { kind: 'descendant', selectors: this.parseShorthand() };
      }
      this.i += 1;
      if (BLANK.has(this.src[this.i] ?? '')) {
        throw new JSONPathSyntaxError('"." 后不能有空白', this.src, this.i);
      }
      return { kind: 'child', selectors: this.parseShorthand() };
    }
    if (c === '[') {
      return { kind: 'child', selectors: this.parseBracketed() };
    }
    throw new JSONPathSyntaxError(
      `未预期的字符 ${JSON.stringify(c)}，应为 "." 或 "["`,
      this.src,
      this.i,
    );
  }

  /** 解析 "." 或 ".." 之后的通配 / 成员名简写（不含括号形式） */
  private parseShorthand(): Selector[] {
    const start = this.i;
    const c = this.src[this.i];
    if (c === '*') {
      this.i += 1;
      const sel: WildcardSelector = { kind: 'wildcard', start };
      return [sel];
    }
    if (c === undefined) {
      throw new JSONPathSyntaxError('表达式在 "." 后结束，缺少成员名', this.src, this.i);
    }
    // member-name-shorthand
    const code = this.src.codePointAt(this.i) ?? 0;
    if (!isNameFirst(code)) {
      throw new JSONPathSyntaxError(
        `成员名简写不能以 ${JSON.stringify(c)} 开头；特殊字符请用 ['…'] 写法`,
        this.src,
        this.i,
      );
    }
    const begin = this.i;
    this.i += code > 0xffff ? 2 : 1;
    while (this.i < this.src.length) {
      const cp = this.src.codePointAt(this.i) ?? 0;
      if (!isNameChar(cp)) break;
      this.i += cp > 0xffff ? 2 : 1;
    }
    const name = this.src.slice(begin, this.i);
    const sel: NameSelector = { kind: 'name', name, start: begin };
    return [sel];
  }

  private parseBracketed(): Selector[] {
    const openPos = this.i;
    this.i += 1; // [
    const selectors: Selector[] = [];
    this.skipBlank();
    if (this.src[this.i] === ']') {
      throw new JSONPathSyntaxError('方括号内至少要有一个选择器', this.src, this.i);
    }
    for (;;) {
      this.skipBlank();
      selectors.push(this.parseSelector());
      this.skipBlank();
      if (this.src[this.i] === ',') {
        this.i += 1;
        this.skipBlank();
        if (this.src[this.i] === ']' || this.src[this.i] === undefined) {
          throw new JSONPathSyntaxError('并集不允许悬空的逗号', this.src, this.i);
        }
        continue;
      }
      if (this.src[this.i] === ']') {
        this.i += 1;
        return selectors;
      }
      if (this.i >= this.src.length) {
        throw new JSONPathSyntaxError('方括号缺少闭合的 "]"', this.src, openPos);
      }
      throw new JSONPathSyntaxError(
        `并集选择器之间应为 ","，实际为 ${JSON.stringify(this.src[this.i])}`,
        this.src,
        this.i,
      );
    }
  }

  private parseSelector(): Selector {
    const start = this.i;
    const c = this.src[this.i];

    // 过滤器：本库明确不支持
    if (c === '?') {
      throw new JSONPathSyntaxError(
        '不支持过滤器表达式 ?(...)；本库仅支持名称/下标/切片/通配/递归下降/并集',
        this.src,
        this.i,
      );
    }

    // 名称选择器（字符串字面量）
    if (c === '"' || c === "'") {
      const name = this.parseStringLiteral();
      return { kind: 'name', name, start };
    }

    // 通配
    if (c === '*') {
      this.i += 1;
      return { kind: 'wildcard', start };
    }

    // 切片：首个 token 是 ":"（start 省略），或整数之后紧跟 ":"
    if (c === ':') {
      return this.parseSlice(null, start);
    }

    // 整数：可能是下标，也可能是切片的开头
    if (c === '-' || (c >= '0' && c <= '9')) {
      const intPos = this.i;
      const value = this.parseInt();
      this.skipBlank(); // slice-selector 允许 [start S] ":"
      if (this.src[this.i] === ':') {
        return this.parseSlice(value, intPos);
      }
      const sel: IndexSelector = { kind: 'index', index: value, start: intPos };
      return sel;
    }

    if (c === undefined) {
      throw new JSONPathSyntaxError('表达式在方括号内结束', this.src, this.i);
    }
    throw new JSONPathSyntaxError(
      `无法识别的选择器，${JSON.stringify(c)} 不是合法开头`,
      this.src,
      this.i,
    );
  }

  /**
   * 解析切片余下部分。进入时 this.i 指向第一个 ":"。
   * 语法：[start S] ":" S [end S] [":" [S step]]
   */
  private parseSlice(first: number | null, startPos: number): SliceSelector {
    this.i += 1; // 第一个 ':'
    this.skipBlank();

    let end: number | null = null;
    if (this.src[this.i] !== ':' && this.src[this.i] !== ',' && this.src[this.i] !== ']') {
      end = this.parseInt();
      this.skipBlank();
    }

    let step: number | null = null;
    if (this.src[this.i] === ':') {
      this.i += 1;
      this.skipBlank();
      if (this.src[this.i] !== ',' && this.src[this.i] !== ']') {
        step = this.parseInt();
        this.skipBlank();
      }
    }

    return { kind: 'slice', start: first, end, step, startPos };
  }

  /**
   * int = "0" / (["-"] DIGIT1 *DIGIT)
   * CTS 额外要求：绝对值 >= 2^53 的整数非法。
   */
  private parseInt(): number {
    const begin = this.i;
    if (this.src[this.i] === '-') this.i += 1;
    const digitStart = this.i;
    while (this.i < this.src.length && this.src[this.i] >= '0' && this.src[this.i] <= '9') {
      this.i += 1;
    }
    if (this.i === digitStart) {
      throw new JSONPathSyntaxError('此处应为整数', this.src, begin || this.i);
    }
    const digits = this.src.slice(begin, this.i);
    const neg = digits.startsWith('-');
    const mag = neg ? digits.slice(1) : digits;
    if (mag !== '0' && mag.startsWith('0')) {
      throw new JSONPathSyntaxError('整数不允许前导零', this.src, begin);
    }
    if (mag === '0' && neg) {
      throw new JSONPathSyntaxError('不允许 "-0"', this.src, begin);
    }
    // 安全整数检查：2^53 = 9007199254740992（16 位）
    if (mag.length > 16 || (mag.length === 16 && mag >= '9007199254740992')) {
      throw new JSONPathSyntaxError('整数超出安全整数范围（绝对值必须小于 2^53）', this.src, begin);
    }
    return parseInt(digits, 10);
  }

  /**
   * string-literal（RFC 2.3.1.1 / 附录 A）。
   * 返回解码后的 JS 字符串；任何非法转义、裸控制字符、孤立代理都报错。
   */
  private parseStringLiteral(): string {
    const quote = this.src[this.i] as '"' | "'";
    const begin = this.i;
    this.i += 1;
    // 用码点数组累积，最后 fromCodePoint，天然处理 U+10000 以上字符
    const out: number[] = [];

    for (;;) {
      if (this.i >= this.src.length) {
        throw new JSONPathSyntaxError('字符串缺少闭合引号', this.src, begin);
      }
      const ch = this.src[this.i];
      const code = this.src.charCodeAt(this.i);

      if (ch === quote) {
        this.i += 1;
        return String.fromCodePoint(...out);
      }

      if (ch === '\\') {
        this.i += 1;
        if (this.i >= this.src.length) {
          throw new JSONPathSyntaxError('反斜杠后缺少转义字符', this.src, begin);
        }
        const e = this.src[this.i];
        switch (e) {
          case 'b': out.push(0x08); this.i += 1; continue;
          case 'f': out.push(0x0c); this.i += 1; continue;
          case 'n': out.push(0x0a); this.i += 1; continue;
          case 'r': out.push(0x0d); this.i += 1; continue;
          case 't': out.push(0x09); this.i += 1; continue;
          case '/': out.push(0x2f); this.i += 1; continue;
          case '\\': out.push(0x5c); this.i += 1; continue;
          // 闭合引号可以转义；“另一种”引号只能裸写，转义它属于非法（ABNF double/single-quoted）
          case '"':
            if (quote !== '"') {
              throw new JSONPathSyntaxError("单引号字符串中不能转义双引号，请直接写 \"", this.src, this.i - 1);
            }
            out.push(0x22);
            this.i += 1;
            continue;
          case "'":
            if (quote !== "'") {
              throw new JSONPathSyntaxError("双引号字符串中不能转义单引号，请直接写 '", this.src, this.i - 1);
            }
            out.push(0x27);
            this.i += 1;
            continue;
          case 'u': {
            this.i += 1;
            const cp = this.parseUnicodeEscape();
            out.push(cp);
            continue;
          }
          default:
            throw new JSONPathSyntaxError(
              `非法转义 \\${e}`,
              this.src,
              this.i - 1,
            );
        }
      }

      // 未转义字符：控制字符（U+0000–U+001F）非法
      if (code <= 0x1f) {
        throw new JSONPathSyntaxError('字符串中不允许出现未转义的控制字符', this.src, this.i);
      }

      // 按码点前进（U+10000 以上在源码中为代理对）
      const cp = this.src.codePointAt(this.i) as number;
      if (cp > 0xffff) {
        out.push(cp);
        this.i += 2;
      } else {
        // 孤立代理非法
        if (cp >= 0xd800 && cp <= 0xdfff) {
          throw new JSONPathSyntaxError('字符串中不允许孤立代理码元', this.src, this.i);
        }
        out.push(cp);
        this.i += 1;
      }
    }
  }

  /** 处理 \uXXXX；支持高代理后必须紧跟 \uXXXX 低代理的成对形式。返回码点。 */
  private parseUnicodeEscape(): number {
    const escPos = this.i - 1; // 指向 'u'
    const hex = this.consumeHex4(escPos);

    if (hex >= 0xd800 && hex <= 0xdbff) {
      // 高代理：后面必须是 \u + 低代理
      if (this.src[this.i] === '\\' && this.src[this.i + 1] === 'u') {
        this.i += 2;
        const low = this.consumeHex4(escPos);
        if (low >= 0xdc00 && low <= 0xdfff) {
          return 0x10000 + ((hex - 0xd800) << 10) + (low - 0xdc00);
        }
        throw new JSONPathSyntaxError('高代理 \\uXXXX 后必须紧跟低代理 \\uXXXX', this.src, escPos);
      }
      throw new JSONPathSyntaxError('高代理 \\uXXXX 后必须紧跟低代理 \\uXXXX', this.src, escPos);
    }
    if (hex >= 0xdc00 && hex <= 0xdfff) {
      throw new JSONPathSyntaxError('不允许单独的低代理 \\uXXXX', this.src, escPos);
    }
    return hex;
  }

  private consumeHex4(escPos: number): number {
    let value = 0;
    for (let n = 0; n < 4; n++) {
      const c = this.src[this.i];
      const d = c >= '0' && c <= '9'
        ? c.charCodeAt(0) - 48
        : c >= 'a' && c <= 'f'
          ? c.charCodeAt(0) - 87
          : c >= 'A' && c <= 'F'
            ? c.charCodeAt(0) - 55
            : -1;
      if (d === -1) {
        throw new JSONPathSyntaxError('\\u 后需要 4 位十六进制数字', this.src, this.i >= this.src.length ? this.i : escPos);
      }
      value = (value << 4) | d;
      this.i += 1;
    }
    return value;
  }
}

export function parse(expression: string): JSONPathQuery {
  if (typeof expression !== 'string') {
    throw new TypeError('parse() 的参数必须是字符串');
  }
  return new Parser(expression).parse();
}
