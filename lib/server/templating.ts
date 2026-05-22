import type { Scope, TemplateResolveResult } from '../shared/workflow';

const TEMPLATE_RE = /\{\{\s*([\w.-]+)\s*\}\}/g;

/**
 * Resolve `{{ key.path }}` placeholders inside `template` against `scope`.
 *
 * - Each placeholder's key-path is split on `.` and walked through the scope's
 *   nested records. Any missing / null / undefined segment counts as missing.
 * - Missing keys are replaced with the empty string and recorded as warnings.
 * - Resolved values are stringified via `String(value)`.
 */
export function resolve(template: string, scope: Scope): TemplateResolveResult {
  const warnings: TemplateResolveResult['warnings'] = [];

  const text = template.replace(TEMPLATE_RE, (_match, keyPath: string) => {
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
      warnings.push({ field: '', missingKey: keyPath });
      return '';
    }
    return String(cursor);
  });

  return { text, warnings };
}
