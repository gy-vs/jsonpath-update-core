/**
 * JSONPath (RFC 9535) AST 与公共类型定义。
 *
 * 支持的语法子集：
 *   $                          根节点
 *   .name / ['name'] / ["n"]   成员名（引号内支持 RFC 转义）
 *   .* / [*]                   通配
 *   [i] / [-i]                 下标
 *   [start:end:step]           切片（各部分可省略，step 不可为 0 以外的非法整数；0 选空）
 *   ..name / ..[ ... ]         递归下降
 *   [a, b, c]                  并集（同一节点可被命中多次，结果保留重复）
 *
 * 不支持过滤器（?...），出现即抛出带位置的语法错误。
 */

/** 成员名选择器 */
export interface NameSelector {
  kind: 'name';
  name: string;
  /** 表达式中的起始下标（用于报错定位） */
  start: number;
}

/** 通配选择器 */
export interface WildcardSelector {
  kind: 'wildcard';
  start: number;
}

/** 下标选择器（解析后仍保留负号，求值时按数组长度归一化） */
export interface IndexSelector {
  kind: 'index';
  index: number;
  start: number;
}

/** 切片选择器；start/end/step 省略时为 null */
export interface SliceSelector {
  kind: 'slice';
  start: number | null;
  end: number | null;
  step: number | null;
  startPos: number;
}

export type Selector =
  | NameSelector
  | WildcardSelector
  | IndexSelector
  | SliceSelector;

/** 普通子段：.x 或 [ ... ] */
export interface ChildSegment {
  kind: 'child';
  selectors: Selector[];
}

/** 递归下降子段：..x 或 ..[ ... ] */
export interface DescendantSegment {
  kind: 'descendant';
  selectors: Selector[];
}

export type Segment = ChildSegment | DescendantSegment;

/** parse() 的结果：一个不可变的 JSONPath 查询 AST */
export interface JSONPathQuery {
  /** 原始表达式 */
  expression: string;
  segments: Segment[];
}

/** query() 命中的单个节点 */
export interface PathNode {
  /** 命中的值 */
  value: unknown;
  /** RFC 9535 规范路径，如 $['servers'][0]['host'] */
  path: string;
  /** 路径分段：对象键为 string，数组下标为规范化后的非负整数 */
  keys: (string | number)[];
}

/** 改写操作类型 */
export type UpdateOp = 'replace' | 'delete' | 'transform';

/** 改写失败（任一命中点的函数抛出异常）时返回的结构 */
export interface UpdateFailure {
  ok: false;
  /** 原样输入，未做任何修改 */
  value: unknown;
  /** 是否与输入为同一引用（失败时恒为 true） */
  changed: false;
  /** 出错命中点在 query 结果中的下标（0 起） */
  index: number;
  /** 出错命中点的规范路径 */
  path: string;
  /** 操作种类 */
  op: UpdateOp;
  /** 用户函数抛出的原始错误 */
  error: unknown;
}

/** 改写成功时返回的结构 */
export interface UpdateSuccess {
  ok: true;
  /** 改写后的新根；未发生实际变化时与输入同引用 */
  changed: boolean;
  /** 命中并处理的节点数（与 query 结果一一对应） */
  count: number;
  value: unknown;
}

export type UpdateResult = UpdateSuccess | UpdateFailure;
