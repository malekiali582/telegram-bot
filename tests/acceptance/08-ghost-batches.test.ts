/**
 * Acceptance 8 (spec §19.8): an incomplete batch is rejected, the switch to a new
 * batch is atomic at Tehran midnight, a player sees no story twice in a day, and
 * ghosts found before a switch can still be answered until their deadline.
 */
import { ghostBatches } from '@lulu/database';
import { testBackend, usingRealPostgres } from '@lulu/database/testing';
import {
  activateDueBatches,
  attachEncounterMessage,
  ghostContentStatus,
  hearGhost,
  importGhostBatch,
  searchGhost,
  validateGhostBatch,
} from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import {
  createTestGame,
  ghostBatchInput,
  newGroup,
  newPlayer,
  tehranTime,
} from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let game: TestGame;
let group: number;
const DAY1 = '2026-10-02';
const DAY2 = '2026-10-03';
const DAY3 = '2026-10-04';

// Each test gets its own database: batch state is global.
beforeEach(async () => {
  game = await createTestGame();
  game.clock.set(tehranTime(DAY1, '08:00:00'));
  game.rng.fallback = 'min';
  group = await newGroup(game);
});
afterEach(async () => {
  await game.close();
});

const at = (date: string, time: string) => game.clock.set(tehranTime(date, time));
const importBatch = (input: unknown) => importGhostBatch(game.ctx, input, { source: 'file' });
const search = (userId: number) =>
  searchGhost(game.ctx, { userId, groupId: group, platform: 'telegram', chatId: 'chat' });
const activeKeys = async () =>
  (await game.ctx.db.select().from(ghostBatches).where(eq(ghostBatches.status, 'active'))).map(
    (b) => b.batchKey,
  );

describe(`acceptance 8 — batch validation (${testBackend()})`, () => {
  const valid = ghostBatchInput(DAY2, 'next');
  const broken: [string, unknown][] = [
    ['four stories', { ...valid, stories: valid.stories.slice(0, 4) }],
    ['six stories', { ...valid, stories: [...valid.stories, { id: 'x', text: 'y' }] }],
    [
      'an empty text',
      { ...valid, stories: valid.stories.map((s, i) => (i === 2 ? { ...s, text: '   ' } : s)) },
    ],
    [
      'duplicate ids',
      {
        ...valid,
        stories: valid.stories.map((s, i) => (i === 4 ? { ...s, id: valid.stories[0]!.id } : s)),
      },
    ],
    ['another time zone', { ...valid, timezone: 'UTC' }],
    ['an impossible date', { ...valid, activeDate: '2026-02-30' }],
    ['no batchId', { ...valid, batchId: '' }],
    ['unknown fields', { ...valid, extra: true }],
    ['not an object', 'just text'],
  ];

  it.each(broken)(
    'rejects a batch with %s and leaves the live batch untouched',
    async (_, input) => {
      await importBatch(ghostBatchInput(DAY1, 'live'));
      await activateDueBatches(game.ctx);
      const result = await importBatch(input);
      expect(result.status).toBe('invalid');
      expect(validateGhostBatch(input).ok).toBe(false);
      at(DAY2, '00:00:01');
      await activateDueBatches(game.ctx);
      expect(await activeKeys()).toEqual(['live']);
    },
  );

  it('imports idempotently and refuses conflicting or retroactive batches', async () => {
    expect(await importBatch(ghostBatchInput(DAY2, 'b'))).toMatchObject({ status: 'imported' });
    expect(await importBatch(ghostBatchInput(DAY2, 'b'))).toEqual({
      status: 'already_imported',
      batchId: 'b',
    });
    const edited = ghostBatchInput(DAY2, 'b');
    edited.stories[0]!.text = 'متن تازه';
    expect(await importBatch(edited)).toEqual({ status: 'conflict', reason: 'different_content' });
    expect(await importBatch(ghostBatchInput(DAY2, 'c'))).toEqual({
      status: 'conflict',
      reason: 'date_taken',
    });
    expect(await importBatch(ghostBatchInput('2026-10-01', 'old'))).toEqual({
      status: 'conflict',
      reason: 'date_in_past',
    });
  });
});

describe(`acceptance 8 — switching batches (${testBackend()})`, () => {
  it('switches atomically at 00:00 Tehran, not a millisecond earlier', async () => {
    await importBatch(ghostBatchInput(DAY1, 'today'));
    await importBatch(ghostBatchInput(DAY2, 'tomorrow'));
    await activateDueBatches(game.ctx);
    expect(await activeKeys()).toEqual(['today']);

    at(DAY1, '23:59:59.999');
    expect(await activateDueBatches(game.ctx)).toEqual({
      activated: null,
      retired: null,
      cancelled: [],
    });
    const before = await search(await newPlayer(game));
    expect(before).toMatchObject({ status: 'found', text: '«متن 1 از today»' });

    at(DAY2, '00:00:00');
    expect(await activateDueBatches(game.ctx)).toEqual({
      activated: 'tomorrow',
      retired: 'today',
      cancelled: [],
    });
    expect(await activeKeys()).toEqual(['tomorrow']);
    expect(await search(await newPlayer(game))).toMatchObject({ text: '«متن 1 از tomorrow»' });
  });

  it('activates lazily on the first search of the day, without the worker', async () => {
    await importBatch(ghostBatchInput(DAY1, 'today'));
    await importBatch(ghostBatchInput(DAY2, 'tomorrow'));
    at(DAY2, '07:00:00');
    expect(await search(await newPlayer(game))).toMatchObject({ text: '«متن 1 از tomorrow»' });
  });

  it('never shows the same story twice to a player on one day', async () => {
    await importBatch(ghostBatchInput(DAY1, 'today'));
    const userId = await newPlayer(game);
    const texts: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await search(userId); // always picks the first remaining story
      if (r.status !== 'found') throw new Error(r.status);
      texts.push(r.text);
      game.clock.advance(30 * 60_000);
    }
    expect(new Set(texts).size).toBe(3);
  });

  it('keeps an earlier ghost answerable after the switch, until its own deadline', async () => {
    await importBatch(ghostBatchInput(DAY1, 'today'));
    await importBatch(ghostBatchInput(DAY2, 'tomorrow'));
    at(DAY1, '23:00:00');
    const owner = await newPlayer(game);
    const ghost = await search(owner);
    if (ghost.status !== 'found') throw new Error(ghost.status);
    await attachEncounterMessage(game.ctx, { encounterId: ghost.encounterId, messageId: '77' });

    at(DAY2, '01:00:00');
    await activateDueBatches(game.ctx);
    expect(await activeKeys()).toEqual(['tomorrow']);
    expect(
      await hearGhost(game.ctx, {
        userId: owner,
        platform: 'telegram',
        chatId: 'chat',
        replyToMessageId: '77',
      }),
    ).toMatchObject({ status: 'ok', fearReward: 10 });
    // the retired batch and its stories are kept
    const [retired] = await game.ctx.db
      .select()
      .from(ghostBatches)
      .where(eq(ghostBatches.batchKey, 'today'));
    expect(retired?.status).toBe('retired');
  });

  it("keeps the previous batch live when tonight's batch is missing, and warns", async () => {
    expect((await ghostContentStatus(game.ctx)).warning).toBe('no_active_batch');
    await importBatch(ghostBatchInput(DAY1, 'today'));
    await activateDueBatches(game.ctx);
    expect((await ghostContentStatus(game.ctx)).warning).toBeNull();
    at(DAY2, '09:00:00');
    await activateDueBatches(game.ctx);
    expect(await ghostContentStatus(game.ctx)).toMatchObject({
      warning: 'stale_batch',
      active: { batchId: 'today', activeDate: DAY1 },
    });
    expect((await search(await newPlayer(game))).status).toBe('found');
  });

  it('after missed nights, goes straight to the newest due batch', async () => {
    await importBatch(ghostBatchInput(DAY1, 'd1'));
    await importBatch(ghostBatchInput(DAY2, 'd2'));
    await importBatch(ghostBatchInput(DAY3, 'd3'));
    at(DAY3, '10:00:00');
    expect(await activateDueBatches(game.ctx)).toEqual({
      activated: 'd3',
      retired: null,
      cancelled: ['d2', 'd1'],
    });
  });
});

describe.runIf(usingRealPostgres)('acceptance 8 — concurrent activation on real PostgreSQL', () => {
  it('five workers at midnight activate the batch once; exactly one stays live', async () => {
    await importBatch(ghostBatchInput(DAY1, 'today'));
    await importBatch(ghostBatchInput(DAY2, 'tomorrow'));
    await activateDueBatches(game.ctx);
    at(DAY2, '00:00:00');
    const results = await Promise.all(
      Array.from({ length: 5 }, () => activateDueBatches(game.ctx)),
    );
    expect(results.filter((r) => r.activated === 'tomorrow')).toHaveLength(1);
    expect(await activeKeys()).toEqual(['tomorrow']);
  });
});
