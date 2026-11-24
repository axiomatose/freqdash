import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { sanitizeNext } from '@/server/auth/origin';
import { pageSession } from '@/server/auth/page';
import { ChangePasswordForm } from './ChangePasswordForm';

export const dynamic = 'force-dynamic';

export const metadata: Metadata = { title: 'Change password - freqdash' };

export default async function ChangePasswordPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string | string[] }>;
}) {
  const { next } = await searchParams;
  const target = sanitizeNext(Array.isArray(next) ? next[0] : next);
  const session = await pageSession();
  if (session === null) redirect(`/login?next=${encodeURIComponent('/change-password')}`);

  return (
    <main className="flex min-h-dvh items-center justify-center bg-[#0B0D12] px-4 py-8 text-[#E6E8EE]">
      <div className="w-full max-w-sm rounded-xl border border-[#232838] bg-[#12151C] p-6 sm:p-8">
        <div className="mb-6 space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {session.pc ? 'Choose a new password' : 'Change password'}
          </h1>
          <p className="text-sm text-[#8A93A6]">
            {session.pc
              ? `Signed in as ${session.n ?? 'you'} with a temporary password. Pick your own to continue.`
              : `Signed in as ${session.n ?? 'you'}. Your other sessions will be signed out.`}
          </p>
        </div>
        <ChangePasswordForm next={target} username={session.n ?? ''} forced={session.pc} />
      </div>
    </main>
  );
}
