'use client';

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Bell, ChevronDown, Filter, Inbox, KeyRound, Layers, MoreHorizontal, Settings2 } from 'lucide-react';
import {
  BotBadge,
  BotDot,
  CardList,
  EmptyState,
  ErrorState,
  FreshnessDot,
  FreshnessProvider,
  Metric,
  Money,
  Pct,
  Pnl,
  Price,
  Qty,
  ResponsiveTable,
  SEVERITY,
  SeverityBadge,
  SkeletonCard,
  SkeletonRows,
  SkeletonStat,
  Stat,
  StatusDot,
  StatusPill,
  Time,
  TimeAgo,
  type Column,
} from '@/components/data';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Drawer,
  DrawerBody,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from '@/components/ui/drawer';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ResponsiveSheet } from '@/components/ui/responsive-sheet';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetBody,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/components/ui/utils';
import { FindingsBannerView, ModeBannerView } from '@/components/shell';
import { toFreshness } from '@/shared/constants';
import type { BotStatusPill } from '@/shared/types/api';
import type { Freshness, Severity } from '@/shared/types/domain';

// Every primitive, every freshness state, the banners and the loading/empty/error states, on one page.
// Time-dependent samples are built after mount so server and client markup match.

const SWATCHES = [
  ['bg', 'bg-bg', '#0B0D12'],
  ['surface', 'bg-surface', '#12151C'],
  ['surface-2', 'bg-surface-2', '#181C25'],
  ['border', 'bg-border', '#232838'],
  ['text', 'bg-text', '#E6E8EE'],
  ['muted', 'bg-muted', '#8A93A6'],
  ['accent', 'bg-accent', '#4F8CFF'],
  ['positive', 'bg-positive', '#2EBD85'],
  ['negative', 'bg-negative', '#F6465D'],
  ['warning', 'bg-warning', '#F5A524'],
  ['critical', 'bg-critical', '#E5484D'],
  ['info', 'bg-info', '#3E63DD'],
] as const;

function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="flex scroll-mt-20 flex-col gap-4">
      <div className="flex flex-col gap-1 border-b pb-3">
        <h2 id={`${id}-h`} className="text-base font-semibold tracking-tight">
          {title}
        </h2>
        {description ? <p className="max-w-3xl text-[13px] text-muted">{description}</p> : null}
      </div>
      {children}
    </section>
  );
}

function Demo({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="eyebrow">{label}</p>
      <div className={cn('flex min-w-0 flex-wrap items-center gap-2', className)}>{children}</div>
    </div>
  );
}

interface PositionRow {
  id: string;
  bot: { name: string; color: string };
  pair: string;
  base: string;
  qty: number;
  entry: number;
  mark: number;
  value: number;
  upnl: number;
  upnlPct: number;
  entries: number;
  openedAt: number;
}

// A fixed sample time chosen on the client: null while rendering on the server and during hydration.
let sampleNow: number | null = null;
const noSubscribe = () => () => {};
function useSampleNow(): number | null {
  return useSyncExternalStore(
    noSubscribe,
    () => (sampleNow ??= Date.now()),
    () => null,
  );
}

export default function UiKitPage() {
  const now = useSampleNow();

  return (
    <div className="flex flex-col gap-10 pb-6">
      <header className="flex flex-col gap-1.5">
        <h1 className="text-xl font-semibold tracking-tight">UI kit</h1>
        <p className="max-w-3xl text-[13px] text-muted">
          Design tokens, primitives and the freshness-aware data components used by every page. Dark theme only. Resize
          to 390 px to see the phone layout: bottom tabs, card lists, sheets.
        </p>
        <nav
          aria-label="Sections"
          className="scrollbar-none -mx-4 mt-2 flex gap-1.5 overflow-x-auto px-4 lg:mx-0 lg:flex-wrap lg:px-0"
        >
          {[
            'tokens',
            'numbers',
            'freshness',
            'badges',
            'banners',
            'states',
            'controls',
            'overlays',
            'tables',
            'cards',
          ].map((s) => (
            <a
              key={s}
              href={`#kit-${s}`}
              className="inline-flex min-h-10 shrink-0 items-center rounded-md border px-2.5 text-xs font-medium text-muted capitalize hover:bg-surface-2 hover:text-text lg:min-h-8"
            >
              {s}
            </a>
          ))}
        </nav>
      </header>

      <Tokens />
      <Numbers now={now} />
      {now !== null ? <FreshnessSection now={now} /> : null}
      <Badges />
      <Banners now={now} />
      <States />
      <Controls />
      <Overlays />
      {now !== null ? <Tables now={now} /> : null}
      <Cards />
    </div>
  );
}

// ---- tokens ------------------------------------------------------------------------------------------------------

function Tokens() {
  return (
    <Section
      id="kit-tokens"
      title="Tokens and type"
      description="Tailwind v4 @theme tokens. System font stack; every number is tabular so columns line up."
    >
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4 lg:grid-cols-6">
        {SWATCHES.map(([name, cls, hex]) => (
          <div key={name} className="flex min-w-0 flex-col gap-1.5">
            <div className={cn('h-12 rounded-lg border', cls)} />
            <p className="truncate text-xs font-medium">{name}</p>
            <p className="-mt-1 text-[11px] text-muted">{hex}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardContent className="flex flex-col gap-2">
            <p className="eyebrow">Hero number</p>
            <p className="text-[2rem] leading-none font-semibold tracking-tight lg:text-[2.5rem]">$622.78</p>
            <p className="text-xs text-muted">
              Section title 15 px, body 14 px, dense table 13 px, caption 12 px, eyebrow 11 px.
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 tabular-nums">
            <span className="text-muted">1,234.56</span>
            <span>0.00046744</span>
            <span className="text-muted">99,999.10</span>
            <span>0.11302409</span>
            <span className="text-muted">8.90</span>
            <span>1,901,628.18</span>
          </CardContent>
        </Card>
      </div>
    </Section>
  );
}

// ---- numbers -----------------------------------------------------------------------------------------------------

function Numbers({ now }: { now: number | null }) {
  return (
    <Section
      id="kit-numbers"
      title="Numbers and time"
      description="USD 2 dp, crypto up to 8 dp trimmed, coloured explicit signs, missing values as a dash."
    >
      <div className="grid grid-cols-2 gap-x-8 gap-y-5 lg:grid-cols-3 xl:grid-cols-6">
        <Demo label="Money" className="flex-col items-start gap-1.5">
          <Money value={1234.5} />
          <Money value={-12.3} colored />
          <Money value={null} />
          <Money value={1_234_567} compact />
        </Demo>
        <Demo label="Money signed" className="flex-col items-start gap-1.5">
          <Money value={3.42} signed />
          <Money value={-18.06} signed />
          <Money value={0.001} signed />
        </Demo>
        <Demo label="Qty" className="flex-col items-start gap-1.5">
          <Qty value={0.00046744} asset="BTC" />
          <Qty value={0.1130240889} asset="ETH" />
          <Qty value={1_901_628.18} asset="SHIB" />
          <Qty value={4e-9} />
        </Demo>
        <Demo label="Pct and Price" className="flex-col items-start gap-1.5">
          <Pct value={0.0055} signed />
          <Pct value={-0.0312} signed />
          <Pct value={0.62} dp={0} />
          <Price value={83_900} />
          <Price value={0.00001} />
        </Demo>
        <Demo label="Pnl" className="flex-col items-start gap-1.5">
          <Pnl usd={3.42} pct={0.0055} />
          <Pnl usd={-8.1} pct={-0.0132} />
        </Demo>
        <Demo label="Time" className="flex-col items-start gap-1.5">
          {now !== null ? (
            <>
              <TimeAgo at={now - 12_000} />
              <TimeAgo at={now - 4 * 60_000} />
              <TimeAgo at={now - 3 * 3_600_000} />
              <Time at={now - 26 * 3_600_000} />
            </>
          ) : (
            <Skeleton className="h-4 w-20" />
          )}
        </Demo>
      </div>
    </Section>
  );
}

// ---- freshness ---------------------------------------------------------------------------------------------------

function FreshnessSection({ now }: { now: number }) {
  const sources = useMemo<Freshness[]>(() => {
    const make = (
      source: string,
      label: string,
      ageMs: number,
      extra: { failures?: number; error?: string; disabled?: boolean } = {},
    ): Freshness =>
      toFreshness(
        source,
        label,
        {
          cadenceMs: 30_000,
          lastOkAt: extra.disabled ? null : now - ageMs,
          lastAttemptAt: extra.disabled ? null : now - Math.min(ageMs, 5_000),
          consecutiveFailures: extra.failures ?? 0,
          disabled: extra.disabled,
          error: extra.error,
        },
        now,
      );
    return [
      make('demo:fresh', 'Kraken balance', 12_000),
      make('demo:aging', 'Bot open trades', 110_000),
      make('demo:stale', 'Market prices', 14 * 60_000),
      make('demo:error', 'Kraken open orders', 25 * 60_000, { failures: 4, error: 'EAPI:Invalid nonce (HTTP 200)' }),
      make('demo:disabled', 'Kraken ledgers', 0, { disabled: true }),
    ];
  }, [now]);

  const rows: { key: string; title: string; value: ReactNode; sources: string[] }[] = [
    { key: 'fresh', title: 'Fresh', value: <Money value={622.78} />, sources: ['demo:fresh'] },
    { key: 'aging', title: 'Aging', value: <Money value={622.78} />, sources: ['demo:aging'] },
    { key: 'stale', title: 'Stale (muted, "as of")', value: <Money value={622.78} />, sources: ['demo:stale'] },
    { key: 'error', title: 'Error', value: <Money value={622.78} />, sources: ['demo:error'] },
    { key: 'disabled', title: 'Disabled', value: <Money value={null} />, sources: ['demo:disabled'] },
    {
      key: 'worst-1',
      title: 'Fresh + stale: stale wins',
      value: <Qty value={0.1130240889} asset="ETH" />,
      sources: ['demo:fresh', 'demo:stale'],
    },
    {
      key: 'worst-2',
      title: 'Aging + error: error wins',
      value: <Qty value={0.00046744} asset="BTC" />,
      sources: ['demo:aging', 'demo:error'],
    },
    {
      key: 'worst-3',
      title: 'Fresh + disabled: disabled',
      value: <Pct value={0.0055} signed />,
      sources: ['demo:fresh', 'demo:disabled'],
    },
  ];

  return (
    <Section
      id="kit-freshness"
      title="Freshness"
      description="Every bot or Kraken number goes through <Metric sources={[...]}>. The worst state wins. Hover the dot (desktop) or tap it (phone) for the per-source ages and errors."
    >
      <FreshnessProvider sources={sources}>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>States</CardTitle>
              <CardDescription>
                Green fresh, amber aging, hollow amber stale, red error, hollow grey disabled.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2.5">
              {(['fresh', 'aging', 'stale', 'error', 'disabled'] as const).map((s) => (
                <div
                  key={s}
                  className="flex items-center justify-between gap-3 border-b pb-2.5 last:border-0 last:pb-0"
                >
                  <span className="flex items-center gap-2 text-[13px]">
                    <FreshnessDot state={s} />
                    <span className="capitalize">{s}</span>
                  </span>
                  <span className="text-xs text-muted">
                    {s === 'fresh'
                      ? '<= 2x cadence'
                      : s === 'aging'
                        ? '<= 5x'
                        : s === 'stale'
                          ? '> 5x'
                          : s === 'error'
                            ? 'attempt failed'
                            : 'not configured'}
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Metric</CardTitle>
              <CardDescription>Tap or hover a dot to open its popover.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              {rows.map((r) => (
                <div key={r.key} className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 text-[13px] text-muted">{r.title}</span>
                  <span data-testid={`metric-${r.key}`} className="shrink-0 text-sm font-medium">
                    <Metric value={r.value} sources={r.sources} />
                  </span>
                </div>
              ))}
              <FreshnessProvider sources={[]} offline={{ since: now - 95_000 }}>
                <div className="flex items-baseline justify-between gap-3 border-t pt-3">
                  <span className="min-w-0 text-[13px] text-muted">Dashboard offline</span>
                  <span data-testid="metric-offline" className="shrink-0 text-sm font-medium">
                    <Metric value={<Money value={622.78} />} sources={['demo:fresh']} />
                  </span>
                </div>
              </FreshnessProvider>
            </CardContent>
          </Card>
        </div>
      </FreshnessProvider>
    </Section>
  );
}

// ---- badges ------------------------------------------------------------------------------------------------------

const STATUSES: BotStatusPill[] = ['running', 'restarting', 'stale', 'down', 'auth_error', 'stopped', 'unknown'];

function Badges() {
  return (
    <Section
      id="kit-badges"
      title="Badges, chips and status"
      description="Severity and bot status are always an icon plus a word; colour only reinforces."
    >
      <div className="grid gap-x-8 gap-y-5 lg:grid-cols-2">
        <Demo label="SeverityBadge">
          {(Object.keys(SEVERITY) as Severity[]).map((s) => (
            <SeverityBadge key={s} severity={s} />
          ))}
        </Demo>
        <Demo label="BotBadge">
          <BotBadge name="VoteMax" color="#4F8CFF" />
          <BotBadge name="DCA" color="#B38CFF" />
          <span className="inline-flex items-center gap-1.5 text-[13px]">
            <BotDot color="#4F8CFF" /> BotDot
          </span>
        </Demo>
        <Demo label="StatusPill" className="gap-2">
          {STATUSES.map((s) => (
            <StatusPill key={s} status={s} />
          ))}
        </Demo>
        <Demo label="StatusDot (sidebar)" className="gap-x-4">
          {STATUSES.map((s) => (
            <StatusDot key={s} status={s} showLabel />
          ))}
        </Demo>
        <Demo label="Badge variants">
          <Badge>default</Badge>
          <Badge variant="muted">muted</Badge>
          <Badge variant="accent">accent</Badge>
          <Badge variant="positive">positive</Badge>
          <Badge variant="negative">negative</Badge>
          <Badge variant="warning">warning</Badge>
          <Badge variant="critical">critical</Badge>
          <Badge variant="info">info</Badge>
          <Badge variant="outline">outline</Badge>
        </Demo>
      </div>
    </Section>
  );
}

// ---- banners -----------------------------------------------------------------------------------------------------

function Banners({ now }: { now: number | null }) {
  const [dismissed, setDismissed] = useState(false);
  return (
    <Section
      id="kit-banners"
      title="Banners"
      description="The shell shows these live from /api/v1/summary. Critical is red and sticky under the top bar; warnings are amber; freqtrade-only is an amber outline you can hide for 24 h."
    >
      <div className="flex flex-col gap-4">
        <div className="overflow-hidden rounded-xl border">
          <FindingsBannerView
            critical={2}
            warning={1}
            top={{ title: 'Orphan Kraken orders on ETH/USD (26 · $293.70)' }}
            sticky={false}
            className="border-b-0"
          />
        </div>
        <div className="overflow-hidden rounded-xl border">
          <FindingsBannerView
            critical={0}
            warning={3}
            top={{ title: 'ETH on Kraken is not owned by any open trade' }}
            sticky={false}
            className="border-b-0"
          />
        </div>
        {dismissed ? (
          <Button variant="secondary" size="sm" className="w-fit" onClick={() => setDismissed(false)}>
            Show the freqtrade-only banner again
          </Button>
        ) : (
          <ModeBannerView reason="No Kraken key" onDismiss={() => setDismissed(true)} />
        )}
        {now !== null ? (
          <ErrorState
            inline
            error={new Error('Cannot reach the dashboard server.')}
            offlineSince={now - 95_000}
            onRetry={() => toast('Retrying...')}
          />
        ) : null}
      </div>
    </Section>
  );
}

// ---- states ------------------------------------------------------------------------------------------------------

function States() {
  return (
    <Section
      id="kit-states"
      title="Loading, empty and error"
      description="Skeletons only on the first load; afterwards pages keep the previous data on screen (keepPreviousData)."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <SkeletonCard />
        <Card>
          <CardContent className="flex flex-col gap-5">
            <SkeletonStat />
            <SkeletonRows rows={3} />
          </CardContent>
        </Card>
        <Card>
          <EmptyState compact icon={Inbox} title="No open positions" description="Bots are waiting for a signal." />
          <Separator />
          <EmptyState
            compact
            icon={KeyRound}
            title="Kraken key not configured"
            description="Order reconciliation needs a read-only key."
            action={
              <Button variant="secondary" size="sm">
                Kraken setup
              </Button>
            }
          />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <EmptyState bordered icon={Bell} title="No findings: all 22 checks passing" description="Last run 5 s ago." />
        <ErrorState
          error={new Error('Cannot reach the dashboard server.')}
          title="Couldn't load the overview"
          onRetry={() => toast('Retrying...')}
        />
      </div>
    </Section>
  );
}

// ---- controls ----------------------------------------------------------------------------------------------------

function Controls() {
  const [range, setRange] = useState('7d');
  const [pair, setPair] = useState('BTC/USD');
  const [layers, setLayers] = useState({ signals: true, fills: true, orphans: false });
  return (
    <Section
      id="kit-controls"
      title="Buttons and inputs"
      description="44 px tall on touch layouts, compact from lg. Keyboard focus shows an accent ring; press Tab to see it."
    >
      <div className="grid gap-x-8 gap-y-6 lg:grid-cols-2">
        <Demo label="Button variants">
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="outline">Outline</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="destructive">Destructive</Button>
          <Button variant="link">Link</Button>
          <Button disabled>Disabled</Button>
        </Demo>
        <Demo label="Button sizes">
          <Button size="sm">Small</Button>
          <Button>Default</Button>
          <Button size="lg">Large</Button>
          <Button size="icon" variant="secondary" aria-label="Filters">
            <Filter />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Settings">
            <Settings2 />
          </Button>
        </Demo>
        <Demo label="ToggleGroup (range chips)">
          <ToggleGroup type="single" value={range} onValueChange={(v) => v && setRange(v)} aria-label="Range">
            {['24h', '7d', '30d', 'All'].map((r) => (
              <ToggleGroupItem key={r} value={r === 'All' ? 'all' : r}>
                {r}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </Demo>
        <Demo label="Select">
          <Select value={pair} onValueChange={setPair}>
            <SelectTrigger aria-label="Pair" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {['BTC/USD', 'ETH/USD', 'SHIB/USD'].map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Demo>
        <Demo label="Tabs (pill)">
          <Tabs defaultValue="active" className="w-full max-w-sm">
            <TabsList aria-label="Findings">
              <TabsTrigger value="active">Active</TabsTrigger>
              <TabsTrigger value="silenced">Silenced</TabsTrigger>
              <TabsTrigger value="resolved">Resolved</TabsTrigger>
            </TabsList>
            <TabsContent value="active" className="text-[13px] text-muted">
              Active findings appear here.
            </TabsContent>
            <TabsContent value="silenced" className="text-[13px] text-muted">
              Silenced findings appear here.
            </TabsContent>
            <TabsContent value="resolved" className="text-[13px] text-muted">
              Resolved findings appear here.
            </TabsContent>
          </Tabs>
        </Demo>
        <Demo label="Tabs (line)">
          <Tabs defaultValue="summary" className="w-full max-w-sm">
            <TabsList variant="line" aria-label="Bot sections">
              <TabsTrigger value="summary">Summary</TabsTrigger>
              <TabsTrigger value="trades">Trades</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
            </TabsList>
            <TabsContent value="summary" className="text-[13px] text-muted">
              Summary tab.
            </TabsContent>
            <TabsContent value="trades" className="text-[13px] text-muted">
              Trades tab.
            </TabsContent>
            <TabsContent value="events" className="text-[13px] text-muted">
              Events tab.
            </TabsContent>
          </Tabs>
        </Demo>
        <Demo label="Input and Textarea" className="w-full flex-col items-stretch">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kit-name">Your name</Label>
            <Input id="kit-name" placeholder="Optional, max 32 characters" />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kit-note">Note</Label>
            <Textarea id="kit-note" placeholder="Why is this silenced?" />
          </div>
        </Demo>
        <Demo label="Switch and Checkbox" className="flex-col items-start gap-3">
          <label className="flex items-center gap-3 text-[13px]">
            <Switch defaultChecked aria-label="Show times in UTC" /> Show times in UTC
          </label>
          <label className="flex items-center gap-3 text-[13px]">
            <Switch aria-label="Volume pane" /> Volume pane
          </label>
          <label className="flex items-center gap-3 text-[13px]">
            <Checkbox defaultChecked aria-label="Select order" /> Mark as manual
          </label>
          <label className="flex items-center gap-3 text-[13px]">
            <Checkbox aria-label="Select order 2" /> Ignore order
          </label>
        </Demo>
        <Demo label="DropdownMenu (Layers)">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="secondary">
                <Layers />
                Layers
                <ChevronDown />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
              <DropdownMenuLabel>Chart layers</DropdownMenuLabel>
              <DropdownMenuSeparator />
              {(Object.keys(layers) as (keyof typeof layers)[]).map((k) => (
                <DropdownMenuCheckboxItem
                  key={k}
                  checked={layers[k]}
                  onCheckedChange={(v) => setLayers((l) => ({ ...l, [k]: v === true }))}
                  onSelect={(e) => e.preventDefault()}
                  className="capitalize"
                >
                  {k}
                </DropdownMenuCheckboxItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive">Reset</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </Demo>
      </div>
    </Section>
  );
}

// ---- overlays ----------------------------------------------------------------------------------------------------

function Overlays() {
  const [sheetOpen, setSheetOpen] = useState(false);
  return (
    <Section
      id="kit-overlays"
      title="Overlays"
      description="Sheets instead of dialogs on phones: ResponsiveSheet is a right panel from lg up and a bottom drawer (vaul) below it."
    >
      <div className="flex flex-wrap gap-2">
        <Popover>
          <PopoverTrigger asChild>
            <Button variant="secondary">Popover</Button>
          </PopoverTrigger>
          <PopoverContent>
            <p className="text-[13px]">Wallet views</p>
            <p className="mt-1 text-xs text-muted">
              Kraken USD $141.06 · VoteMax cache $141.06 (20 min ago) · DCA cache $141.06 (47 min ago).
            </p>
          </PopoverContent>
        </Popover>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="secondary">Tooltip (hover or focus)</Button>
          </TooltipTrigger>
          <TooltipContent>Hover-only hint. Touch users get a popover instead.</TooltipContent>
        </Tooltip>

        <Dialog>
          <DialogTrigger asChild>
            <Button variant="secondary">Dialog</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Silence this finding?</DialogTitle>
              <DialogDescription>
                It stays visible under Silenced and comes back if it grows or escalates.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="dlg-note">Note</Label>
              <Textarea id="dlg-note" placeholder="Optional" />
            </div>
            <DialogFooter>
              <Button variant="ghost">Cancel</Button>
              <Button>Silence</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Sheet>
          <SheetTrigger asChild>
            <Button variant="secondary">Sheet (right)</Button>
          </SheetTrigger>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>Candle detail</SheetTitle>
              <SheetDescription>BTC/USD 4h · Sep 28 08:00</SheetDescription>
            </SheetHeader>
            <SheetBody className="py-2 text-[13px] text-muted">
              Signals, fills and trades for the selected candle.
            </SheetBody>
            <SheetFooter>
              <Button variant="secondary">Open trade</Button>
            </SheetFooter>
          </SheetContent>
        </Sheet>

        <Drawer>
          <DrawerTrigger asChild>
            <Button variant="secondary">Drawer (bottom)</Button>
          </DrawerTrigger>
          <DrawerContent>
            <DrawerHeader>
              <DrawerTitle>Filters</DrawerTitle>
              <DrawerDescription>Bot, pair and status.</DrawerDescription>
            </DrawerHeader>
            <DrawerBody className="py-2 text-[13px] text-muted">Drag the handle down to dismiss.</DrawerBody>
            <DrawerFooter>
              <Button>Apply</Button>
            </DrawerFooter>
          </DrawerContent>
        </Drawer>

        <Button variant="secondary" onClick={() => setSheetOpen(true)}>
          ResponsiveSheet
        </Button>
        <ResponsiveSheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          title="3 orders missing from votemax"
          description="Critical · active for 12 min"
          footer={
            <>
              <Button>Mark orders manual</Button>
              <Button variant="secondary">Silence</Button>
            </>
          }
        >
          <p className="py-2 text-[13px] text-muted">
            Evidence table, runbook text and actions live here. Desktop: right panel. Phone: full-height bottom sheet.
          </p>
        </ResponsiveSheet>

        <Button
          variant="secondary"
          onClick={() =>
            toast.success('Acknowledged 3 orders', { description: 'They are excluded from orphan checks.' })
          }
        >
          Toast
        </Button>
        <Button
          variant="secondary"
          onClick={() => toast.error('Could not reach the server', { description: 'Retrying in 10 s.' })}
        >
          Error toast
        </Button>
      </div>
    </Section>
  );
}

// ---- tables ------------------------------------------------------------------------------------------------------

function Tables({ now }: { now: number }) {
  const rows = useMemo<PositionRow[]>(
    () => [
      {
        id: 'a',
        bot: { name: 'VoteMax', color: '#4F8CFF' },
        pair: 'BTC/USD',
        base: 'BTC',
        qty: 0.00046744,
        entry: 83_450,
        mark: 83_900,
        value: 39.22,
        upnl: 0.09,
        upnlPct: 0.0023,
        entries: 1,
        openedAt: now - 3 * 3_600_000,
      },
      {
        id: 'b',
        bot: { name: 'DCA', color: '#B38CFF' },
        pair: 'ETH/USD',
        base: 'ETH',
        qty: 0.0434,
        entry: 3_150,
        mark: 3_230,
        value: 140.18,
        upnl: 3.44,
        upnlPct: 0.0251,
        entries: 2,
        openedAt: now - 2 * 86_400_000,
      },
      {
        id: 'c',
        bot: { name: 'DCA', color: '#B38CFF' },
        pair: 'SHIB/USD',
        base: 'SHIB',
        qty: 1_901_628.18,
        entry: 0.0000108,
        mark: 0.00001,
        value: 19.02,
        upnl: -1.52,
        upnlPct: -0.0741,
        entries: 1,
        openedAt: now - 5 * 86_400_000,
      },
    ],
    [now],
  );
  const [open, setOpen] = useState<string | null>('b');

  const columns: Column<PositionRow>[] = [
    { key: 'pair', header: 'Pair', card: 'title', cell: (r) => <span className="font-medium">{r.pair}</span> },
    { key: 'bot', header: 'Bot', card: 'aside', cell: (r) => <BotBadge name={r.bot.name} color={r.bot.color} /> },
    { key: 'qty', header: 'Qty', align: 'right', cell: (r) => <Qty value={r.qty} asset={r.base} /> },
    { key: 'entry', header: 'Avg entry', align: 'right', cell: (r) => <Price value={r.entry} /> },
    { key: 'mark', header: 'Mark', align: 'right', cell: (r) => <Price value={r.mark} /> },
    { key: 'value', header: 'Value', align: 'right', cell: (r) => <Money value={r.value} /> },
    { key: 'upnl', header: 'uPnL', align: 'right', cell: (r) => <Pnl usd={r.upnl} pct={r.upnlPct} /> },
    { key: 'age', header: 'Age', align: 'right', className: 'text-muted', cell: (r) => <TimeAgo at={r.openedAt} /> },
    { key: 'entries', header: 'Entries', align: 'right', card: 'hidden', cell: (r) => r.entries },
  ];

  return (
    <Section
      id="kit-tables"
      title="ResponsiveTable and CardList"
      description="A dense table from 768 px up; below it the same columns become a card list (title, aside and labelled fields). Rows can expand."
    >
      <ResponsiveTable
        columns={columns}
        rows={rows}
        rowKey={(r) => r.id}
        onRowClick={(r) => setOpen((cur) => (cur === r.id ? null : r.id))}
        isExpanded={(r) => open === r.id}
        renderExpanded={(r) => (
          <div className="flex flex-wrap items-center gap-x-6 gap-y-1 text-[13px] text-muted">
            <span>{r.entries} entry orders</span>
            <span>
              Kraken match: <Badge variant="positive">matched</Badge>
            </span>
          </div>
        )}
        caption="Open positions"
      />
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="eyebrow">Plain Table</p>
          <div className="rounded-xl border bg-surface">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Asset</TableHead>
                  <TableHead className="text-right">Qty</TableHead>
                  <TableHead className="text-right">Value</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>BTC</TableCell>
                  <TableCell className="text-right">
                    <Qty value={0.00046744} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={39.22} />
                  </TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>ETH</TableCell>
                  <TableCell className="text-right">
                    <Qty value={0.1130240889} />
                  </TableCell>
                  <TableCell className="text-right">
                    <Money value={365.06} />
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </div>
        <div className="flex flex-col gap-2">
          <p className="eyebrow">CardList</p>
          <CardList
            items={['VoteMax restarted', 'Exit fee 0.8% on trade 3']}
            keyOf={(s) => s}
            onItemClick={() => toast('Row activated')}
            renderItem={(s) => (
              <div className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate text-[13px]">{s}</span>
                <SeverityBadge severity="info" />
              </div>
            )}
          />
        </div>
      </div>
    </Section>
  );
}

// ---- cards -------------------------------------------------------------------------------------------------------

function Cards() {
  return (
    <Section
      id="kit-cards"
      title="Cards and stats"
      description="Surface #12151C, 1 px border, 14 px radius. Stat blocks pair an eyebrow label with a tabular number."
    >
      <div className="grid gap-4 lg:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle>Account</CardTitle>
            <CardDescription>Kraken · 12 s ago</CardDescription>
            <CardAction>
              <Button variant="ghost" size="icon-sm" aria-label="More">
                <MoreHorizontal />
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <Stat
              label="Total value"
              size="hero"
              value={<Money value={622.78} />}
              sub={<Pnl usd={3.42} pct={0.0055} />}
            />
          </CardContent>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>VoteMax</CardTitle>
            <CardDescription>VoteMaxStrategy · 4h</CardDescription>
            <CardAction>
              <StatusPill status="running" />
            </CardAction>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            <Stat label="Realized" value={<Money value={12.4} signed />} />
            <Stat label="Unrealized" value={<Money value={-1.52} signed />} />
            <Stat label="ROI on stake" value={<Pct value={0.0421} signed />} />
            <Stat label="Fees" value={<Money value={1.06} />} />
          </CardContent>
          <CardFooter className="text-xs text-muted">
            Open 1 / 3 · restarts 24 h: 1
            <Tabs defaultValue="a" className="ml-auto">
              <TabsList aria-label="Layout demo">
                <TabsTrigger value="a">A</TabsTrigger>
                <TabsTrigger value="b">B</TabsTrigger>
              </TabsList>
            </Tabs>
          </CardFooter>
        </Card>
      </div>
    </Section>
  );
}
