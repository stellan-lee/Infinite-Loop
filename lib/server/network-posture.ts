/*
 * Network-posture gate for the server entry point.
 *
 * Infinite Loop executes arbitrary code — Script nodes (TS/Python),
 * Condition nodes with `kind: command`, and Agent nodes that spawn
 * provider CLIs. A server that is reachable from the network without
 * authentication is therefore unauthenticated remote code execution.
 *
 * `evaluatePosture` is the fail-closed gate `server.ts` consults before
 * binding: it refuses to start a network-reachable, unauthenticated
 * server unless the operator explicitly opts in via INFLOOP_ALLOW_INSECURE.
 *
 * This module is pure (no env reads, no I/O) so the security-critical
 * decision matrix is fully unit-testable; `server.ts` resolves the
 * environment and prints the messages.
 */

/** Bare loopback host literals. `127.x.x.x` is matched separately. */
const LOOPBACK_LITERALS = new Set(['localhost', '::1', '[::1]']);

/**
 * True only for hosts we can *positively* recognise as loopback-only:
 * `localhost`, the IPv6 loopback `::1` (bare or bracketed), and any
 * address in `127.0.0.0/8`.
 *
 * Everything else — `0.0.0.0`, `::`, an empty string (all of which bind
 * every interface), a specific LAN IP, a bare hostname, or an exotic form
 * such as an IPv4-mapped IPv6 address or fully-expanded IPv6 loopback
 * (`0:0:0:0:0:0:0:1`) — is treated as network-reachable. The bias is
 * deliberate: this check is security-load-bearing, so an unrecognised host
 * must fail towards "exposed", never towards "safe". Do not "fix" the
 * misses by broadening the match — broaden the tests instead.
 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase();
  if (h === '') return false; // empty HOST binds all interfaces
  if (LOOPBACK_LITERALS.has(h)) return true;
  return isIpv4Loopback(h);
}

/** True for a well-formed dotted-quad inside `127.0.0.0/8`. */
function isIpv4Loopback(host: string): boolean {
  const m = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  return m.slice(1, 4).every((octet) => Number(octet) <= 255);
}

/** Inputs for {@link evaluatePosture}; all resolved from the environment by the caller. */
export interface PostureInput {
  /** Resolved bind address (`process.env.HOST` or the default). */
  host: string;
  /** Whether `INFLOOP_API_TOKEN` is set — mirrors `requireAuth`'s open-mode check. */
  authEnabled: boolean;
  /** Whether the operator set `INFLOOP_ALLOW_INSECURE=1`. */
  allowInsecure: boolean;
}

/**
 * A posture decision. `ok: false` means the server must not start; `warning`
 * (when non-null) is a message the caller should surface even though startup
 * is allowed to proceed.
 */
export type PostureDecision =
  | { ok: true; warning: string | null }
  | { ok: false; error: string };

/**
 * Decide whether the server may start, given where it would bind and how it
 * is authenticated. See the per-case messages below for the exact policy.
 */
export function evaluatePosture(input: PostureInput): PostureDecision {
  // Loopback-only: reachable solely from this machine. Always safe to start.
  if (isLoopbackHost(input.host)) {
    return { ok: true, warning: null };
  }

  // From here on the server is reachable from the network.
  if (input.authEnabled) {
    // `/api/*` is token-gated, but webhook ingress deliberately is not.
    return { ok: true, warning: webhookResidualNote(input.host) };
  }

  // Network-reachable AND unauthenticated.
  if (input.allowInsecure) {
    return { ok: true, warning: insecureBanner(input.host) };
  }
  return { ok: false, error: refusal(input.host) };
}

/** Render a host for display, spelling out the empty-string case. */
function showHost(host: string): string {
  return host === '' ? '"" (empty — binds all interfaces)' : host;
}

/** Fatal message: network-reachable + unauthenticated, no opt-in. */
function refusal(host: string): string {
  return [
    'Refusing to start: Infinite Loop would bind a network-reachable address',
    `  (HOST=${showHost(host)}) with no authentication.`,
    '',
    '  Infinite Loop executes arbitrary code (Script, Condition-command, and',
    '  Agent nodes), so this would expose unauthenticated remote code execution',
    '  to everyone who can reach this port.',
    '',
    '  Fix it with ONE of:',
    '',
    '    1. Bind to loopback only (the default):',
    '         unset HOST            # or HOST=127.0.0.1',
    '',
    '    2. Require an API token:',
    '         INFLOOP_API_TOKEN=$(openssl rand -hex 32)',
    '',
    '    3. Acknowledge the risk and start anyway (trusted networks only):',
    '         INFLOOP_ALLOW_INSECURE=1',
    '',
    '  See docs/security.md.',
  ].join('\n');
}

/** Loud banner: started network-reachable + unauthenticated via the opt-in. */
function insecureBanner(host: string): string {
  const rule = '█'.repeat(70);
  return [
    rule,
    '  ⚠  INSECURE MODE — network-reachable with NO authentication',
    '',
    `  Infinite Loop is bound to ${showHost(host)} and anyone who can reach`,
    '  this port can execute arbitrary code on this machine.',
    '',
    '  Enabled by INFLOOP_ALLOW_INSECURE=1. Use only on a fully trusted',
    '  network. Set INFLOOP_API_TOKEN to require a bearer token instead.',
    rule,
  ].join('\n');
}

/** Informational note: token-gated but webhook ingress stays open. */
function webhookResidualNote(host: string): string {
  return [
    `Note: bound to a network-reachable address (${showHost(host)}).`,
    '  INFLOOP_API_TOKEN gates /api/* but NOT webhook ingress',
    '  (/api/webhook/<triggerId>) — treat trigger URLs as secrets.',
    '  See docs/security.md.',
  ].join('\n');
}
