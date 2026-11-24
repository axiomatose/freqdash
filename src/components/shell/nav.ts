import {
  Activity,
  ArrowLeftRight,
  Bell,
  BrainCircuit,
  ChartCandlestick,
  LayoutDashboard,
  type LucideIcon,
} from 'lucide-react';

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Shows the critical + warning finding count next to the label. */
  alerts?: boolean;
}

/** Desktop sidebar, top section. Findings carries the alert badge. */
export const NAV_MAIN: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/chart', label: 'Chart', icon: ChartCandlestick },
  { href: '/trades', label: 'Trades', icon: ArrowLeftRight },
  { href: '/strategies', label: 'Strategies', icon: BrainCircuit },
  { href: '/findings', label: 'Findings', icon: Bell, alerts: true },
];

export const NAV_STATUS: NavItem = { href: '/status', label: 'Status', icon: Activity };

/** Mobile bottom tab bar (the fifth tab, "More", opens a sheet). Findings is called "Alerts" here. */
export const TAB_ITEMS: readonly NavItem[] = [
  { href: '/', label: 'Overview', icon: LayoutDashboard },
  { href: '/chart', label: 'Chart', icon: ChartCandlestick },
  { href: '/trades', label: 'Trades', icon: ArrowLeftRight },
  { href: '/findings', label: 'Alerts', icon: Bell, alerts: true },
];

/** `/` matches only itself; every other href also matches its sub-paths (`/bots/x` is inside `/bots`). */
export function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** The More tab lights up for the pages that live in its sheet. */
export function isMoreActive(pathname: string): boolean {
  return isActive(pathname, '/status') || isActive(pathname, '/bots');
}

const TITLES: readonly [string, string][] = [
  ['/', 'Overview'],
  ['/chart', 'Chart'],
  ['/trades', 'Trades'],
  ['/strategies', 'Strategies'],
  ['/findings', 'Findings'],
  ['/status', 'Status'],
  ['/ui-kit', 'UI kit'],
];

/** Heading shown in the top bar. Bot pages use the bot's display name when it is known. */
export function pageTitle(pathname: string, botNameOf?: (botId: string) => string | undefined): string {
  const bot = /^\/bots\/([^/]+)/.exec(pathname);
  if (bot?.[1]) {
    const id = decodeURIComponent(bot[1]);
    return botNameOf?.(id) ?? id;
  }
  return TITLES.find(([href]) => isActive(pathname, href))?.[1] ?? 'freqdash';
}

/** What the tab title and the alert badges count: critical + warning findings (info never nags). */
export function alertCount(findings: { critical: number; warning: number } | null | undefined): number {
  return findings ? findings.critical + findings.warning : 0;
}
