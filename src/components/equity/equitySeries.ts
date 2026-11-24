import type { EquityResponse } from '@/shared/types/api';

export interface EquityPointT {
  time: number;
  value: number;
}
export interface FlowMarker {
  time: number;
  kind: 'deposit' | 'withdrawal';
  text: string;
}

export interface EquitySeriesData {
  /** Solid area: points whose source is Kraken. */
  kraken: EquityPointT[];
  /** Dashed line: estimates from a bot wallet. */
  botWallet: EquityPointT[];
  markers: FlowMarker[];
}

const secondsOf = (ms: number): number => Math.floor(ms / 1000);

function unique(points: EquityPointT[]): EquityPointT[] {
  const out: EquityPointT[] = [];
  for (const p of [...points].sort((a, b) => a.time - b.time)) {
    if (out[out.length - 1]?.time === p.time) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/** Splits the equity points by source (bot-wallet estimates are drawn dashed) and places deposit/withdrawal markers. */
export function equitySeries(data: Pick<EquityResponse, 'points' | 'flows'>): EquitySeriesData {
  const kraken: EquityPointT[] = [];
  const botWallet: EquityPointT[] = [];
  for (const p of data.points) {
    (p.source === 'kraken' ? kraken : botWallet).push({ time: secondsOf(p.t), value: p.totalUsd });
  }
  const all = unique([...kraken, ...botWallet]);
  const markers: FlowMarker[] = [];
  for (const f of data.flows ?? []) {
    if (f.type !== 'deposit' && f.type !== 'withdrawal') continue;
    const at = secondsOf(f.at);
    // Markers must sit on an existing point: snap to the first point at or after the flow.
    const anchor = all.find((p) => p.time >= at) ?? all[all.length - 1];
    if (anchor === undefined) continue;
    markers.push({ time: anchor.time, kind: f.type, text: f.type === 'deposit' ? 'Deposit' : 'Withdrawal' });
  }
  markers.sort((a, b) => a.time - b.time);
  return { kraken: unique(kraken), botWallet: unique(botWallet), markers };
}
