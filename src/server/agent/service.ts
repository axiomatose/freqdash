import type { AgentSettings, AgentDeps } from './loop';
import { getSetting } from '../settings';
import { krakenMode } from '../poller/mode';
import { getStore } from '../state/store';
import { defaultToolContext } from './tools';

/** Effective assistant settings, or the reason it cannot run. */
export function loadAgentSettings():
  { ok: true; settings: AgentSettings } | { ok: false; reason: 'disabled' | 'no-key' | 'no-model' } {
  if (!getSetting('agent.enabled')) return { ok: false, reason: 'disabled' };
  const apiKey = getSetting('agent.apiKey');
  if (apiKey === null) return { ok: false, reason: 'no-key' };
  const model = getSetting('agent.model');
  if (model === null) return { ok: false, reason: 'no-model' };
  return {
    ok: true,
    settings: {
      baseUrl: getSetting('agent.baseUrl'),
      apiKey,
      model,
      autoApprove: getSetting('agent.autoApprove'),
      maxSteps: getSetting('agent.maxSteps'),
      notes: getSetting('agent.notes'),
    },
  };
}

export function agentDeps(settings: AgentSettings, by: string | null): AgentDeps {
  return {
    settings,
    ctx: defaultToolContext(null, by),
    prompt: () => {
      const state = getStore().get();
      const { mode, reason } = krakenMode(state, Date.now());
      return { mode, modeReason: reason, botNames: Object.values(state.bots).map((b) => b.name) };
    },
  };
}
