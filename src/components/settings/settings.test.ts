import { describe, expect, it } from 'vitest';
import { buildPatch, formFrom } from './SettingsSheet';

const data = {
  values: {
    'agent.enabled': false,
    'agent.baseUrl': 'https://api.openai.com/v1',
    'agent.model': 'glm-4.6',
    'agent.autoApprove': false,
    'agent.maxSteps': 8,
    'agent.notes': '',
  },
  secretsSet: { 'agent.apiKey': false },
  updatedAt: null,
};

describe('settings form', () => {
  const saved = formFrom(data);

  it('starts from the saved values', () => {
    expect(saved).toEqual({
      enabled: false,
      baseUrl: 'https://api.openai.com/v1',
      model: 'glm-4.6',
      autoApprove: false,
      maxSteps: '8',
      notes: '',
    });
  });

  it('patches only what changed', () => {
    expect(buildPatch(saved, saved, undefined)).toEqual({});
    expect(buildPatch(saved, { ...saved, enabled: true, model: ' gpt-4.1-mini ', maxSteps: '12' }, undefined)).toEqual({
      'agent.enabled': true,
      'agent.model': 'gpt-4.1-mini',
      'agent.maxSteps': 12,
    });
  });

  it('clearing the model (the endpoint changed) removes it instead of saving an empty name', () => {
    expect(buildPatch(saved, { ...saved, model: '' }, undefined)).toEqual({ 'agent.model': null });
    const unset = formFrom({ ...data, values: { ...data.values, 'agent.model': '' } });
    expect(buildPatch(unset, { ...unset, model: '' }, undefined)).toEqual({});
  });

  it('a key is set with a string, removed with null, kept with undefined', () => {
    expect(buildPatch(saved, saved, ' sk-new-key-123456 ')).toEqual({ 'agent.apiKey': 'sk-new-key-123456' });
    expect(buildPatch(saved, saved, null)).toEqual({ 'agent.apiKey': null });
    expect(buildPatch(saved, saved, undefined)).not.toHaveProperty('agent.apiKey');
  });
});
