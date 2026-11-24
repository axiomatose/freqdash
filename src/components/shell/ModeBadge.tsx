import { Landmark, TriangleAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import type { SummaryResponse } from '@/shared/types/api';

/** Top-bar mode badge: Kraken (reconciled) or an amber Freqtrade-only. Stays visible after the banner is dismissed. */
export function ModeBadge({ mode, className }: { mode: SummaryResponse['mode']; className?: string }) {
  if (mode === 'freqtrade-only') {
    return (
      <Badge variant="warning" className={className} data-mode={mode}>
        <TriangleAlert aria-hidden />
        Freqtrade-only
      </Badge>
    );
  }
  return (
    <Badge variant="accent" className={className} data-mode={mode}>
      <Landmark aria-hidden />
      Kraken
    </Badge>
  );
}
