import { z } from 'zod';

// App settings that are edited in the admin panel instead of the environment. Each key has one definition: its schema,
// its default and whether it is a secret (encrypted at rest, never sent back to the browser). Adding a setting means
// adding one entry here; the API and the storage pick it up.

export const SETTING_DEFS = {
  'agent.enabled': { schema: z.boolean(), default: false, secret: false },
  'agent.baseUrl': {
    schema: z
      .string()
      .trim()
      .max(300)
      .refine((v) => {
        try {
          const u = new URL(v);
          return (u.protocol === 'https:' || u.protocol === 'http:') && u.username === '' && u.password === '';
        } catch {
          return false;
        }
      }, 'must be an http(s) URL without embedded credentials'),
    default: 'https://api.openai.com/v1',
    secret: false,
  },
  'agent.apiKey': {
    schema: z
      .string()
      .trim()
      .min(8, 'looks too short')
      .max(400)
      .refine((v) => !/\s/.test(v), 'must not contain whitespace'),
    default: null,
    secret: true,
  },
  /** No default: model names differ per provider, so it is picked from the provider's own list. */
  'agent.model': { schema: z.string().trim().min(1).max(100), default: null, secret: false },
  /** When true the assistant runs its state-changing tools (silence, acknowledge, ...) without asking. Never applies to danger tools. */
  'agent.autoApprove': { schema: z.boolean(), default: false, secret: false },
  'agent.maxSteps': { schema: z.number().int().min(1).max(20), default: 8, secret: false },
  /** Free text the assistant always sees: strategy notes, house rules, what you want it to know. */
  'agent.notes': { schema: z.string().max(20_000), default: '', secret: false },
} as const;

export type SettingKey = keyof typeof SETTING_DEFS;
export const SETTING_KEYS = Object.keys(SETTING_DEFS) as SettingKey[];

export type SettingValue<K extends SettingKey> = z.output<(typeof SETTING_DEFS)[K]['schema']>;

export const isSettingKey = (k: string): k is SettingKey => Object.hasOwn(SETTING_DEFS, k);
export const isSecretKey = (k: SettingKey): boolean => SETTING_DEFS[k].secret;
