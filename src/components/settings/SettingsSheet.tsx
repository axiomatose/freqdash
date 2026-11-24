'use client';

import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, SkeletonRows, TimeAgo } from '@/components/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ResponsiveSheet } from '@/components/ui/responsive-sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  useAddMemory,
  useDeleteMemory,
  useMemories,
  useModelList,
  useSettings,
  useTestAgent,
  useUpdateSettings,
  type ConnectionTest,
  type SettingsData,
  type SettingsPatch,
} from '@/lib/client/agent';
import { AccountTab } from './AccountTab';
import { NotificationsTab } from './NotificationsTab';

export type SettingsTab = 'assistant' | 'memories' | 'notifications' | 'account';

interface Form {
  enabled: boolean;
  baseUrl: string;
  model: string;
  autoApprove: boolean;
  maxSteps: string;
  notes: string;
}

export const formFrom = (d: SettingsData): Form => ({
  enabled: d.values['agent.enabled'] === true,
  baseUrl: String(d.values['agent.baseUrl'] ?? ''),
  model: String(d.values['agent.model'] ?? ''),
  autoApprove: d.values['agent.autoApprove'] === true,
  maxSteps: String(d.values['agent.maxSteps'] ?? 8),
  notes: String(d.values['agent.notes'] ?? ''),
});

/** Only what changed, in the shape the API takes. `apiKey`: a string sets it, null removes it, undefined keeps it. */
export function buildPatch(saved: Form, form: Form, apiKey: string | null | undefined): SettingsPatch {
  const patch: SettingsPatch = {};
  if (form.enabled !== saved.enabled) patch['agent.enabled'] = form.enabled;
  if (form.baseUrl.trim() !== saved.baseUrl) patch['agent.baseUrl'] = form.baseUrl.trim();
  if (form.model.trim() !== saved.model) patch['agent.model'] = form.model.trim() === '' ? null : form.model.trim();
  if (form.autoApprove !== saved.autoApprove) patch['agent.autoApprove'] = form.autoApprove;
  if (form.maxSteps !== saved.maxSteps) patch['agent.maxSteps'] = Number(form.maxSteps);
  if (form.notes !== saved.notes) patch['agent.notes'] = form.notes;
  if (apiKey !== undefined) patch['agent.apiKey'] = apiKey === null ? null : apiKey.trim();
  return patch;
}

/** A value that follows `value` after it has stopped changing for `ms` (so typing a URL or key does not hit the provider per keystroke). */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

const isHttpUrl = (v: string): boolean => {
  try {
    const u = new URL(v);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint ? <p className="text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

function ToggleRow({
  id,
  label,
  hint,
  checked,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <Label htmlFor={id}>{label}</Label>
        <p className="mt-1 text-xs text-muted">{hint}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} aria-label={label} />
    </div>
  );
}

function AssistantTab({ data }: { data: SettingsData }) {
  const saved = formFrom(data);
  const keySet = data.secretsSet['agent.apiKey'] === true;
  const [form, setForm] = useState<Form>(saved);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [replacing, setReplacing] = useState(false);
  const [test, setTest] = useState<ConnectionTest | null>(null);
  const update = useUpdateSettings();
  const tester = useTestAgent();

  // The model is chosen from what the provider says it has. The list reloads when the endpoint or key changes.
  const typedKey = apiKey.trim();
  const hasKey = !removeKey && (typedKey.length >= 8 || (keySet && typedKey === ''));
  const base = useDebounced(form.baseUrl.trim(), 600);
  const listKey = useDebounced(typedKey.length >= 8 ? typedKey : '', 600);
  // Both the key and the URL the request uses are the settled ones, so it never goes out half-typed.
  const canList = !removeKey && (listKey !== '' || (keySet && typedKey === ''));
  const models = useModelList({ baseUrl: base, apiKey: listKey, enabled: canList && isHttpUrl(base) });
  const list = models.data?.ok ? models.data.models : null;
  const listError = models.data && !models.data.ok ? models.data.error : models.isError ? models.error.message : null;

  const keyChange: string | null | undefined = removeKey ? null : apiKey.trim() !== '' ? apiKey : undefined;
  const patch = buildPatch(saved, form, keyChange);
  const dirty = Object.keys(patch).length > 0;
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  // A model name belongs to one provider: changing the endpoint drops the old choice (going back restores it).
  const setBaseUrl = (v: string) =>
    setForm((f) => ({ ...f, baseUrl: v, model: v.trim() === saved.baseUrl ? saved.model : '' }));

  const save = () =>
    update.mutate(patch, {
      onSuccess: () => toast.success('Settings saved'),
      onError: (e) => toast.error(e.message),
    });

  const runTest = () => {
    setTest(null);
    tester.mutate(
      { baseUrl: form.baseUrl.trim(), model: form.model.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) },
      { onSuccess: setTest, onError: (e) => setTest({ ok: false, error: e.message }) },
    );
  };

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={(e) => {
        e.preventDefault();
        if (dirty) save();
      }}
    >
      <p className="text-sm text-muted">
        The assistant answers questions about your bots, strategies and Kraken account, and can act in freqdash. It
        talks to any OpenAI-compatible API. To answer, it reads your live data (balances, trades, findings, strategy
        code), and that data is sent to the API you configure.
      </p>
      <ToggleRow
        id="agent-enabled"
        label="Enable the assistant"
        hint="Turns on the assistant pane. Off keeps everything else exactly as it is."
        checked={form.enabled}
        onChange={(v) => set('enabled', v)}
      />

      <Field
        id="agent-base"
        label="API base URL"
        hint="OpenAI is https://api.openai.com/v1. Any compatible endpoint works."
      >
        <Input
          id="agent-base"
          value={form.baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
        />
      </Field>

      <Field
        id="agent-key"
        label="API key"
        hint="Stored encrypted. It is never shown again and never leaves the server."
      >
        {keySet && !replacing && !removeKey ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="positive">
              <CircleCheck aria-hidden /> Key saved
            </Badge>
            <Button type="button" variant="outline" size="sm" onClick={() => setReplacing(true)}>
              Replace
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRemoveKey(true)}>
              Remove
            </Button>
          </div>
        ) : removeKey ? (
          <div className="flex items-center gap-2 text-sm">
            <span className="text-warning">The key will be removed when you save.</span>
            <Button type="button" variant="ghost" size="sm" onClick={() => setRemoveKey(false)}>
              Undo
            </Button>
          </div>
        ) : (
          <Input
            id="agent-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk-…"
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>

      <Field
        id="agent-model"
        label="Model"
        hint={
          !hasKey
            ? 'Add an API key to load the models this provider offers.'
            : models.isFetching
              ? 'Loading the provider’s models…'
              : listError
                ? `Could not load the model list (${listError}). Type the model name instead.`
                : list && list.length === 0
                  ? 'The provider listed no models. Type the model name instead.'
                  : undefined
        }
      >
        {list && list.length > 0 ? (
          <div className="flex items-center gap-2">
            <Select value={form.model || undefined} onValueChange={(v) => set('model', v)}>
              <SelectTrigger id="agent-model" className="min-w-0 flex-1" aria-label="Model">
                <SelectValue placeholder="Choose a model" />
              </SelectTrigger>
              <SelectContent>
                {form.model !== '' && !list.includes(form.model) ? (
                  <SelectItem value={form.model}>{form.model} (not in the list)</SelectItem>
                ) : null}
                {list.map((m) => (
                  <SelectItem key={m} value={m}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Reload models"
              onClick={() => void models.refetch()}
              disabled={models.isFetching}
            >
              <RefreshCw aria-hidden className={models.isFetching ? 'animate-spin' : undefined} />
            </Button>
          </div>
        ) : (
          <Input
            id="agent-model"
            value={form.model}
            onChange={(e) => set('model', e.target.value)}
            autoComplete="off"
            spellCheck={false}
            placeholder={models.isFetching ? 'Loading…' : 'model name'}
          />
        )}
      </Field>

      <ToggleRow
        id="agent-auto"
        label="Run actions without asking"
        hint="Silencing findings and acknowledging orders run straight away. Resetting the killswitch always asks."
        checked={form.autoApprove}
        onChange={(v) => set('autoApprove', v)}
      />

      <Field
        id="agent-steps"
        label="Max steps per answer"
        hint="How many model and tool rounds one answer may take (1 to 20)."
      >
        <Input
          id="agent-steps"
          type="number"
          min={1}
          max={20}
          value={form.maxSteps}
          onChange={(e) => set('maxSteps', e.target.value)}
          className="w-28"
        />
      </Field>

      <Field
        id="agent-notes"
        label="Notes for the assistant"
        hint="Always in its context: strategy notes, house rules, what to watch for. Not secrets."
      >
        <Textarea
          id="agent-notes"
          value={form.notes}
          onChange={(e) => set('notes', e.target.value)}
          rows={6}
          maxLength={20000}
        />
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" disabled={!dirty || update.isPending}>
          {update.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null} Save
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={runTest}
          disabled={tester.isPending || form.model.trim() === '' || (!keySet && apiKey.trim() === '')}
        >
          {tester.isPending ? <Loader2 aria-hidden className="animate-spin" /> : null} Test connection
        </Button>
        {test ? (
          <span
            role="status"
            className={`flex items-center gap-1.5 text-sm ${test.ok ? 'text-positive' : 'text-critical-fg'}`}
          >
            {test.ok ? <CircleCheck aria-hidden className="size-4" /> : <CircleX aria-hidden className="size-4" />}
            {test.ok ? `Connected${test.reply ? ` (“${test.reply}”)` : ''}` : test.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}

function MemoriesTab({ active }: { active: boolean }) {
  const q = useMemories(active);
  const add = useAddMemory();
  const del = useDeleteMemory();
  const [text, setText] = useState('');
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted">
        Things the assistant remembers between chats. It saves these itself when something is worth keeping; you can add
        or delete any of them.
      </p>
      <form
        className="flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() === '') return;
          add.mutate(
            { content: text.trim() },
            { onSuccess: () => setText(''), onError: (er) => toast.error(er.message) },
          );
        }}
      >
        <Label htmlFor="memory-new">Add a memory</Label>
        <Textarea id="memory-new" rows={2} value={text} maxLength={1500} onChange={(e) => setText(e.target.value)} />
        <div>
          <Button type="submit" size="sm" disabled={text.trim() === '' || add.isPending}>
            Add
          </Button>
        </div>
      </form>
      {q.data === undefined ? (
        <SkeletonRows rows={3} />
      ) : q.data.memories.length === 0 ? (
        <EmptyState title="No memories yet" compact />
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border bg-surface" aria-label="Memories">
          {q.data.memories.map((m) => (
            <li key={m.id} className="flex items-start gap-3 p-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="break-words">{m.content}</p>
                <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted">
                  <TimeAgo at={m.updatedAt} />
                  {m.tags.map((t) => (
                    <Badge key={t} variant="muted">
                      {t}
                    </Badge>
                  ))}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete memory ${m.id}`}
                disabled={del.isPending}
                onClick={() => del.mutate(m.id, { onError: (er) => toast.error(er.message) })}
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function SettingsSheet({
  open,
  tab,
  onTabChange,
  onOpenChange,
}: {
  open: boolean;
  tab: SettingsTab;
  onTabChange: (t: SettingsTab) => void;
  onOpenChange: (o: boolean) => void;
}) {
  const settings = useSettings(open);
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Settings"
      description="Admin settings, stored in the database. Changes apply immediately."
      mobileSize="full"
    >
      <Tabs value={tab} onValueChange={(v) => onTabChange(v as SettingsTab)}>
        <TabsList>
          <TabsTrigger value="assistant">Assistant</TabsTrigger>
          <TabsTrigger value="memories">Memories</TabsTrigger>
          <TabsTrigger value="notifications">Notifications</TabsTrigger>
          <TabsTrigger value="account">Account</TabsTrigger>
        </TabsList>
        <TabsContent value="assistant" className="mt-5">
          {settings.data === undefined ? (
            settings.isError ? (
              <p className="text-sm text-critical-fg">{settings.error.message}</p>
            ) : (
              <SkeletonRows rows={6} />
            )
          ) : (
            <AssistantTab key={settings.data.updatedAt ?? 0} data={settings.data} />
          )}
        </TabsContent>
        <TabsContent value="memories" className="mt-5">
          <MemoriesTab active={open && tab === 'memories'} />
        </TabsContent>
        <TabsContent value="notifications" className="mt-5">
          <NotificationsTab active={open && tab === 'notifications'} />
        </TabsContent>
        <TabsContent value="account" className="mt-5">
          <AccountTab active={open && tab === 'account'} />
        </TabsContent>
      </Tabs>
    </ResponsiveSheet>
  );
}
