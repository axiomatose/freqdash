'use client';

import { useEffect } from 'react';
import { tabTitle } from '@/lib/client/format';

/**
 * Keeps `document.title` at "(N) freqdash". Next's metadata may rewrite the <title> element on navigation, so a
 * MutationObserver puts our value back whenever something else changes it.
 */
export function TabTitle({ alerts }: { alerts: number }) {
  useEffect(() => {
    const want = tabTitle(alerts);
    const apply = (): void => {
      if (document.title !== want) document.title = want;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [alerts]);
  return null;
}
