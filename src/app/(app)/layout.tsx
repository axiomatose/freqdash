import { AppProviders } from '@/components/shell/AppProviders';
import { AppShell } from '@/components/shell/AppShell';
import { requirePageSession } from '@/server/auth/page';

// Everything behind the login: providers (TanStack Query, tooltips, toasts) and the responsive app shell.
// Pages render only their own content; the shell already provides <main>, the page title and the banners.
// The session is checked here, with the database: the proxy only knows whether a session cookie is present.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  await requirePageSession();
  return (
    <AppProviders>
      <AppShell>{children}</AppShell>
    </AppProviders>
  );
}
