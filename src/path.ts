/**
 * RFC 9535 第 2.7 节规范路径的生成。
 *
 * 规则：
 *   normalized-path = $ *( "[" normal-selector "]" )
 *   normal-selector = 非负十进制整数 | 单引号字符串
 * 单引号字符串中：
 *   - ' 与 \\ 必须转义；控制字符 U+0000–U+001F 一律 \\u00xx（小写）
 *   - 其余字符（含双引号、斜杠）原样输出
 */

const CONTROL_ESCAPE: Record<number, string | undefined> = {
  0x08: '\\b',
  0x09: '\\t',
  0x0a: '\\n',
  0x0c: '\\f',
  0x0d: '\\r',
};

export function escapeNormalizedName(name: string): string {
  let out = "'";
  for (const ch of name) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "'") {
      out += "\\'";
    } else if (ch === '\\') {
      out += '\\\\';
    } else if (CONTROL_ESCAPE[cp] !== undefined) {
      out += CONTROL_ESCAPE[cp];
    } else if (cp <= 0x1f) {
      out += '\\u' + cp.toString(16).padStart(4, '0');
    } else {
      out += ch; // 含 U+10000 以上字符：for..of 直接给出完整字符
    }
  }
  return out + "'";
}

/** 把 keys（对象键 / 非负数组下标）拼成规范路径 */
export function buildNormalizedPath(keys: readonly (string | number)[]): string {
  let out = '$';
  for (const key of keys) {
    if (typeof key === 'number') {
      out += '[' + key + ']';
    } else {
      out += '[' + escapeNormalizedName(key) + ']';
    }
  }
  return out;
}
