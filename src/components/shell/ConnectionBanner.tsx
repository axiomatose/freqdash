'use client';

import { ErrorState } from '@/components/data/ErrorState';
import { useSummary } from '@/lib/client/queries';

/** Slim bar shown while the dashboard API is unreachable; the last data stays on screen underneath. */
export function ConnectionBanner() {
  const { isError, error, dataUpdatedAt, refetch, isFetching } = useSummary();
  if (!isError) return null;
  return (
    <div className="border-b border-critical/40 bg-bg">
      <ErrorState
        inline
        error={error}
        offlineSince={dataUpdatedAt || null}
        onRetry={() => void refetch()}
        retrying={isFetching}
        className="rounded-none border-0 px-4 py-1.5 lg:px-6"
      />
    </div>
  );
}
