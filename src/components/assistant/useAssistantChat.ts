'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { fetchConversation, invalidateAgentData, streamAgent } from '@/lib/client/agent';
import { applyEvent, initialChat, itemsFromMessages, nextId, type ChatState } from './model';
import type { AgentChatBody, AgentEvent } from '@/shared/types/agent';

/** Chat state for the assistant page: sends messages, streams the answer, resumes after approvals. */
export function useAssistantChat() {
  const qc = useQueryClient();
  const [state, setState] = useState<ChatState>(initialChat);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Record<string, 'approve' | 'deny'>>({});
  const abort = useRef<AbortController | null>(null);
  const idRef = useRef<string | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  const run = useCallback(
    async (body: AgentChatBody) => {
      abort.current?.abort();
      const controller = new AbortController();
      abort.current = controller;
      setState((s) => ({ ...s, busy: true, phase: 'thinking', label: 'Thinking' }));
      const onEvent = (e: AgentEvent) => {
        if (e.type === 'conversation') {
          idRef.current = e.id;
          setConversationId(e.id);
        }
        setState((s) => applyEvent(s, e));
      };
      await streamAgent(
        { ...body, ...(idRef.current ? { conversationId: idRef.current } : {}) },
        onEvent,
        controller.signal,
      );
      // A stream that ended without `done` (dropped connection) must not leave the page "busy".
      setState((s) => (s.busy && !controller.signal.aborted ? { ...s, busy: false, phase: 'idle', label: '' } : s));
      invalidateAgentData(qc);
    },
    [qc],
  );

  const send = useCallback(
    (text: string) => {
      setDecisions({});
      setState((s) => ({ ...s, pending: [], items: [...s.items, { kind: 'user', id: nextId('u'), text }] }));
      void run({ message: text });
    },
    [run],
  );

  // A plain event handler (not a state updater): starting the resumed run inside an updater would run it twice in dev.
  const decide = useCallback(
    (callId: string, d: 'approve' | 'deny') => {
      const next = { ...decisions, [callId]: d };
      const all = state.pending.length > 0 && state.pending.every((p) => next[p.callId] !== undefined);
      if (all) {
        setDecisions({});
        void run({ approvals: next });
      } else {
        setDecisions(next);
      }
    },
    [decisions, state.pending, run],
  );

  const stop = useCallback(() => {
    abort.current?.abort();
    setState((s) => ({
      ...s,
      busy: false,
      phase: 'idle',
      label: '',
      items: s.items.map((i) => (i.kind === 'assistant' ? { ...i, streaming: false } : i)),
    }));
  }, []);

  const reset = useCallback(() => {
    abort.current?.abort();
    idRef.current = null;
    setConversationId(null);
    setDecisions({});
    setState(initialChat);
  }, []);

  const open = useCallback(async (id: string) => {
    abort.current?.abort();
    idRef.current = id;
    setConversationId(id);
    setDecisions({});
    const data = await fetchConversation(id);
    setState({ ...initialChat, items: itemsFromMessages(data.messages, data.pending), pending: data.pending });
  }, []);

  return { state, conversationId, decisions, send, decide, stop, reset, open };
}
