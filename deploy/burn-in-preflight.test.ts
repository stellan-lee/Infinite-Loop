import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MetricsRegistry, type GaugeSnapshot } from '@/lib/server/metrics';

/*
 * Burn-in pre-flight audit — a static gate for docs/burn-in.md.
 *
 * deploy/prometheus-alerts.yml is wired by hand: every alert names infloop_*
 * metrics and label values that MetricsRegistry must actually emit, and every
 * alert is expected to have a one-to-one entry in docs/runbook.md. None of
 * that is covered by the alerts' own behaviour — a renamed metric, a wrong
 * label value, or a `job=` mismatch passes every other test and then silently
 * never fires in production. burn-in.md Phase 1 flags exactly this trap, and
 * the runbook itself warns that "a runbook step that was never executed is a
 * guess".
 *
 * This file turns that hand audit into a regression gate. It parses the
 * shipped alert rules and asserts every metric reference resolves against the
 * authoritative exposition MetricsRegistry.render() produces, and that the
 * alert set matches the runbook entry set exactly. It is a static name/label
 * check, not a PromQL semantic validator — it catches the broken-wiring class
 * of failure, which is the one that hides behind otherwise-green CI.
 */

const REPO_ROOT = join(import.meta.dir, '..');

function readRepoFile(...segments: string[]): string {
  return readFileSync(join(REPO_ROOT, ...segments), 'utf8');
}

/**
 * The job label the scrape config and InfiniteLoopInstanceDown must agree on.
 * Documented in the prometheus-alerts.yml header and burn-in.md Phase 1.
 */
const EXPECTED_SCRAPE_JOB = 'infinite-loop';

/* ── emitted metric surface ─────────────────────────────────────────────── */

interface EmittedMetrics {
  /** Every metric family name `/api/metrics` declares via `# TYPE`. */
  families: Set<string>;
  /** family → label → the set of label values render() actually emits. */
  labelValues: Map<string, Map<string, Set<string>>>;
}

/**
 * Collect the authoritative set of series MetricsRegistry exposes. A fresh
 * registry pre-seeds every labeled counter, so render() emits one sample line
 * for every metric family and every valid label value — exactly the surface
 * an alert is allowed to name.
 */
function collectEmittedMetrics(): EmittedMetrics {
  const zeroGauges: GaugeSnapshot = {
    runsActive: 0,
    slotPoolInUse: 0,
    slotPoolCapacity: 0,
    slotPoolWaiting: 0,
    queueDepth: 0,
    eventBufferEvents: 0,
    eventBufferLimit: 0,
    costBudgetSpentUsd: 0,
    costBudgetLimitUsd: 0,
    processUptimeSeconds: 0,
    dataDirWritable: true,
    // infloop_backup_last_success_timestamp_seconds is emitted only when this
    // field is non-null (backups configured). The audit must see the family
    // to resolve InfiniteLoopBackupStale's metric reference, so this fixture
    // pins a number — it asserts the family *can* be emitted. That the route
    // actually populates it from a live backup directory is covered separately
    // by app/api/metrics/route.test.ts, not by this static gate.
    backupLastSuccessTimestampSeconds: 0,
  };
  const exposition = new MetricsRegistry().render(zeroGauges);

  const families = new Set<string>();
  const labelValues = new Map<string, Map<string, Set<string>>>();

  for (const line of exposition.split('\n')) {
    // `# TYPE <family> <type>` declares every metric family by name.
    const typeMatch = line.match(/^# TYPE (\S+) /);
    if (typeMatch) {
      families.add(typeMatch[1]);
      continue;
    }
    if (line.startsWith('#') || line.trim() === '') continue;

    // A sample line: `name{label="v",...} value` or `name value`. Record the
    // exact series name as a family too: a histogram emits `_bucket`/`_sum`/
    // `_count` series that carry no `# TYPE` line of their own yet are still
    // legitimate alert targets, so resolving against `# TYPE` names alone
    // would flag an alert on those sub-series as broken when it is not.
    const sample = line.match(/^([a-zA-Z_]\w*)(?:\{([^}]*)\})?\s/);
    if (!sample) continue;
    families.add(sample[1]);
    if (!sample[2]) continue;
    for (const lbl of sample[2].matchAll(/(\w+)="([^"]*)"/g)) {
      const byLabel = labelValues.get(sample[1]) ?? new Map();
      const values = byLabel.get(lbl[1]) ?? new Set<string>();
      values.add(lbl[2]);
      byLabel.set(lbl[1], values);
      labelValues.set(sample[1], byLabel);
    }
  }
  return { families, labelValues };
}

/* ── alert rule parsing ─────────────────────────────────────────────────── */

interface AlertRule {
  name: string;
  expr: string;
}

/**
 * Parse the shipped alert rules into { name, expr } pairs. The file is small,
 * stable, hand-maintained YAML; a line scan that understands its block scalar
 * forms (`expr: |` and `expr: >`) is enough, and avoids pulling in a YAML
 * dependency for a single test. It assumes unquoted plain scalars for alert
 * names and inline exprs, which is how the file is written today.
 */
function parseAlertRules(yaml: string): AlertRule[] {
  const rules: AlertRule[] = [];
  let current: AlertRule | null = null;
  let inExpr = false;
  let exprIndent = 0;

  for (const line of yaml.split('\n')) {
    const alertMatch = line.match(/^\s*- alert:\s*(\S+)/);
    if (alertMatch) {
      if (current) rules.push(current);
      current = { name: alertMatch[1], expr: '' };
      inExpr = false;
      continue;
    }
    if (!current) continue;

    const exprMatch = line.match(/^(\s*)expr:\s*(.*)$/);
    if (exprMatch) {
      exprIndent = exprMatch[1].length;
      const inline = exprMatch[2].trim();
      // `expr: |` / `expr: >` open a block scalar; anything else is inline.
      if (inline && inline !== '|' && inline !== '>') {
        current.expr = inline;
        inExpr = false;
      } else {
        inExpr = true;
      }
      continue;
    }

    if (inExpr) {
      if (line.trim() === '') {
        current.expr += '\n';
        continue;
      }
      const indent = line.length - line.trimStart().length;
      // The block scalar runs while lines stay indented past `expr:` itself.
      if (indent > exprIndent) {
        current.expr += line.trim() + '\n';
        continue;
      }
      inExpr = false; // a sibling key (for:/labels:/...) closed the block
    }
  }
  if (current) rules.push(current);
  return rules;
}

/** Every `infloop_*` metric token referenced anywhere in an expression. */
function metricTokens(expr: string): string[] {
  return [...expr.matchAll(/\binfloop_[a-z0-9_]+/g)].map((m) => m[0]);
}

interface LabelMatcher {
  metric: string;
  label: string;
  values: string[];
}

/** Every `infloop_metric{label="v",...}` selector, with its label matchers. */
function labeledSelectors(expr: string): LabelMatcher[] {
  const out: LabelMatcher[] = [];
  for (const sel of expr.matchAll(/(infloop_[a-z0-9_]+)\s*\{([^}]*)\}/g)) {
    for (const m of sel[2].matchAll(/(\w+)\s*(=~?)\s*"([^"]*)"/g)) {
      // `=~` is a regex match; the shipped alerts only ever use a flat union.
      const values = m[2] === '=~' ? m[3].split('|') : [m[3]];
      out.push({ metric: sel[1], label: m[1], values });
    }
  }
  return out;
}

/** The job label every `up{...}` selector pins. */
function upJobLabels(expr: string): string[] {
  const jobs: string[] = [];
  for (const sel of expr.matchAll(/\bup\s*\{([^}]*)\}/g)) {
    for (const m of sel[1].matchAll(/job\s*=~?\s*"([^"]*)"/g)) {
      jobs.push(m[1]);
    }
  }
  return jobs;
}

/** The `InfiniteLoop*` alert names that have a `## ` section in the runbook. */
function runbookAlertSections(markdown: string): Set<string> {
  const names = new Set<string>();
  for (const m of markdown.matchAll(/^##\s+(InfiniteLoop\w+)/gm)) {
    names.add(m[1]);
  }
  return names;
}

/* ── audit ──────────────────────────────────────────────────────────────── */

const alertRules = parseAlertRules(
  readRepoFile('deploy', 'prometheus-alerts.yml'),
);
const { families: emittedFamilies, labelValues: emittedLabelValues } =
  collectEmittedMetrics();

describe('burn-in pre-flight: prometheus-alerts.yml ↔ /api/metrics', () => {
  it('parses the shipped alert rules into a non-vacuous set', () => {
    // Guards the parser itself: a YAML reformat that broke extraction would
    // otherwise make every downstream check pass trivially. burn-in.md
    // Phase 1 expects eleven rules, so treat that as the floor.
    expect(alertRules.length).toBeGreaterThanOrEqual(11);
    for (const rule of alertRules) {
      expect(rule.name).toMatch(/^InfiniteLoop\w+$/);
      expect(rule.expr.trim().length).toBeGreaterThan(0);
    }
  });

  it('exposes a non-empty metric surface to alert on', () => {
    expect(emittedFamilies.size).toBeGreaterThan(0);
    // Anchor series: if this ever disappears, every run-health alert is dead.
    expect(emittedFamilies.has('infloop_runs_total')).toBe(true);
  });

  it('references only infloop_* metrics that MetricsRegistry emits', () => {
    const unknown: string[] = [];
    const noSeries: string[] = [];
    for (const rule of alertRules) {
      const tokens = metricTokens(rule.expr);
      // Every rule must alert on *some* series. A rule with neither an
      // infloop_* token nor an `up{` selector means the parser, not the
      // rule, is broken — catch that rather than pass it silently.
      if (tokens.length === 0 && !/\bup\s*\{/.test(rule.expr)) {
        noSeries.push(rule.name);
      }
      for (const token of tokens) {
        if (!emittedFamilies.has(token)) {
          unknown.push(`${rule.name} → ${token}`);
        }
      }
    }
    expect(noSeries).toEqual([]);
    expect(unknown).toEqual([]);
  });

  it('matches only label values that MetricsRegistry emits', () => {
    const bad: string[] = [];
    let selectorsChecked = 0;
    for (const rule of alertRules) {
      for (const sel of labeledSelectors(rule.expr)) {
        selectorsChecked++;
        const emitted = emittedLabelValues.get(sel.metric)?.get(sel.label);
        if (!emitted) {
          bad.push(`${rule.name}: ${sel.metric} emits no "${sel.label}" label`);
          continue;
        }
        for (const value of sel.values) {
          if (!emitted.has(value)) {
            bad.push(
              `${rule.name}: ${sel.metric}{${sel.label}="${value}"} — not an emitted value`,
            );
          }
        }
      }
    }
    // Floor guard: the run-failure and webhook alerts carry label matchers,
    // so zero selectors means labeledSelectors silently broke — not that the
    // alerts are clean. Without this the value check could pass vacuously.
    expect(selectorsChecked).toBeGreaterThanOrEqual(2);
    expect(bad).toEqual([]);
  });

  it('pins every up{} selector to the documented scrape job', () => {
    // The `job=` mismatch trap: any scrape-config job other than this name
    // leaves InfiniteLoopInstanceDown permanently inactive. See burn-in.md
    // Phase 1 and the wiring comment in prometheus-alerts.yml.
    const jobs = alertRules.flatMap((rule) => upJobLabels(rule.expr));
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) {
      expect(job).toBe(EXPECTED_SCRAPE_JOB);
    }
  });
});

describe('burn-in pre-flight: prometheus-alerts.yml ↔ docs/runbook.md', () => {
  const runbook = runbookAlertSections(readRepoFile('docs', 'runbook.md'));
  const alertNames = new Set(alertRules.map((rule) => rule.name));

  it('gives every alert rule a runbook entry', () => {
    const missing = [...alertNames].filter((n) => !runbook.has(n)).sort();
    expect(missing).toEqual([]);
  });

  it('keeps no runbook entry for an alert that no longer exists', () => {
    const orphaned = [...runbook].filter((n) => !alertNames.has(n)).sort();
    expect(orphaned).toEqual([]);
  });
});

describe('burn-in pre-flight: deployment artifacts', () => {
  it('health-probes /api/health so an unwritable data dir is caught', () => {
    // burn-in.md Phase 3.5: an unwritable data dir is detected two ways — the
    // Docker healthcheck (this probe → 503 degraded → container unhealthy)
    // and the InfiniteLoopDataDirNotWritable alert on infloop_data_dir_writable.
    const dockerfile = readRepoFile('Dockerfile');
    expect(dockerfile).toContain('HEALTHCHECK');
    expect(dockerfile).toContain('/api/health');
  });

  it('restarts the container so boot crash recovery runs', () => {
    // burn-in.md Phase 3.1: `restart: unless-stopped` is what makes the
    // kill -9 → boot crash-recovery path actually execute.
    expect(readRepoFile('docker-compose.yml')).toMatch(
      /restart:\s*unless-stopped/,
    );
  });

  it('ships a provider overlay that bakes a real provider CLI in', () => {
    // burn-in.md Prerequisites require a real provider CLI on PATH, and the
    // cost-budget phase needs `claude` specifically. Phase 0 builds
    // deploy/Dockerfile.providers to satisfy that. If the overlay is renamed
    // or stops installing `claude`, the burn-in silently loses its provider.
    const overlay = readRepoFile('deploy', 'Dockerfile.providers');
    expect(overlay).toContain('FROM ${BASE_IMAGE}');
    expect(overlay).toContain('claude --version');
  });

  it('keeps the burn-in compose override pointed at the overlay image', () => {
    // burn-in.md Phase 0 brings the stack up with this override so the
    // running container is the provider image, not the orchestrator-only base.
    expect(readRepoFile('deploy', 'docker-compose.burn-in.yml')).toMatch(
      /image:\s*infinite-loop:burn-in/,
    );
  });
});

describe('burn-in pre-flight: observability overlay', () => {
  // The observability overlay (deploy/docker-compose.observability.yml) stands
  // up Prometheus, Alertmanager, and a reverse proxy locally so burn-in
  // Phase 0's proxy check and Phase 1 can be driven without a remote staging
  // host. Its config files must stay wired to each other and to
  // prometheus-alerts.yml — a drifted mount path or job name is the same
  // silent-never-fires failure class the alert audit above guards against, so
  // it belongs in the same static gate.
  const compose = readRepoFile('deploy', 'docker-compose.observability.yml');
  const promConfig = readRepoFile('deploy', 'prometheus.yml');

  it('defines the prometheus, alertmanager, and proxy services', () => {
    for (const svc of ['prometheus:', 'alertmanager:', 'proxy:']) {
      expect(compose).toContain(svc);
    }
  });

  it('loads prometheus rules from the path the overlay mounts them to', () => {
    // The overlay bind-mounts the shipped alert rules to a container path;
    // prometheus.yml must reference that exact path under `rule_files:`, or
    // the ten alerts silently never load.
    const mount = compose.match(/prometheus-alerts\.yml:(\/\S+?):ro/);
    expect(mount).not.toBeNull();
    const rulePath = mount![1];
    expect(promConfig).toMatch(/rule_files:/);
    expect(promConfig).toContain(rulePath);
  });

  it('scrapes /api/metrics under the documented job name', () => {
    // Same job-name contract the up{} audit pins: the scrape job must be
    // `infinite-loop` or InfiniteLoopInstanceDown can never fire.
    expect(promConfig).toContain('metrics_path: /api/metrics');
    expect(promConfig).toMatch(
      new RegExp(`job_name:\\s*${EXPECTED_SCRAPE_JOB}\\b`),
    );
  });

  it('reads the scrape token from the file the overlay entrypoint writes', () => {
    // /api/metrics is authenticated. The compose entrypoint materializes
    // INFLOOP_API_TOKEN into a file; prometheus.yml must point its
    // credentials_file at that same path, or every scrape gets 401 and the
    // target reads as down.
    const tokenWrite = compose.match(/>\s*(\/\S*scrape-token)\b/);
    expect(tokenWrite).not.toBeNull();
    expect(promConfig).toContain(`credentials_file: ${tokenWrite![1]}`);
  });
});
