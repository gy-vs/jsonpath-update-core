import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query } from '../src/index.js';

/**
 * The official RFC 9535 JSONPath Compliance Test Suite (selector coverage).
 * Filter selectors (`?`), script selectors (`(`) and current-node identifiers
 * (`@`) are intentionally out of scope for this library and are skipped; every
 * other test must pass, and every selector the suite marks invalid must be
 * rejected.
 */
const here = dirname(fileURLToPath(import.meta.url));
const cts = JSON.parse(readFileSync(join(here, 'cts.json'), 'utf8')) as {
  tests: Array<{
    name: string;
    selector: string;
    document: unknown;
    result?: unknown[];
    results?: unknown[][];
    results_paths?: string[] | string[][];
    invalid_selector?: boolean;
  }>;
};

const unsupported = (s: string) => /\?|\(|@/.test(s);

const applicable = cts.tests.filter((t) => !unsupported(t.selector));

function eqAny(actual: unknown, accepted: unknown[]): boolean {
  // Compare structurally via JSON with bigints downgraded to numbers.
  const seen = JSON.stringify(actual, (_k, v) =>
    typeof v === 'bigint' ? Number(v) : v,
  );
  return accepted.some(
    (candidate) =>
      JSON.stringify(candidate, (_k, v) => (typeof v === 'bigint' ? Number(v) : v)) === seen,
  );
}

describe('RFC 9535 CTS (supported subset)', () => {
  const invalid = applicable.filter((t) => t.invalid_selector);
  const valid = applicable.filter((t) => !t.invalid_selector);

  it(`accepts all ${valid.length} valid selectors`, () => {
    for (const t of valid) {
      const nodes = query(t.document, t.selector);
      const gotValues = nodes.map((n) => n.value);
      const gotPaths = nodes.map((n) => n.path);

      if (t.result !== undefined) {
        // Single mandated value ordering.
        expect(gotValues, `values for ${t.selector} (${t.name})`).toEqual(t.result);
      } else if (t.results) {
        // Object member ordering is implementation-defined: our insertion-order
        // result must be one of the accepted orderings, and paths align with it.
        expect(eqAny(gotValues, t.results), `values for ${t.selector} (${t.name})`).toBe(true);
      }

      if (t.results_paths) {
        const accepted = Array.isArray(t.results_paths[0])
          ? (t.results_paths as string[][])
          : [t.results_paths as string[]];
        expect(
          accepted.some((p) => JSON.stringify(p) === JSON.stringify(gotPaths)),
          `paths for ${t.selector} (${t.name}): ${JSON.stringify(gotPaths)}`,
        ).toBe(true);
      }
    }
  });

  it(`rejects all ${invalid.length} invalid selectors`, () => {
    for (const t of invalid) {
      expect(() => query(t.document, t.selector), `${t.selector} (${t.name})`).toThrow();
    }
  });
});
