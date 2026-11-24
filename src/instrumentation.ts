// Next.js calls register() once per server start. The poller only runs in the Node.js runtime (SQLite, fs).
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  const { boot } = await import('./server/boot');
  await boot();
}
