/**
 * JSONPath query + immutable update engine (RFC 9535 selector subset).
 *
 * - {@link parse} parses an expression into a reusable AST.
 * - {@link query} evaluates an expression and returns matched nodes with
 *   their RFC 9535 normalized paths.
 * - {@link values} is a convenience returning only matched values.
 * - {@link replace} / {@link remove} / {@link update} rewrite matched nodes
 *   immutably and atomically.
 */
import { parsePath } from './parser.js';
import { query, queryFrames, values, sliceIndices, type PathNode } from './evaluate.js';
import { replace, remove, update, type Transform } from './update.js';

export { parsePath, query, queryFrames, values, sliceIndices, replace, remove, update };
export type { PathNode, Transform };
export type {
  JsonPath,
  Segment,
  Selector,
  NameSelector,
  WildcardSelector,
  IndexSelector,
  SliceSelector,
} from './ast.js';
export {
  JsonPathError,
  JsonPathSyntaxError,
  JsonPathCycleError,
  JsonPathTransformError,
} from './ast.js';

/** Parse a JSONPath expression. Alias kept for the placeholder API name. */
export const parse = parsePath;
