import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every value stays server-side: a browser-exposed variable (the Next.js public prefix) would be inlined into the
// client bundle. The prefix is assembled at runtime so this file itself does not contain it.
const FORBIDDEN = ['NEXT', 'PUBLIC', ''].join('_');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx|css|mjs|js|json)$/.test(entry.name) ? [path] : [];
  });
}

describe('client-visible environment', () => {
  it('uses no public-prefixed environment variables anywhere in src', () => {
    const offenders = sourceFiles('src').filter((file) => readFileSync(file, 'utf8').includes(FORBIDDEN));
    expect(offenders).toEqual([]);
  });

  it('none of the shipped env examples or deployment files define one', () => {
    // Dockerfile and compose files are not part of the Docker build context, so skip whatever is absent there.
    const files = [
      '.env.example',
      '.env.dev.example',
      'compose.yaml',
      'compose.dev.yaml',
      'Dockerfile',
      'next.config.ts',
    ];
    for (const file of files.filter((f) => existsSync(f))) {
      expect(readFileSync(file, 'utf8')).not.toContain(FORBIDDEN);
    }
  });
});
