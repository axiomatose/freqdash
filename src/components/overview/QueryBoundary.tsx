'use client';

import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { ErrorState, SkeletonCard } from '@/components/data';
import type { ApiError } from '@/lib/client/api';

/**
 * First load shows skeletons; after that stale data stays on screen (marked "offline since") when a refetch fails,
 * and only a failure without any data replaces the page with an error card.
 */
export function QueryBoundary<T>({
  query,
  skeleton,
  children,
}: {
  query: UseQueryResult<T, ApiError>;
  skeleton?: ReactNode;
  children: (data: T) => ReactNode;
}) {
  if (query.data === undefined) {
    if (query.isError)
      return <ErrorState error={query.error} onRetry={() => void query.refetch()} retrying={query.isFetching} />;
    return <>{skeleton ?? <SkeletonCard rows={5} />}</>;
  }
  return (
    <>
      {query.isError ? (
        <ErrorState
          inline
          error={query.error}
          offlineSince={query.dataUpdatedAt || null}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : null}
      {children(query.data)}
    </>
  );
}
