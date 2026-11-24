import { cn } from '@/components/ui/utils';

/** The freqdash mark: three rising candles on a dark tile. Same drawing as public/icons/icon.svg (flat fills here). */
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" role="img" aria-label="freqdash" className={cn('size-7 shrink-0', className)}>
      <rect width="512" height="512" rx="112" fill="#12151C" />
      <rect x="10" y="10" width="492" height="492" rx="102" fill="none" stroke="#232838" strokeWidth="12" />
      <g stroke="#6B9DFF" strokeWidth="14" strokeLinecap="round">
        <line x1="166" y1="236" x2="166" y2="410" opacity=".6" />
        <line x1="256" y1="176" x2="256" y2="380" opacity=".8" />
        <line x1="346" y1="98" x2="346" y2="330" />
      </g>
      <rect x="132" y="290" width="68" height="84" rx="16" fill="#4F8CFF" opacity=".55" />
      <rect x="222" y="214" width="68" height="120" rx="16" fill="#4F8CFF" opacity=".8" />
      <rect x="312" y="136" width="68" height="150" rx="16" fill="#6B9DFF" />
    </svg>
  );
}
