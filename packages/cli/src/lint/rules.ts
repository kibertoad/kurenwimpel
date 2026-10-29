import type { FlagDefinition, Rollout, TargetingRule } from '@kurenwimpel/core';

export type LintRule = 'expired' | 'fully-rolled-out' | 'permanently-off' | 'missing-owner';

export type LintSeverity = 'error' | 'warning';

export interface LintFinding {
  readonly flag: string;
  readonly rule: LintRule;
  readonly severity: LintSeverity;
  readonly message: string;
  /** `fully-rolled-out`: the one variant every path serves. */
  readonly variant?: string;
  /** `expired`: the `lifecycle.expiresOn` date. */
  readonly expiresOn?: string;
  /** `permanently-off` under `--since-git`: when the commit that switched it off was made, ISO 8601. */
  readonly offSince?: string;
  /** Whole days between `offSince` and the lint time. */
  readonly offDays?: number;
}

export interface LintOptions {
  readonly now: Date;
  readonly requireOwner: boolean;
  /** Flag key to when it was switched off, from `git log`. Absent without `--since-git`. */
  readonly offSince?: ReadonlyMap<string, string>;
}

const DAY_MS = 86_400_000;

/** Every finding for every flag, in ruleset order and then in rule order. */
export function lintFlags(flags: readonly FlagDefinition[], options: LintOptions): LintFinding[] {
  return flags.flatMap((flag) => lintFlag(flag, options));
}

function lintFlag(flag: FlagDefinition, options: LintOptions): LintFinding[] {
  const findings: LintFinding[] = [];
  if (!isLongLived(flag)) {
    const expired = expiredFinding(flag, options.now);
    if (expired !== undefined) findings.push(expired);
    findings.push(...(flag.enabled ? rolledOut(flag) : [switchedOff(flag, options)]));
  }
  if (options.requireOwner && flag.lifecycle?.owner === undefined) {
    findings.push({
      flag: flag.key,
      rule: 'missing-owner',
      severity: 'warning',
      message: 'has no lifecycle.owner; name the team that will remove it',
    });
  }
  return findings;
}

/** `ops` and `permission` flags are meant to stay, so the staleness rules skip them. */
function isLongLived(flag: FlagDefinition): boolean {
  const kind = flag.lifecycle?.kind;
  return kind === 'ops' || kind === 'permission';
}

function expiredFinding(flag: FlagDefinition, now: Date): LintFinding | undefined {
  const expiresOn = flag.lifecycle?.expiresOn;
  const today = now.toISOString().slice(0, 10);
  if (expiresOn === undefined || expiresOn >= today) return undefined;
  return {
    flag: flag.key,
    rule: 'expired',
    severity: 'error',
    expiresOn,
    message: `expired on ${expiresOn}; remove it, or move lifecycle.expiresOn if it has to stay`,
  };
}

function rolledOut(flag: FlagDefinition): LintFinding[] {
  const served = [...servedVariants(flag)];
  const variant = served[0];
  if (served.length !== 1 || variant === undefined) return [];
  return [
    {
      flag: flag.key,
      rule: 'fully-rolled-out',
      severity: 'warning',
      variant,
      message: `serves "${variant}" to everyone outside its targets; remove it and keep that code path`,
    },
  ];
}

function switchedOff(flag: FlagDefinition, options: LintOptions): LintFinding {
  const since = options.offSince?.get(flag.key);
  const finding = {
    flag: flag.key,
    rule: 'permanently-off',
    severity: 'warning',
  } as const;
  if (since === undefined) {
    return { ...finding, message: 'is switched off; remove it and its code path, or switch it on' };
  }
  const offDays = Math.max(0, Math.floor((options.now.getTime() - Date.parse(since)) / DAY_MS));
  return {
    ...finding,
    offSince: since,
    offDays,
    message: `has been switched off since ${since.slice(0, 10)} (${offDays} days); remove it and its code path, or switch it on`,
  };
}

/**
 * The variants an enabled flag can serve to a context no target lists: a failed
 * prerequisite, the allocation gate, each rule, then the fallthrough. A rule
 * without conditions matches everyone, so nothing after it is reachable.
 */
export function servedVariants(flag: FlagDefinition): ReadonlySet<string> {
  const served = new Set<string>();
  if ((flag.prerequisites?.length ?? 0) > 0) served.add(flag.offVariant);
  if (flag.allocation !== undefined && flag.allocation.percent < 100) {
    served.add(flag.defaultVariant);
  }
  for (const rule of flag.rules ?? []) {
    for (const variant of ruleVariants(rule, flag.defaultVariant)) served.add(variant);
    if (rule.conditions.length === 0) return served;
  }
  for (const variant of liveVariants(flag.rollout) ?? [flag.defaultVariant]) served.add(variant);
  return served;
}

function ruleVariants(rule: TargetingRule, defaultVariant: string): readonly string[] {
  if (rule.rollout !== undefined) return liveVariants(rule.rollout) ?? [defaultVariant];
  return [rule.variant ?? defaultVariant];
}

/** The variants of a split's weighted buckets, or `undefined` for a split parked at zero. */
function liveVariants(rollout: Rollout | undefined): string[] | undefined {
  if (rollout === undefined) return undefined;
  const buckets = 'buckets' in rollout ? rollout.buckets : rollout;
  const live = buckets.filter((bucket) => bucket.weight > 0).map((bucket) => bucket.variant);
  return live.length === 0 ? undefined : live;
}
