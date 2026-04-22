import { describe, expect, it } from 'vitest';

import { buildRuleDecision } from '../src/rules/rule-decision.js';

describe('buildRuleDecision', () => {
  it('returns allow + markdown for the phase 0 fake flow', () => {
    const result = buildRuleDecision({ tags: ['docs'] });

    expect(result).toEqual({
      outcome: 'allow',
      requiredArtifacts: ['markdown'],
      reason: null,
    });
  });
});
