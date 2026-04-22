import type { ClassificationResult, RuleDecision } from '../domain/types.js';

export function buildRuleDecision(_classification: ClassificationResult): RuleDecision {
  return {
    outcome: 'allow',
    requiredArtifacts: ['markdown'],
    reason: null,
  };
}
