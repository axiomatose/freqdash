import { describeError } from '../log';

export interface StopResult {
  ok: boolean;
  /** `stopped`, `already-stopped`, or the failure reason (never contains the token). */
  message: string;
}

/** Asks the killswitch agent to stop one container. Never throws. */
export async function stopContainer(
  agentUrl: string,
  token: string,
  container: string,
  fetchImpl: typeof fetch = fetch,
): Promise<StopResult> {
  try {
    const res = await fetchImpl(`${agentUrl.replace(/\/+$/, '')}/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ container }),
      // docker stop waits up to its own timeout for the bot to exit.
      signal: AbortSignal.timeout(40_000),
    });
    const body = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: string; error?: string };
    if (res.ok && body.ok === true) return { ok: true, message: body.result ?? 'stopped' };
    return { ok: false, message: body.error ?? `agent answered ${res.status}` };
  } catch (err) {
    return { ok: false, message: describeError(err) };
  }
}
