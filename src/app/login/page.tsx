import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { sanitizeNext } from '@/server/auth/origin';
import { pageSession } from '@/server/auth/page';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Sign in - freqdash' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ next?: string | string[] }> }) {
  const { next } = await searchParams;
  const target = sanitizeNext(Array.isArray(next) ? next[0] : next);
  // The session is checked against the database: a cookie that was signed out elsewhere shows the form, not a loop.
  if ((await pageSession()) !== null) redirect(target);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0B0D12] px-4 py-8 text-[#E6E8EE]">
      <div className="w-full max-w-sm rounded-xl border border-[#232838] bg-[#12151C] p-6 sm:p-8">
        <div className="mb-6 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">freqdash</h1>
          <p className="text-sm text-[#8A93A6]">Sign in with your account.</p>
        </div>
        <LoginForm next={target} />
      </div>
    </main>
  );
}
