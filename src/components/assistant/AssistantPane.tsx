'use client';

import { useEffect, useRef, useState } from 'react';
import { History, MessageSquarePlus, PanelRightClose, Settings, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { EmptyState, TimeAgo } from '@/components/data';
import { useSettingsPanel } from '@/components/settings/SettingsProvider';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ResponsiveSheet } from '@/components/ui/responsive-sheet';
import { cn } from '@/components/ui/utils';
import { useAgentStatus, useConversations, useDeleteConversation } from '@/lib/client/agent';
import { useAssistantPane } from './AssistantProvider';
import { Composer } from './Composer';
import { Markdown } from './Markdown';
import type { ChatItem } from './model';
import { Spark } from './Spark';
import { ThinkingIndicator } from './ThinkingIndicator';
import { ToolCard } from './ToolCard';
import { useAssistantChat } from './useAssistantChat';

const SUGGESTIONS = [
  'Is anything wrong right now?',
  'How are the bots doing?',
  "What's my Kraken balance and how is it allocated?",
  'How much are fees costing the strategies?',
  'What do you remember about my setup?',
];

function Message({
  item,
  decision,
  onDecide,
}: {
  item: ChatItem;
  decision: 'approve' | 'deny' | undefined;
  onDecide: (id: string, d: 'approve' | 'deny') => void;
}) {
  if (item.kind === 'user') {
    return (
      <div className="fd-rise flex justify-end">
        <div
          data-testid="user-message"
          className="max-w-[90%] rounded-2xl rounded-br-md bg-surface-2 px-3.5 py-2 text-sm leading-relaxed break-words whitespace-pre-wrap"
        >
          {item.text}
        </div>
      </div>
    );
  }
  if (item.kind === 'assistant') {
    return (
      <div className="fd-rise flex gap-2.5" data-testid="assistant-message">
        <Spark className="mt-0.5 size-5 shrink-0" />
        <Markdown text={item.text} streaming={item.streaming} />
      </div>
    );
  }
  if (item.kind === 'tool') {
    return (
      <div className="pl-8">
        <ToolCard item={item} decision={decision} onDecide={onDecide} />
      </div>
    );
  }
  return (
    <div
      role="alert"
      className="fd-rise ml-8 rounded-xl border border-critical/50 bg-critical/10 px-3 py-2 text-sm text-critical-fg"
    >
      {item.message}
    </div>
  );
}

function HistorySheet({
  open,
  onOpenChange,
  onPick,
  onNew,
  activeId,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onPick: (id: string) => void;
  onNew: () => void;
  activeId: string | null;
}) {
  const q = useConversations();
  const del = useDeleteConversation();
  return (
    <ResponsiveSheet
      open={open}
      onOpenChange={onOpenChange}
      title="Chats"
      description="Your earlier conversations with the assistant."
      footer={
        <Button
          onClick={() => {
            onNew();
            onOpenChange(false);
          }}
        >
          <MessageSquarePlus aria-hidden /> New chat
        </Button>
      }
    >
      {q.data === undefined ? null : q.data.conversations.length === 0 ? (
        <EmptyState title="No chats yet" compact />
      ) : (
        <ul className="flex flex-col gap-1" aria-label="Chats">
          {q.data.conversations.map((c) => (
            <li key={c.id} className="group flex items-center gap-1">
              <button
                type="button"
                onClick={() => {
                  onPick(c.id);
                  onOpenChange(false);
                }}
                aria-current={c.id === activeId ? 'true' : undefined}
                className={cn(
                  'min-w-0 flex-1 rounded-lg px-3 py-2 text-left outline-none hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent',
                  c.id === activeId && 'bg-surface-2',
                )}
              >
                <span className="block truncate text-sm">{c.title}</span>
                <span className="text-xs text-muted">
                  <TimeAgo at={c.updatedAt} />
                </span>
              </button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete chat ${c.title}`}
                onClick={() =>
                  del.mutate(c.id, {
                    onSuccess: () => c.id === activeId && onNew(),
                    onError: (e) => toast.error(e.message),
                  })
                }
              >
                <Trash2 aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </ResponsiveSheet>
  );
}

/**
 * The assistant, as a collapsible pane on the right edge of the app (a full-screen layer on phones).
 * It stays mounted while collapsed, so a conversation survives collapsing it and moving between pages.
 */
export function AssistantPane() {
  const pane = useAssistantPane();
  const status = useAgentStatus();
  const chat = useAssistantChat();
  const settings = useSettingsPanel();
  const [history, setHistory] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const { state } = chat;

  // Follow the answer while the reader is at the bottom; leave them alone once they scroll up.
  const onScroll = () => {
    const el = scroller.current;
    if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };
  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [state.items, state.phase, state.pending.length, pane.open]);

  const ready = status.data?.enabled === true && status.data.configured;
  const empty = state.items.length === 0;
  const waiting = state.pending.length > 0 && !state.busy;

  return (
    <aside
      id="assistant-pane"
      aria-label="Assistant"
      hidden={!pane.open}
      data-testid="assistant-pane"
      className="fd-pane-in pt-safe pb-safe fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l bg-bg shadow-xl sm:w-[var(--assistant-w)] lg:shadow-none"
    >
      <header className="flex h-12 shrink-0 items-center gap-1 border-b pr-2 pl-4">
        <h2 className="flex min-w-0 items-center gap-2 text-sm font-semibold">
          <Spark working={state.busy} className="size-5" />
          <span>Assistant</span>
          {ready && status.data?.model ? (
            <Badge variant="muted" className="max-w-32 truncate" title={status.data.model}>
              {status.data.model}
            </Badge>
          ) : null}
        </h2>
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon" aria-label="Chats" title="Chats" onClick={() => setHistory(true)}>
            <History aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New chat"
            title="New chat"
            onClick={chat.reset}
            disabled={empty && !state.busy}
          >
            <MessageSquarePlus aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Assistant settings"
            title="Assistant settings"
            onClick={() => settings.open('assistant')}
          >
            <Settings aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Collapse assistant"
            title="Collapse assistant"
            onClick={() => pane.setOpen(false)}
          >
            <PanelRightClose aria-hidden />
          </Button>
        </div>
      </header>

      <div ref={scroller} onScroll={onScroll} className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
        {status.data !== undefined && !ready ? (
          <div data-testid="assistant-setup" className="fd-rise m-auto rounded-2xl border bg-surface p-5 text-center">
            <Spark className="mx-auto size-9" />
            <h3 className="mt-3 text-base font-semibold">
              {!status.data.enabled
                ? 'Turn on the assistant'
                : status.data.model === null
                  ? 'Choose a model'
                  : 'Add an API key'}
            </h3>
            <p className="mt-1 text-sm text-muted">
              It answers questions about your bots, strategies and Kraken account, and can silence findings or
              acknowledge orders when you approve. It needs an OpenAI-compatible API key and a model.
            </p>
            <Button className="mt-4" onClick={() => settings.open('assistant')}>
              Open settings
            </Button>
          </div>
        ) : empty ? (
          <div className="m-auto flex w-full flex-col items-center gap-4 py-6 text-center">
            <Spark className="size-10" />
            <div>
              <h3 className="text-lg font-semibold tracking-tight">What do you want to know?</h3>
              <p className="mt-1 text-sm text-muted">Ask about the bots, the account, fees or alerts.</p>
            </div>
            <div className="flex w-full flex-col gap-2">
              {SUGGESTIONS.map((s, i) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => chat.send(s)}
                  style={{ animationDelay: `${i * 60}ms` }}
                  className="fd-rise rounded-xl border bg-surface px-3.5 py-2 text-left text-sm outline-none transition-colors hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-4" aria-live="polite" aria-label="Conversation">
            {state.items.map((item) => (
              <Message key={item.id} item={item} decision={chat.decisions[item.id]} onDecide={chat.decide} />
            ))}
            {state.busy && state.phase !== 'writing' ? (
              <div className="pl-8">
                <ThinkingIndicator label={state.label} />
              </div>
            ) : null}
            {waiting ? <p className="pl-8 text-xs text-muted">Waiting for your decision above.</p> : null}
          </div>
        )}
      </div>

      <div className="shrink-0 border-t p-3">
        <Composer
          busy={state.busy}
          disabled={!ready}
          placeholder={ready ? 'Ask anything…' : 'Set up the assistant to start chatting'}
          onSend={chat.send}
          onStop={chat.stop}
        />
      </div>

      <HistorySheet
        open={history}
        onOpenChange={setHistory}
        onPick={(id) => void chat.open(id)}
        onNew={chat.reset}
        activeId={chat.conversationId}
      />
    </aside>
  );
}
