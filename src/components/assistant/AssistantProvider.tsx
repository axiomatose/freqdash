'use client';

import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { updatePrefs, usePrefs } from '@/lib/client/prefs';

interface AssistantPaneState {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const Ctx = createContext<AssistantPaneState>({ open: false, setOpen: () => {}, toggle: () => {} });

/** Whether the assistant pane is expanded. Remembered per browser; any part of the shell can open or collapse it. */
export function AssistantProvider({ children }: { children: ReactNode }) {
  const { assistantOpen } = usePrefs();
  const setOpen = useCallback((open: boolean) => updatePrefs({ assistantOpen: open }), []);
  const toggle = useCallback(() => updatePrefs({ assistantOpen: !assistantOpen }), [assistantOpen]);
  const value = useMemo(() => ({ open: assistantOpen, setOpen, toggle }), [assistantOpen, setOpen, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useAssistantPane = (): AssistantPaneState => useContext(Ctx);
