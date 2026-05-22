import type { Scope, TemplateResolveResult } from '../shared/workflow';
import { TEMPLATE_REF_RE } from '../shared/template-refs';

/**
 * Resolve `{{ key.path }}` placeholders inside `template` against `scope`.
 *
 * - Each placeholder's key-path is split on `.` and walked through the scope's
 *   nested records. Any missing / null / undefined segment counts as missing.
 * - A placeholder may carry a fallback: `{{ key.path | default text }}`.
 *   When the key is missing, the literal `text` is substituted and — because
 *   the author explicitly handled absence — NO warning is recorded.
 * - A missing key with no `| default` clause is replaced with the empty
 *   string and recorded as a warning (unchanged behaviour).
 * - "Missing" means null / undefined (or descending into a non-object); an
 *   explicit empty-string value is a real value and is NOT replaced by the
 *   default.
 * - Resolved values are stringified via `String(value)`.
 */
export function resolve(template: string, scope: Scope): TemplateResolveResult {
  const warnings: TemplateResolveResult['warnings'] = [];

  const text = template.replace(
    TEMPLATE_REF_RE,
    (_match, keyPath: string, defaultValue: string | undefined) => {
      const segments = keyPath.split('.');
      let cursor: unknown = scope;
      for (const segment of segments) {
        if (cursor == null || typeof cursor !== 'object') {
          cursor = undefined;
          break;
        }
        cursor = (cursor as Record<string, unknown>)[segment];
        if (cursor == null) break;
      }

      if (cursor == null) {
        // A `| default …` clause turns an absent value into an expected
        // fallback rather than a warning.
        if (defaultValue !== undefined) return defaultValue;
        warnings.push({ field: '', missingKey: keyPath });
        return '';
      }
      return String(cursor);
    },
  );

  return { text, warnings };
}
