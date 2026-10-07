/**
 * AST and error types for the JSONPath engine.
 *
 * The syntax implemented here is the selector subset of RFC 9535:
 *   - root `$`
 *   - dot-member (`$.a`) and bracketed member (`$['a']` / `$["a"]`, with escapes)
 *   - wildcard (`$[*]` / `$.*`)
 *   - index (`$[3]`, `$[-3]`)
 *   - slices (`$[s:e]`, `$[s:e:k]`, each part optional; step 0 selects nothing)
 *   - recursive descent (`..`), optionally followed by any child selector
 *   - bracket unions (`$[1, 3, 'x']`)
 * Filter expressions (`?`) and script expressions (`(`) are intentionally
 * rejected with a positioned syntax error.
 */

export type NameSelector = { kind: 'name'; name: string };
export type WildcardSelector = { kind: 'wildcard' };
export type IndexSelector = { kind: 'index'; index: number };
export type SliceSelector = {
  kind: 'slice';
  start: number | null;
  end: number | null;
  step: number | null;
};

export type Selector =
  | NameSelector
  | WildcardSelector
  | IndexSelector
  | SliceSelector;

/** A segment is either a plain child segment or a recursive descent. */
export type Segment =
  | { kind: 'child'; selectors: Selector[] }
  | { kind: 'descend'; selectors: Selector[] };

export type JsonPath = Segment[];

/** Base class for every error raised by this library. */
export class JsonPathError extends Error {}

/** A malformed path expression. `position` is the 0-based offset in the source. */
export class JsonPathSyntaxError extends JsonPathError {
  readonly position: number;
  constructor(message: string, position: number, source: string) {
    super(`${message} at position ${position} in ${JSON.stringify(source)}`);
    this.name = 'JsonPathSyntaxError';
    this.position = position;
  }
}

/** A true cyclic reference was encountered while walking the input value. */
export class JsonPathCycleError extends JsonPathError {
  readonly path: string;
  constructor(normalizedPath: string) {
    super(`cyclic reference reached at ${normalizedPath}`);
    this.name = 'JsonPathCycleError';
    this.path = normalizedPath;
  }
}

/**
 * An update transform threw. The input value is never mutated; this error
 * carries the normalized path of the node for which the transform failed and
 * the original error in `cause`.
 */
export class JsonPathTransformError extends JsonPathError {
  readonly path: string;
  constructor(normalizedPath: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`transform failed at ${normalizedPath}: ${reason}`);
    this.name = 'JsonPathTransformError';
    this.path = normalizedPath;
    this.cause = cause as Error;
  }
}
