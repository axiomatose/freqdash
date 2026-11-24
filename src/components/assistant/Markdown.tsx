'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/components/ui/utils';

/** Assistant text as markdown: no raw HTML, links open in a new tab, tables scroll instead of overflowing. */
export function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <div className={cn('min-w-0 text-[15px] leading-relaxed break-words', streaming && 'fd-streaming')}>
      <ReactMarkdown
        // Models write "~$77" and "~14h" for "about": a lone tilde must not start a strikethrough (only ~~double~~ does).
        remarkPlugins={[[remarkGfm, { singleTilde: false }]]}
        skipHtml
        components={{
          p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline underline-offset-2 hover:opacity-80"
            >
              {children}
            </a>
          ),
          ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
          h1: ({ children }) => <h3 className="mt-4 mb-1 text-base font-semibold">{children}</h3>,
          h2: ({ children }) => <h3 className="mt-4 mb-1 text-base font-semibold">{children}</h3>,
          h3: ({ children }) => <h4 className="mt-3 mb-1 text-sm font-semibold">{children}</h4>,
          strong: ({ children }) => <strong className="font-semibold text-text">{children}</strong>,
          blockquote: ({ children }) => (
            <blockquote className="my-2 border-l-2 border-border pl-3 text-muted">{children}</blockquote>
          ),
          hr: () => <hr className="my-3 border-border" />,
          code: ({ className, children }) =>
            /language-/.test(className ?? '') ? (
              <code className="block">{children}</code>
            ) : (
              <code className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em]">{children}</code>
            ),
          pre: ({ children }) => (
            <pre className="my-2 overflow-x-auto rounded-lg border bg-bg p-3 font-mono text-xs leading-relaxed">
              {children}
            </pre>
          ),
          table: ({ children }) => (
            <div className="my-2 overflow-x-auto rounded-lg border">
              <table className="w-full text-sm">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border-b bg-surface-2 px-2.5 py-1.5 text-left font-medium">{children}</th>
          ),
          td: ({ children }) => <td className="border-b px-2.5 py-1.5 tabular-nums last:border-b-0">{children}</td>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
