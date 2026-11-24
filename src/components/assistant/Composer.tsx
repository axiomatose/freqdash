'use client';

import { useEffect, useRef, useState } from 'react';
import { BorderBeam } from 'border-beam';
import { ArrowUp, Square } from 'lucide-react';
import { cn } from '@/components/ui/utils';

/**
 * The message box. A Beam of light travels its border while the assistant is working; at rest the border is quiet.
 * Enter sends, Shift+Enter starts a new line.
 */
export function Composer({
  busy,
  disabled,
  placeholder,
  onSend,
  onStop,
}: {
  busy: boolean;
  disabled?: boolean;
  placeholder: string;
  onSend: (text: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the text, up to a few lines.
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [text]);

  const submit = () => {
    const t = text.trim();
    if (t === '' || busy || disabled) return;
    onSend(t);
    setText('');
  };

  return (
    <BorderBeam
      size="md"
      colorVariant="ocean"
      theme="dark"
      strength={0.9}
      duration={2.4}
      active={busy}
      className="w-full rounded-2xl"
    >
      <div
        data-testid="composer"
        className={cn('flex items-end gap-2 rounded-2xl border bg-surface p-2 pl-4', disabled && 'opacity-60')}
      >
        <textarea
          ref={ref}
          value={text}
          rows={1}
          disabled={disabled}
          aria-label="Message the assistant"
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-44 min-h-11 flex-1 resize-none bg-transparent py-2.5 text-sm leading-relaxed outline-none placeholder:text-muted"
        />
        {busy ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-text outline-none transition-colors hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            <Square aria-hidden className="size-4 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={submit}
            disabled={text.trim() === '' || disabled}
            aria-label="Send"
            className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-strong text-white outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-40"
          >
            <ArrowUp aria-hidden className="size-5" />
          </button>
        )}
      </div>
    </BorderBeam>
  );
}
