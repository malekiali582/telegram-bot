import { describe, expect, it } from 'vitest';
import type { PlatformCapabilities } from './adapter.ts';
import {
  GHOST_FRAME_RESERVE,
  TELEGRAM_CAPABILITIES,
  capabilitiesOf,
  maxGhostStoryLength,
} from './capabilities.ts';

describe('platform capabilities', () => {
  it('knows Telegram and refuses to guess for platforms without an adapter', () => {
    expect(capabilitiesOf('telegram')).toBe(TELEGRAM_CAPABILITIES);
    expect(() => capabilitiesOf('rubika')).toThrow(/no capabilities/);
  });

  it('limits ghost stories by the strictest enabled platform', () => {
    expect(maxGhostStoryLength(['telegram'])).toEqual({
      limit: 4096 - GHOST_FRAME_RESERVE,
      decidedBy: 'telegram',
    });
    const smallRubika: PlatformCapabilities = { ...TELEGRAM_CAPABILITIES, maxTextLength: 2000 };
    const registry = { telegram: TELEGRAM_CAPABILITIES, rubika: smallRubika };
    expect(maxGhostStoryLength(['telegram', 'rubika'], registry)).toEqual({
      limit: 2000 - GHOST_FRAME_RESERVE,
      decidedBy: 'rubika',
    });
    expect(() => maxGhostStoryLength([])).toThrow();
  });
});
