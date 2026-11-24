'use client';

import { Fragment, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { cn } from '@/components/ui/utils';
import { useIsTablet } from '@/lib/client/useMediaQuery';

// ---- shared click handling -------------------------------------------------------------------------------------------

const INTERACTIVE = 'a, button, input, select, textarea, label, [role="button"], [role="checkbox"], [role="menuitem"]';

/** Row/card activation that ignores clicks which landed on a control inside the row. */
function activation(onActivate: (() => void) | undefined) {
  if (!onActivate) return {};
  return {
    tabIndex: 0,
    onClick: (e: MouseEvent<HTMLElement>) => {
      const hit = (e.target as HTMLElement).closest(INTERACTIVE);
      if (hit && hit !== e.currentTarget) return;
      onActivate();
    },
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      if (e.target !== e.currentTarget) return;
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onActivate();
      }
    },
  };
}

// ---- CardList -------------------------------------------------------------------------------------------------------

export interface CardListProps<T> {
  items: readonly T[];
  keyOf: (item: T) => string;
  renderItem: (item: T, index: number) => ReactNode;
  /** Makes each card a keyboard-focusable button. */
  onItemClick?: (item: T) => void;
  empty?: ReactNode;
  className?: string;
  'aria-label'?: string;
}

/** Stack of surface cards, the phone replacement for a table. Cards are full width with a 12 px gap. */
export function CardList<T>({ items, keyOf, renderItem, onItemClick, empty, className, ...aria }: CardListProps<T>) {
  if (items.length === 0) return <>{empty ?? null}</>;
  return (
    <ul data-slot="card-list" className={cn('flex flex-col gap-3', className)} {...aria}>
      {items.map((item, i) => (
        <li
          key={keyOf(item)}
          data-slot="card-list-item"
          className={cn(
            'min-w-0 rounded-xl border bg-surface p-3.5',
            onItemClick &&
              'cursor-pointer transition-colors hover:bg-surface-2/60 active:bg-surface-2 focus-visible:ring-2 focus-visible:ring-accent focus-visible:outline-none',
          )}
          {...activation(onItemClick ? () => onItemClick(item) : undefined)}
        >
          {renderItem(item, i)}
        </li>
      ))}
    </ul>
  );
}

// ---- ResponsiveTable ------------------------------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, index: number) => ReactNode;
  align?: 'left' | 'right' | 'center';
  /** Extra classes for the header and body cells in table layout (widths, hiding at a breakpoint). */
  className?: string;
  /**
   * How the column appears on the card layout (below md):
   * `title` is the card headline (default: the first column), `aside` sits at the headline's right, `field` (default)
   * is a labelled cell in a two-column grid, `full` is a labelled cell spanning both columns, `hidden` is dropped.
   */
  card?: 'title' | 'aside' | 'field' | 'full' | 'hidden';
  /** Card label; defaults to `header`. */
  cardLabel?: ReactNode;
}

export interface ResponsiveTableProps<T> {
  columns: readonly Column<T>[];
  rows: readonly T[];
  rowKey: (row: T) => string;
  /** Whole row (or card) activation, for example opening a detail sheet. Clicks on inner controls are ignored. */
  onRowClick?: (row: T) => void;
  /** Extra content under an expanded row (table layout: a full-width row; cards: below the fields). */
  renderExpanded?: (row: T) => ReactNode;
  isExpanded?: (row: T) => boolean;
  /** Replace the default card layout entirely. */
  renderCard?: (row: T) => ReactNode;
  empty?: ReactNode;
  caption?: string;
  className?: string;
}

const ALIGN = { left: 'text-left', right: 'text-right', center: 'text-center' } as const;

/**
 * A dense table from md up and a card list below it (docs/PLAN.md section 9: "tables become card lists").
 * The switch is a media query read after mount, so server and first client render agree.
 */
export function ResponsiveTable<T>(props: ResponsiveTableProps<T>) {
  const wide = useIsTablet();
  const { rows, empty } = props;
  if (rows.length === 0 && empty) return <>{empty}</>;
  return wide ? <TableLayout {...props} /> : <CardLayout {...props} />;
}

function TableLayout<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  renderExpanded,
  isExpanded,
  caption,
  className,
}: ResponsiveTableProps<T>) {
  return (
    <Table className={className} containerClassName="rounded-xl border bg-surface">
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          {columns.map((c) => (
            <TableHead key={c.key} className={cn(ALIGN[c.align ?? 'left'], c.className)}>
              {c.header}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row, i) => {
          const expanded = isExpanded?.(row) ?? false;
          return (
            <Fragment key={rowKey(row)}>
              <TableRow
                aria-expanded={renderExpanded ? expanded : undefined}
                className={cn(
                  onRowClick && 'cursor-pointer focus-visible:bg-surface-2 focus-visible:outline-none',
                  expanded && 'border-b-0 bg-surface-2/40',
                )}
                {...activation(onRowClick ? () => onRowClick(row) : undefined)}
              >
                {columns.map((c) => (
                  <TableCell key={c.key} className={cn(ALIGN[c.align ?? 'left'], c.className)}>
                    {c.cell(row, i)}
                  </TableCell>
                ))}
              </TableRow>
              {expanded && renderExpanded ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={columns.length} className="h-auto whitespace-normal bg-surface-2/40 py-3">
                    {renderExpanded(row)}
                  </TableCell>
                </TableRow>
              ) : null}
            </Fragment>
          );
        })}
      </TableBody>
    </Table>
  );
}

function CardLayout<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  renderExpanded,
  isExpanded,
  renderCard,
  caption,
}: ResponsiveTableProps<T>) {
  const explicitTitle = columns.some((c) => c.card === 'title');
  const roleOf = (c: Column<T>, index: number): NonNullable<Column<T>['card']> =>
    c.card ?? (index === 0 && !explicitTitle ? 'title' : 'field');
  const titles = columns.filter((c, i) => roleOf(c, i) === 'title');
  const asides = columns.filter((c, i) => roleOf(c, i) === 'aside');
  const fields = columns.filter((c, i) => ['field', 'full'].includes(roleOf(c, i)));

  return (
    <CardList
      items={rows}
      keyOf={rowKey}
      onItemClick={onRowClick}
      aria-label={caption}
      renderItem={(row, i) => {
        if (renderCard) return renderCard(row);
        const expanded = isExpanded?.(row) ?? false;
        return (
          <div className="flex flex-col gap-3">
            {titles.length + asides.length > 0 ? (
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1 text-sm font-medium text-text">
                  {titles.map((c) => (
                    <div key={c.key}>{c.cell(row, i)}</div>
                  ))}
                </div>
                {asides.length > 0 ? (
                  <div className="flex shrink-0 flex-col items-end gap-1 text-sm">
                    {asides.map((c) => (
                      <div key={c.key}>{c.cell(row, i)}</div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}
            {fields.length > 0 ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                {fields.map((c) => (
                  <div key={c.key} className={cn('min-w-0', c.card === 'full' && 'col-span-2')}>
                    <dt className="eyebrow">{c.cardLabel ?? c.header}</dt>
                    <dd className="mt-0.5 min-w-0 text-[13px] text-text">{c.cell(row, i)}</dd>
                  </div>
                ))}
              </dl>
            ) : null}
            {expanded && renderExpanded ? <div className="border-t pt-3">{renderExpanded(row)}</div> : null}
          </div>
        );
      }}
    />
  );
}
