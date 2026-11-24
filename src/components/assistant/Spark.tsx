import { cn } from '@/components/ui/utils';

/** The assistant's mark: eight rounded rays. Animated (`fd-spark`) while it is working. */
export function Spark({ working = false, className }: { working?: boolean; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-flex size-6 items-center justify-center text-accent', working && 'fd-spark', className)}
    >
      <svg
        viewBox="0 0 24 24"
        className="size-full"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        {Array.from({ length: 8 }, (_, i) => (
          <line key={i} x1="12" y1="3" x2="12" y2={i % 2 === 0 ? '8.2' : '6.4'} transform={`rotate(${i * 45} 12 12)`} />
        ))}
      </svg>
    </span>
  );
}
