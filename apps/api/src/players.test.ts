import { auditLogs, transactions } from '@lulu/database';
import { claimLolo } from '@lulu/domain';
import type { TestGame } from '@lulu/domain/testing';
import { createTestGame, grantPoints, newGroupWithChat, newPlayer } from '@lulu/domain/testing';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AdjustBalanceResult,
  ApiErrorBody,
  NamedKind,
  PlayerDetailView,
  PlayerListView,
  TransactionListView,
} from './contract.ts';
import { jalaliDateTime, parsePoints, pointsText, safeText } from './csv.ts';
import type { LoggedIn, TestApi } from './testing.ts';
import { addAdmin, createTestApi, loginAs } from './testing.ts';

let game: TestGame;
let api: TestApi;
let helper: LoggedIn;

beforeEach(async () => {
  game = await createTestGame('2026-10-12T10:00:00Z');
  api = await createTestApi(game);
  await addAdmin(game, 'helper', 'admin');
  helper = await loginAs(api, 'helper');
});
afterEach(async () => {
  await api.app.close();
  await game.close();
});

const get = async <T>(url: string) => {
  const r = await api.app.inject({ method: 'GET', url, headers: { cookie: helper.cookie } });
  return { status: r.statusCode, body: r.json<T>() };
};
const post = async <T>(url: string, payload: object) => {
  const r = await api.app.inject({ method: 'POST', url, headers: helper.writeHeaders, payload });
  return { status: r.statusCode, body: r.json<T>() };
};
const key = (n = 1) => `form-${String(n).padStart(16, '0')}`;

describe('csv helpers', () => {
  it('keep money exact, dates Jalali, and player text out of formulas', () => {
    expect(pointsText(12_345n)).toBe('123.45');
    expect(pointsText(-5n)).toBe('-0.05');
    expect(pointsText(123_456_789_012_345_678_901n)).toBe('1234567890123456789.01');
    expect(parsePoints('-12.5')).toBe(-1250n);
    expect(parsePoints('250')).toBe(25_000n);
    for (const bad of ['', '1.234', '1e5', '۱۰', '--1', '1,000'])
      expect(parsePoints(bad)).toBeNull();
    expect(jalaliDateTime(new Date('2026-10-12T14:05:09Z'))).toBe('1405/07/20 17:35:09');
    expect(safeText('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeText('-1+1')).toBe(`'-1+1`);
    expect(safeText('سارا')).toBe('سارا');
  });
});

describe('players', () => {
  it('are listed and searched with a total and pages', async () => {
    for (let i = 0; i < 3; i++) await newPlayer(game, `لولو ${i}`);
    const { status, body } = await get<PlayerListView>(
      '/api/players?q=' + encodeURIComponent('لولو 1'),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({ total: 1, page: 1, pageSize: 25 });
    expect(body.items[0]).toMatchObject({ displayName: 'لولو 1', levelName: 'روح', cash: '0' });
    expect((await get('/api/players?banned=maybe')).status).toBe(400);
  });

  it('open a full profile', async () => {
    const p = await newPlayer(game, '<b>نام</b>');
    const { groupId } = await newGroupWithChat(game);
    await claimLolo(game.ctx, { userId: p, groupId });
    const { status, body } = await get<PlayerDetailView>(`/api/players/${p}`);
    expect(status).toBe(200);
    expect(body.user.displayName).toBe('<b>نام</b>');
    expect(body).toMatchObject({ level: 1, levelName: 'روح', cash: '100', treasury: '0' });
    expect(body.groups[0]).toMatchObject({ groupId, streak: 1 });
    expect((await get(`/api/players/999999`)).status).toBe(404);
  });
});

describe('balance corrections', () => {
  it('post a compensating transaction with the reason and an audit entry, once per form', async () => {
    const p = await newPlayer(game);
    const ok = await post<AdjustBalanceResult>(`/api/players/${p}/adjust`, {
      wallet: 'cash',
      amount: '250.5',
      reason: 'جبران باگ ارتقا',
      idempotencyKey: key(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ balance: '25050', duplicate: false });

    const again = await post<AdjustBalanceResult>(`/api/players/${p}/adjust`, {
      wallet: 'cash',
      amount: '250.5',
      reason: 'جبران باگ ارتقا',
      idempotencyKey: key(),
    });
    expect(again.body).toEqual({ transactionId: null, balance: null, duplicate: true });

    const [tx] = await game.ctx.db
      .select()
      .from(transactions)
      .where(eq(transactions.kind, 'admin_adjustment'));
    expect(tx).toMatchObject({ reason: 'جبران باگ ارتقا', userId: p });
    expect(tx!.adminUserId).not.toBeNull();
    const [audit] = await game.ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'balance.adjust'));
    expect(audit).toMatchObject({ targetId: String(p), reason: 'جبران باگ ارتقا' });
  });

  it('refuse a missing reason, a bad amount and a negative balance', async () => {
    const p = await newPlayer(game);
    await grantPoints(game, p, 10);
    const send = (amount: string, reason = 'دلیل') =>
      post<ApiErrorBody>(`/api/players/${p}/adjust`, {
        wallet: 'cash',
        amount,
        reason,
        idempotencyKey: key(Math.floor(Math.random() * 1e9)),
      });
    expect((await send('5', '   ')).status).toBe(400);
    for (const bad of ['0', '1.234', 'ده']) expect((await send(bad)).status).toBe(400);
    const tooMuch = await send('-11');
    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error.message).toContain('10.00');
    expect((await send('-10')).status).toBe(200);
  });
});

describe('ban', () => {
  it('needs a reason and reports a no-op', async () => {
    const p = await newPlayer(game);
    expect((await post(`/api/players/${p}/ban`, { banned: true, reason: '' })).status).toBe(400);
    expect((await post(`/api/players/${p}/ban`, { banned: true, reason: 'تقلب' })).status).toBe(
      200,
    );
    const twice = await post<ApiErrorBody>(`/api/players/${p}/ban`, {
      banned: true,
      reason: 'تقلب',
    });
    expect(twice.status).toBe(409);
    expect(twice.body.error.message).toBe('این بازیکن از قبل مسدود است.');
    const detail = await get<PlayerDetailView>(`/api/players/${p}`);
    expect(detail.body.user).toMatchObject({ banReason: 'تقلب' });
    expect(
      (await post(`/api/players/${p}/ban`, { banned: false, reason: 'رفع اشتباه' })).status,
    ).toBe(200);
  });
});

describe('transactions', () => {
  it('filter, page with an opaque cursor and summarize the first page', async () => {
    const p = await newPlayer(game);
    for (let i = 1; i <= 60; i++) await grantPoints(game, p, i);
    const first = await get<TransactionListView>(`/api/transactions?userId=${p}`);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(50);
    expect(first.body.summary).toEqual({ count: 60, amount: String(183_000) });
    expect(first.body.items[0]).toMatchObject({ kind: 'test_grant', playerDelta: '6000' });
    const second = await get<TransactionListView>(
      `/api/transactions?userId=${p}&cursor=${first.body.next}`,
    );
    expect(second.body.items).toHaveLength(10);
    expect(second.body).toMatchObject({ next: null, summary: null });
    expect((await get(`/api/transactions?cursor=garbage`)).status).toBe(400);
    expect((await get(`/api/transactions?from=1405-07-20`)).status).toBe(400);
    expect((await get(`/api/transactions?min=12.345`)).status).toBe(400);
    const big = await get<TransactionListView>(`/api/transactions?userId=${p}&min=59`);
    expect(big.body.summary?.count).toBe(2);
  });

  it('name every kind in Persian', async () => {
    const { body } = await get<NamedKind[]>('/api/transactions/kinds');
    expect(body).toContainEqual({ kind: 'lolo_reward', name: 'پاداش لولو' });
  });

  it('export to CSV for Excel, exactly, without formula injection, and audit the export', async () => {
    const p = await newPlayer(game, '=cmd|"/c calc"!A1');
    const { groupId } = await newGroupWithChat(game, '+گروه');
    await claimLolo(game.ctx, { userId: p, groupId });
    await post(`/api/players/${p}/adjust`, {
      wallet: 'cash',
      amount: '-0.5',
      reason: '@دلیل, با "نقل‌قول"',
      idempotencyKey: key(7),
    });

    const res = await api.app.inject({
      method: 'GET',
      url: `/api/transactions/export.csv?userId=${p}`,
      headers: { cookie: helper.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="lulu-transactions-/);
    const text = res.body;
    expect(text.startsWith('﻿')).toBe(true);
    const lines = text.slice(1).split('\r\n').filter(Boolean);
    expect(lines).toHaveLength(3);
    expect(lines[0]!.split(',')[0]).toBe('شناسه');
    const [adjust, lolo] = [lines[1]!, lines[2]!];
    expect(adjust).toContain(
      'اصلاح مدیر,admin_adjustment,1405/07/20 13:30:00,2026-10-12T10:00:00.000Z',
    );
    expect(adjust).toContain(`"'=cmd|""/c calc""!A1"`);
    expect(adjust).toContain(',0.50,-0.50,helper,');
    expect(adjust).toContain(`"'@دلیل, با ""نقل‌قول"""`);
    expect(lolo).toContain(`'+گروه`);
    expect(lolo).toContain(',1.00,1.00,');

    const [audit] = await game.ctx.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.action, 'transactions.export'));
    expect(audit).toMatchObject({ details: { userId: p } });
  });
});
