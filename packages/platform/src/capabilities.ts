import type { PlatformCapabilities } from './adapter.ts';
import type { PlatformId } from './events.ts';

/**
 * Limits of each platform, from its official API documentation. A platform is listed
 * here only once its adapter exists: Rubika's limits are added together with the
 * Rubika adapter, never guessed.
 *
 * Telegram (https://core.telegram.org/bots/api): 4096 characters per message text
 * after entity parsing, 1-64 bytes of callback_data.
 */
export const TELEGRAM_CAPABILITIES: PlatformCapabilities = {
  maxTextLength: 4096,
  maxCallbackDataBytes: 64,
  maxButtonsPerRow: 8,
  maxButtonRows: 100,
  canEditMessages: true,
};

export const PLATFORM_CAPABILITIES: Readonly<Partial<Record<PlatformId, PlatformCapabilities>>> = {
  telegram: TELEGRAM_CAPABILITIES,
};

export function capabilitiesOf(
  platform: PlatformId,
  registry: Readonly<Partial<Record<PlatformId, PlatformCapabilities>>> = PLATFORM_CAPABILITIES,
): PlatformCapabilities {
  const caps = registry[platform];
  if (!caps) throw new Error(`no capabilities registered for platform «${platform}»`);
  return caps;
}

/** Characters reserved around a ghost story for the frame (title, deadline, hint). */
export const GHOST_FRAME_RESERVE = 596;

/**
 * Longest ghost story every enabled platform can deliver in one message. A nightly
 * batch is shared by all platforms, so the strictest one decides.
 */
export function maxGhostStoryLength(
  platforms: readonly PlatformId[],
  registry: Readonly<Partial<Record<PlatformId, PlatformCapabilities>>> = PLATFORM_CAPABILITIES,
): { limit: number; decidedBy: PlatformId } {
  if (platforms.length === 0) throw new Error('at least one platform must be enabled');
  let best: { limit: number; decidedBy: PlatformId } | undefined;
  for (const platform of platforms) {
    const limit = capabilitiesOf(platform, registry).maxTextLength - GHOST_FRAME_RESERVE;
    if (!best || limit < best.limit) best = { limit, decidedBy: platform };
  }
  return best!;
}
