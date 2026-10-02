import { randomInt } from 'node:crypto';
import { describe, expect, it } from 'vitest';

/**
 * Guards the runtime assumptions the whole game depends on, so a misconfigured
 * host (small-ICU Node, missing tz data, wrong engine) fails loudly in CI.
 */
describe('runtime environment', () => {
  it('runs on Node 22.12+', () => {
    const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
    expect(major > 22 || (major === 22 && minor >= 12)).toBe(true);
  });

  it('has IANA data for Asia/Tehran (full ICU)', () => {
    const tz = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Tehran' });
    expect(tz.resolvedOptions().timeZone).toBe('Asia/Tehran');
  });

  it('resolves Tehran wall-clock time from the tz database, not a fixed offset', () => {
    const wallClock = (iso: string) =>
      new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Tehran',
        hourCycle: 'h23',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(iso));

    // Iran abolished DST in 2022: +03:30 all year now…
    expect(wallClock('2026-01-01T00:00:00Z')).toBe('01/01/2026, 03:30');
    expect(wallClock('2026-07-01T00:00:00Z')).toBe('01/07/2026, 03:30');
    // …but historical instants must still use the DST rules of their time (+04:30).
    expect(wallClock('2021-07-01T00:00:00Z')).toBe('01/07/2021, 04:30');
  });

  it('provides a CSPRNG integer source and native BigInt', () => {
    const n = randomInt(1, 11);
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThanOrEqual(10);
    expect(10n ** 30n).toBe(1_000_000_000_000_000_000_000_000_000_000n);
  });
});
