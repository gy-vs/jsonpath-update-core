import {
  JsonPath,
  JsonPathSyntaxError,
  Segment,
  Selector,
} from './ast.js';

/** name-first = ALPHA / "_" / %x80-D7FF / %xE000-10FFFF (surrogates excluded) */
function isNameFirst(ch: string | undefined): boolean {
  if (ch === undefined) return false;
  if (ch === '_' || (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) return true;
  const cp = ch.codePointAt(0)!;
  if (ch.length === 2) return cp >= 0xe000 && cp <= 0x10ffff; // astral
  return cp >= 0x80 && cp <= 0xd7ff || cp >= 0xe000 && cp <= 0xffff;
}

/** name-char = name-first / DIGIT */
function isNameChar(ch: string | undefined): boolean {
  if (ch !== undefined && ch >= '0' && ch <= '9') return true;
  return isNameFirst(ch);
}

/** Integers in selectors must be exact I-JSON values (RFC 9535 2.1). */
const MAX_EXACT_INTEGER = 9007199254740991; // 2^53 - 1
const MIN_EXACT_INTEGER = -9007199254740991;

/**
 * Parse a JSONPath expression into a segment list.
 *
 * Throws {@link JsonPathSyntaxError} (with a `position` field) for any
 * syntactically invalid input, including unsupported filter/script selectors.
 */
export function parsePath(source: string): JsonPath {
  const p = new Parser(source);
  p.parseRoot();
  const segments: JsonPath = [];
  for (;;) {
    if (p.atEnd()) break;
    const beforeSpace = p.pos;
    p.skipSpace(); // segments = *(S segment): S only precedes another segment
    if (p.atEnd()) throw p.error('trailing whitespace after path', beforeSpace);
    let segment: Segment;
    if (p.peek() === '[') {
      segment = { kind: 'child', selectors: p.parseBracket() };
    } else if (p.peek() === '.') {
      if (p.source[p.pos + 1] === '.') {
        p.pos += 2;
        segment = { kind: 'descend', selectors: p.parseAfterDot(true) };
      } else {
        p.pos += 1;
        segment = { kind: 'child', selectors: p.parseAfterDot(false) };
      }
    } else {
      throw p.error('expected a segment');
    }
    segments.push(segment);
  }
  return segments;
}

class Parser {
  pos = 0;
  constructor(readonly source: string) {}

  error(message: string, position = this.pos): JsonPathSyntaxError {
    return new JsonPathSyntaxError(message, position, this.source);
  }

  atEnd(): boolean {
    return this.pos >= this.source.length;
  }

  peek(offset = 0): string {
    return this.source[this.pos + offset];
  }

  parseRoot(): void {
    if (this.source[0] !== '$') {
      throw this.error("path must start with root identifier '$'", 0);
    }
    this.pos = 1;
  }

  /** Selector following "." (child) or ".." (descendant); per ABNF no S here. */
  parseAfterDot(descend: boolean): Selector[] {
    if (this.atEnd()) {
      throw this.error(descend ? "'..' must be followed by a selector" : "expected a segment after '.'");
    }
    const ch = this.peek();
    if (ch === '[') return this.parseBracket();
    if (ch === '*') {
      this.pos++;
      return [{ kind: 'wildcard' }];
    }
    if (ch === '.') throw this.error("unexpected '.'");
    return [this.parseShorthandName()];
  }

  /** member-name-shorthand: a nameFirst followed by nameChar* (code-point based) */
  parseShorthandName(): Selector {
    const start = this.pos;
    const first = this.codePoint();
    if (!isNameFirst(String.fromCodePoint(first))) {
      throw this.error('expected a member name');
    }
    this.pos += first > 0xffff ? 2 : 1;
    while (!this.atEnd()) {
      const cp = this.codePoint();
      if (!isNameChar(String.fromCodePoint(cp))) break;
      this.pos += cp > 0xffff ? 2 : 1;
    }
    return { kind: 'name', name: this.source.slice(start, this.pos) };
  }

  /** Peek the code point at the current position without advancing. */
  codePoint(): number {
    return this.source.codePointAt(this.pos)!;
  }

  /** S = SP / TAB / LF / CR (RFC 5234) */
  skipSpace(): void {
    for (;;) {
      const ch = this.source[this.pos];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') this.pos++;
      else return;
    }
  }

  /** bracket-selection: "[" S selector *(S "," S selector) S "]" */
  parseBracket(): Selector[] {
    const openPos = this.pos;
    this.pos++; // consume "["
    const selectors: Selector[] = [];
    this.skipSpace();
    if (this.atEnd()) throw this.error('unterminated bracket selector', openPos);
    if (this.peek() === ']') throw this.error("empty selector '[]'");
    for (;;) {
      this.skipSpace();
      if (this.atEnd()) throw this.error('unterminated bracket selector', openPos);
      selectors.push(this.parseSelector());
      this.skipSpace();
      if (this.atEnd()) throw this.error('unterminated bracket selector', openPos);
      if (this.peek() === ']') {
        this.pos++;
        return selectors;
      }
      if (this.peek() !== ',') throw this.error("expected ',' or ']'");
      this.pos++; // consume ","
      this.skipSpace();
      if (this.peek() === ']') throw this.error("trailing ',' in union");
    }
  }

  parseSelector(): Selector {
    const ch = this.peek();
    if (ch === '"' || ch === "'") return { kind: 'name', name: this.parseString(ch) };
    if (ch === '*') {
      this.pos++;
      return { kind: 'wildcard' };
    }
    if (ch === '?' || ch === '(') {
      throw this.error('filter and script expressions are not supported');
    }
    // integer or slice
    const maybeInt = this.parseIntegerPrefix();
    this.skipSpace();
    if (this.peek() === ':') return this.parseSliceTail(maybeInt);
    if (maybeInt === null) throw this.error('expected a selector');
    return { kind: 'index', index: maybeInt };
  }

  /**
   * Consume an integer prefix (possibly absent, when a slice starts with ':').
   * Grammar: "0" / ["-"] DIGIT1 *DIGIT, value within the exact-integer range.
   * Returns null when the input does not begin with an integer (including a
   * lone "-"; the caller diagnoses the following token).
   */
  parseIntegerPrefix(): number | null {
    const start = this.pos;
    if (this.peek() === '-') this.pos++;
    const digitsStart = this.pos;
    while (!this.atEnd() && isDigit(this.source.charCodeAt(this.pos))) this.pos++;
    if (this.pos === digitsStart) {
      this.pos = start;
      return null;
    }
    const digitCount = this.pos - digitsStart;
    if (digitCount > 1 && this.source[digitsStart] === '0') {
      throw this.error('leading zeroes are not allowed', digitsStart);
    }
    const negative = start < digitsStart;
    if (negative && digitCount === 1 && this.source[digitsStart] === '0') {
      throw this.error("'-0' is not a valid integer", digitsStart - 1);
    }
    const digits = this.source.slice(digitsStart, this.pos);
    if (digits.length > 16) {
      throw this.error('integer is outside the exact-integer range', start);
    }
    const value = Number((negative ? '-' : '') + digits);
    if (value > MAX_EXACT_INTEGER || value < MIN_EXACT_INTEGER) {
      throw this.error('integer is outside the exact-integer range', start);
    }
    return value;
  }

  /** Parse ": S end? S [":" [S step]]" following an already-consumed start. */
  parseSliceTail(start: number | null): Selector {
    this.pos++; // consume first ":"
    this.skipSpace();
    const end = this.parseIntegerPrefix();
    this.skipSpace();
    let step: number | null = null;
    if (this.peek() === ':') {
      this.pos++;
      this.skipSpace();
      step = this.parseIntegerPrefix(); // null means the step is omitted
    }
    return { kind: 'slice', start, end, step };
  }

  /**
   * string-literal surrounded by `quote`. Escape validity depends on the
   * delimiter: the other quote may only appear literally, and surrogate
   * escapes must form complete pairs. Surrogate errors are reported at the
   * position of the escape that completes the bad sequence (`\u`).
   */
  parseString(quote: string): string {
    const literalStart = this.pos;
    this.pos++; // opening quote
    let out = '';
    let pendingHighAt = -1;
    while (!this.atEnd()) {
      const ch = this.source[this.pos];
      if (ch === quote) {
        this.pos++;
        if (pendingHighAt >= 0) {
          throw this.error('lone high surrogate in string literal', pendingHighAt);
        }
        return out;
      }
      if (ch === '\\') {
        const slashPos = this.pos;
        const code = this.parseEscape(quote, slashPos);
        if (code.kind === 'unit') {
          const unit = code.unit;
          if (pendingHighAt >= 0) {
            if (unit >= 0xdc00 && unit <= 0xdfff) {
              out += String.fromCharCode(unit);
              pendingHighAt = -1;
            } else {
              throw this.error('lone high surrogate in string literal', pendingHighAt);
            }
          } else if (unit >= 0xd800 && unit <= 0xdbff) {
            out += String.fromCharCode(unit);
            pendingHighAt = slashPos;
          } else if (unit >= 0xdc00 && unit <= 0xdfff) {
            throw this.error('lone low surrogate in string literal', slashPos);
          } else {
            out += String.fromCharCode(unit);
          }
        } else {
          if (pendingHighAt >= 0) {
            throw this.error('lone high surrogate in string literal', pendingHighAt);
          }
          out += code.text;
        }
        continue;
      }
      if (pendingHighAt >= 0) {
        // The next code unit must be supplied by a low-surrogate escape.
        throw this.error('lone high surrogate in string literal', pendingHighAt);
      }
      if (ch.codePointAt(0)! < 0x20) {
        throw this.error('unescaped control character in string literal');
      }
      out += ch;
      this.pos++;
    }
    throw this.error('unterminated string literal', literalStart);
  }

  parseEscape(
    quote: string,
    slashPos: number,
  ): { kind: 'unit'; unit: number } | { kind: 'text'; text: string } {
    this.pos++; // backslash
    const ch = this.source[this.pos];
    const simple = (text: string) => {
      this.pos++;
      return { kind: 'text' as const, text };
    };
    switch (ch) {
      case quote:
        return simple(ch);
      case '\\':
        return simple('\\');
      case '/':
        return simple('/');
      case 'b':
        return simple('\b');
      case 'f':
        return simple('\f');
      case 'n':
        return simple('\n');
      case 'r':
        return simple('\r');
      case 't':
        return simple('\t');
      case 'u': {
        this.pos++;
        let hex = '';
        for (let i = 0; i < 4; i++) {
          const h = this.source[this.pos];
          if (h === undefined || !isHex(h)) {
            throw this.error('invalid unicode escape', slashPos);
          }
          hex += h;
          this.pos++;
        }
        return { kind: 'unit', unit: parseInt(hex, 16) };
      }
      default:
        throw this.error('invalid escape sequence', slashPos);
    }
  }
}

function isDigit(code: number | undefined): boolean {
  return code !== undefined && code >= 48 && code <= 57;
}

function isHex(ch: string): boolean {
  return (
    (ch >= '0' && ch <= '9') ||
    (ch >= 'a' && ch <= 'f') ||
    (ch >= 'A' && ch <= 'F')
  );
}
