'use client';

import { useEffect, useState } from 'react';
import { BorderBeam } from 'border-beam';
import { Spark } from './Spark';

const IDLE_WORDS = ['Thinking', 'Pondering', 'Connecting the dots', 'Weighing it up', 'Checking the numbers'];

/** Words that rotate while the model is thinking; a tool label ("Checking Kraken orders") replaces them while one runs. */
export function ThinkingIndicator({ label }: { label: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % IDLE_WORDS.length), 2600);
    return () => clearInterval(t);
  }, []);
  const text = label === 'Thinking' || label === '' ? (IDLE_WORDS[i] as string) : label;
  return (
    <BorderBeam
      size="sm"
      colorVariant="sunset"
      theme="dark"
      strength={0.85}
      duration={2.6}
      className="w-fit rounded-full"
    >
      <div
        role="status"
        aria-live="polite"
        className="flex items-center gap-2 rounded-full border bg-surface px-3 py-1.5"
      >
        <Spark working />
        <span key={text} className="fd-word-in fd-shimmer text-sm">
          {text}
        </span>
        <span aria-hidden className="flex gap-0.5 text-muted">
          <span className="fd-dot" style={{ animationDelay: '0ms' }}>
            ·
          </span>
          <span className="fd-dot" style={{ animationDelay: '150ms' }}>
            ·
          </span>
          <span className="fd-dot" style={{ animationDelay: '300ms' }}>
            ·
          </span>
        </span>
      </div>
    </BorderBeam>
  );
}
