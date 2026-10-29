import type { FlagParseIssue } from '@kurenwimpel/core';

/** The document has parse issues and `allowIssues` was not set. Nothing was written. */
export class RulesetIssuesError extends Error {
  override readonly name = 'RulesetIssuesError';
  readonly issues: readonly FlagParseIssue[];

  constructor(issues: readonly FlagParseIssue[]) {
    super(`the ruleset has ${issues.length} parse issue(s); refusing to publish`);
    this.issues = issues;
  }
}
