import type {
  ConditionStrategy,
  IterationRecord,
  SentinelConfig,
} from '../../shared/types';

function isSentinelConfig(cfg: unknown): cfg is SentinelConfig {
  if (cfg === null || typeof cfg !== 'object') return false;
  const c = cfg as Record<string, unknown>;
  if (typeof c.pattern !== 'string' || typeof c.isRegex !== 'boolean') {
    return false;
  }
  if (c.caseInsensitive !== undefined && typeof c.caseInsensitive !== 'boolean') {
    return false;
  }
  return true;
}

export const sentinelStrategy: ConditionStrategy = {
  async evaluate(
    iter: IterationRecord,
    cfg: unknown,
  ): Promise<{ met: boolean; detail: string }> {
    if (!isSentinelConfig(cfg)) {
      return { met: false, detail: 'invalid sentinel config' };
    }

    const { pattern, isRegex, caseInsensitive } = cfg;

    if (isRegex) {
      let regex: RegExp;
      try {
        regex = new RegExp(pattern, caseInsensitive ? 'i' : '');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return { met: false, detail: `invalid regex: ${msg}` };
      }
      const match = regex.exec(iter.stdout);
      if (match) {
        return { met: true, detail: `matched at index ${match.index}` };
      }
      return { met: false, detail: 'pattern not found' };
    }

    const haystack = caseInsensitive ? iter.stdout.toLowerCase() : iter.stdout;
    const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
    const idx = haystack.indexOf(needle);
    if (idx >= 0) {
      return { met: true, detail: `matched at index ${idx}` };
    }
    return { met: false, detail: 'pattern not found' };
  },
};
