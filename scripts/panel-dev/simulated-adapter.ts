import type { PlatformAdapter, PlatformId, SentMessageRef } from '@lulu/platform';
import { capabilitiesOf } from '@lulu/platform';

/**
 * A platform adapter that sends nothing: every message "succeeds" at once with a
 * message id starting `sim-`. `npm run dev:panel` runs the real worker with it, so the
 * outbox, retries and job history behave as in production, while no request ever
 * leaves the machine.
 */
export function simulatedAdapter(platform: PlatformId): PlatformAdapter & { sent: number } {
  let sent = 0;
  return {
    platform,
    // Rubika has no registered limits yet; the simulation borrows Telegram's.
    capabilities: capabilitiesOf('telegram'),
    get sent() {
      return sent;
    },
    send(message): Promise<SentMessageRef> {
      sent++;
      return Promise.resolve({
        platformChatId: message.platformChatId,
        messageId: `sim-${Date.now()}-${sent}`,
      });
    },
    edit: () => Promise.resolve(),
    answerButton: () => Promise.resolve(),
    getMemberRole: () => Promise.resolve('unknown'),
  };
}
