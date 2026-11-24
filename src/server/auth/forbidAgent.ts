import { apiError } from './gate';
import type { Session } from './session';

/** The read-only automation token may read the dashboard's data, but not the settings, chats, memories or devices. */
export function forbidAgentToken(session: Session): Response | null {
  return session.uid === null ? apiError(403, 'forbidden', 'This route is for signed-in users only.') : null;
}
