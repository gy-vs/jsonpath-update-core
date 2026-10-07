/**
 * jsonpath-update-core —— RFC 9535 风格的 JSONPath 查询与原子改写库。
 *
 * 查询：query(data, "$.servers[*].host")
 * 改写：replace / remove / transform，同一表达式，命中点与 query 一一对应；
 *       任何一点失败，整次调用什么都不改，原样输入连同出错路径一起返回。
 */

export { parse } from './parser.js';
export { query } from './query.js';
export { replace, remove, transform } from './update.js';
export type { ValueTransformer } from './update.js';
export { JSONPathSyntaxError, CyclicReferenceError } from './errors.js';
export type {
  JSONPathQuery,
  Segment,
  ChildSegment,
  DescendantSegment,
  Selector,
  NameSelector,
  WildcardSelector,
  IndexSelector,
  SliceSelector,
  PathNode,
  UpdateOp,
  UpdateResult,
  UpdateSuccess,
  UpdateFailure,
} from './types.js';
