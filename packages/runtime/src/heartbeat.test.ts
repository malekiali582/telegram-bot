import { serviceHeartbeats } from '@lulu/database';
import type { TestDatabase } from '@lulu/database/testing';
import { createTestDatabase } from '@lulu/database/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startHeartbeat } from './heartbeat.ts';
import { silentLogger } from './logger.ts';

let t: TestDatabase;
beforeAll(async () => {
  t = await createTestDatabase();
});
afterAll(async () => {
  await t.close();
});

describe('service heartbeat', () => {
  it('reports at start, keeps reporting, and marks a clean stop', async () => {
    let clock = new Date('2026-10-12T10:00:00Z');
    const hb = await startHeartbeat(t.db, {
      service: 'worker',
      log: silentLogger,
      details: { mode: 'test' },
      intervalMs: 20,
      now: () => clock,
    });
    let [row] = await t.db.select().from(serviceHeartbeats);
    expect(row).toMatchObject({
      service: 'worker',
      instance: hb.instance,
      stoppedAt: null,
      details: { mode: 'test' },
    });
    expect(row!.lastSeenAt).toEqual(clock);

    clock = new Date('2026-10-12T10:00:30Z');
    await new Promise((r) => setTimeout(r, 80));
    [row] = await t.db.select().from(serviceHeartbeats);
    expect(row!.lastSeenAt).toEqual(clock);
    expect(row!.startedAt).toEqual(new Date('2026-10-12T10:00:00Z'));

    await hb.stop();
    [row] = await t.db.select().from(serviceHeartbeats);
    expect(row!.stoppedAt).toEqual(clock);
  });

  it('forgets processes gone for more than a week', async () => {
    await t.db.insert(serviceHeartbeats).values({
      service: 'bot',
      instance: 'old-host:1:abc',
      startedAt: new Date('2026-09-01T00:00:00Z'),
      lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    });
    const hb = await startHeartbeat(t.db, {
      service: 'bot',
      log: silentLogger,
      now: () => new Date('2026-10-12T10:00:00Z'),
    });
    const rows = await t.db.select().from(serviceHeartbeats);
    expect(rows.map((r) => r.instance)).not.toContain('old-host:1:abc');
    await hb.stop();
  });
});
