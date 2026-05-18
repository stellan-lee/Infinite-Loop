import type { BranchOp } from '../shared/workflow';

export interface Predicate {
  lhs: string;
  op: BranchOp;
  rhs: string;
  caseInsensitive?: boolean;
}

export type PredicateVerdict =
  | { ok: true; result: boolean }
  | { ok: false; error: string };

export function evaluatePredicate(p: Predicate): PredicateVerdict {
  const ci = p.caseInsensitive === true;
  const lhs = ci ? p.lhs.toLowerCase() : p.lhs;
  const rhs = ci ? p.rhs.toLowerCase() : p.rhs;
  switch (p.op) {
    case '==':
      return { ok: true, result: lhs === rhs };
    case '!=':
      return { ok: true, result: lhs !== rhs };
    case 'contains':
      return { ok: true, result: lhs.includes(rhs) };
    case 'matches':
      try {
        return {
          ok: true,
          result: new RegExp(p.rhs, ci ? 'i' : '').test(p.lhs),
        };
      } catch (err) {
        return { ok: false, error: `invalid regex: ${(err as Error).message}` };
      }
  }
}
