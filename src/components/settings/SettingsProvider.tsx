'use client';

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { SettingsSheet, type SettingsTab } from './SettingsSheet';

interface SettingsPanel {
  open: (tab?: SettingsTab) => void;
}

const Ctx = createContext<SettingsPanel>({ open: () => {} });

/** Owns the admin settings panel: any part of the shell (user menu, More sheet) can open it. */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ open: boolean; tab: SettingsTab }>({ open: false, tab: 'assistant' });
  const open = useCallback((tab: SettingsTab = 'assistant') => setState({ open: true, tab }), []);
  const value = useMemo(() => ({ open }), [open]);
  return (
    <Ctx.Provider value={value}>
      {children}
      <SettingsSheet
        open={state.open}
        tab={state.tab}
        onTabChange={(tab) => setState((s) => ({ ...s, tab }))}
        onOpenChange={(o) => setState((s) => ({ ...s, open: o }))}
      />
    </Ctx.Provider>
  );
}

export const useSettingsPanel = (): SettingsPanel => useContext(Ctx);
