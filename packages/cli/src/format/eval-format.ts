import type { Explanation, PrerequisiteOutcomeReport } from '../eval/explain.js';
import { inline } from './words.js';

export function renderExplanations(results: readonly Explanation[]): string {
  return `${results.map((result) => renderExplanation(result)).join('\n')}\n`;
}

function renderExplanation(result: Explanation): string {
  const served =
    result.variant === undefined
      ? `${result.key}: no value`
      : `${result.key} = ${inline(result.value)} (variant ${result.variant})`;

  const lines = [served, `  reason: ${result.reason}`];
  if (result.ruleId !== undefined) lines.push(`  rule: ${result.ruleId}`);
  if (result.failedPrerequisite !== undefined) {
    lines.push(`  failed prerequisite: ${result.failedPrerequisite}`);
  }
  if (result.errorCode !== undefined) {
    const detail = result.errorMessage === undefined ? '' : `, ${result.errorMessage}`;
    lines.push(`  error: ${result.errorCode}${detail}`);
  }
  if (result.prerequisites.length > 0) {
    lines.push('  prerequisites:');
    for (const outcome of result.prerequisites) lines.push(`    ${renderOutcome(outcome)}`);
  }
  return lines.join('\n');
}

function renderOutcome(outcome: PrerequisiteOutcomeReport): string {
  const required = `needs ${outcome.requiredVariants.join(' or ')}`;
  if (outcome.reason === undefined) return `${outcome.flag}: ${outcome.status} (${required})`;

  const served = outcome.variant === undefined ? 'no variant' : `serving ${outcome.variant}`;
  return `${outcome.flag}: ${outcome.status} (${required}; ${served}, ${outcome.reason})`;
}
