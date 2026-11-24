import type { NextRequest } from 'next/server';
import { gateRequest } from '@/server/auth/gate';

// Next.js 16 file convention: `src/proxy.ts` (formerly middleware.ts) runs on the Node.js runtime and exports a
// function named `proxy` (or a default export) plus an optional `config`. All logic lives in the gate so it can be
// tested directly; gate.ts is database-free, so the SQLite driver stays out of this bundle. Route handlers are
// additionally wrapped in `withAuth` (which also checks the user in the database) and never rely on this gate alone.
export function proxy(req: NextRequest) {
  return gateRequest(req);
}

export const config = {
  // Everything except the build's static chunks and optimized images. Public assets and the login page are decided by
  // `isPublicPath` (an allowlist), not by file extension: an extension-based exclusion would also skip pages such as
  // /bots/x.png. The matcher must be a constant so Next can analyze it at build time.
  matcher: ['/((?!_next/static|_next/image).*)'],
};
