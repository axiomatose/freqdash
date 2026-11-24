'use client';

import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';

// Toasts sit above the mobile bottom tab bar (offset = tab bar height + safe area).
function Toaster(props: ToasterProps) {
  return (
    <Sonner
      theme="dark"
      position="bottom-right"
      offset={20}
      mobileOffset={{ bottom: 'calc(var(--shell-bottom) + 0.75rem)', left: 12, right: 12, top: 12 }}
      closeButton
      style={
        {
          '--normal-bg': 'var(--color-surface-2)',
          '--normal-text': 'var(--color-text)',
          '--normal-border': 'var(--color-border)',
          '--border-radius': 'var(--radius-lg)',
        } as CSSProperties
      }
      toastOptions={{ classNames: { toast: 'shadow-pop!', description: 'text-muted!' } }}
      {...props}
    />
  );
}

export { Toaster };
