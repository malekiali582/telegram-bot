import type { DomainContext } from '@lulu/domain';
import type { LogLevel } from '@lulu/runtime';
import { createLogger } from '@lulu/runtime';
import { describe, expect, it } from 'vitest';
import { logGroupPrivacy, makeUpdateHandler, pollingObserver } from './runtime.ts';

interface Line {
  level: LogLevel;
  msg: string;
  [field: string]: unknown;
}

function capture() {
  const lines: Line[] = [];
  const log = createLogger({
    level: 'trace',
    write: (line) => lines.push(JSON.parse(line) as Line),
  });
  return { log, lines, msgs: () => lines.map((l) => `${l.level} ${l.msg}`) };
}

type Prev = Parameters<ReturnType<typeof pollingObserver>>[0];
const okUpdates = (n: number) => ({ ok: true, result: Array.from({ length: n }, () => ({})) });

/** Runs one call through the observer with a fake network layer. */
function call(
  observer: ReturnType<typeof pollingObserver>,
  method: string,
  respond: () => Promise<unknown>,
  signal?: AbortSignal,
) {
  const prev = (() => respond()) as unknown as Prev;
  return (observer as (...a: unknown[]) => Promise<unknown>)(prev, method, { offset: 7 }, signal);
}

describe('long polling is observable', () => {
  it('reports the first success, failures, rejections and the recovery', async () => {
    const { log, lines, msgs } = capture();
    const observer = pollingObserver(log);

    await call(observer, 'getUpdates', () => Promise.resolve(okUpdates(0)));
    await expect(
      call(observer, 'getUpdates', () => Promise.reject(new Error('socket hang up'))),
    ).rejects.toThrow('socket hang up');
    const conflict = {
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates request',
    };
    expect(await call(observer, 'getUpdates', () => Promise.resolve(conflict))).toBe(conflict);
    await call(observer, 'getUpdates', () => Promise.resolve(okUpdates(2)));
    await call(observer, 'getUpdates', () => Promise.resolve(okUpdates(0)));

    expect(msgs()).toEqual([
      'info telegram getUpdates works',
      'trace telegram getUpdates',
      'warn telegram getUpdates failed (network); retrying',
      'warn telegram getUpdates rejected',
      'info telegram getUpdates recovered',
      'debug telegram getUpdates',
      'trace telegram getUpdates',
    ]);
    expect(lines[3]).toMatchObject({ failures: 2, code: 409 });
    expect(lines[4]).toMatchObject({ afterFailures: 2 });
    expect(lines[5]).toMatchObject({ count: 2, offset: 7 });
  });

  it('stays quiet when polling is stopped on purpose and for other methods', async () => {
    const { log, msgs } = capture();
    const observer = pollingObserver(log);
    const aborted = AbortSignal.abort();
    await expect(
      call(observer, 'getUpdates', () => Promise.reject(new Error('aborted')), aborted),
    ).rejects.toThrow('aborted');
    await call(observer, 'sendMessage', () => Promise.resolve({ ok: false, error_code: 400 }));
    expect(msgs()).toEqual([]);
  });
});

describe('the path of an update is traced at debug level', () => {
  const BOT_ID = 777;
  const alice = { id: 42, is_bot: false, first_name: 'Ali' };
  const privateChat = { id: 42, type: 'private' as const, first_name: 'Ali' };
  const message = { message_id: 3, date: 1_700_000_000, chat: privateChat, from: alice };

  // Ignored events return before touching the database.
  const handler = (log: ReturnType<typeof capture>['log']) =>
    makeUpdateHandler(
      {
        ctx: {} as DomainContext,
        botUsername: 'LuluTestBot',
        memberRole: () => Promise.resolve('member'),
        log,
      },
      BOT_ID,
      log,
    );

  it('logs receipt, the reason an event is ignored and the outcome', async () => {
    const { log, lines } = capture();
    await handler(log)({ update_id: 9, message: { ...message, text: 'سلام' } });
    await handler(log)({
      update_id: 10,
      edited_message: { ...message, text: 'لولو', edit_date: 1 },
    });

    expect(lines.map((l) => [l.msg, l.updateId, l.reason ?? l.outcome ?? null])).toEqual([
      ['update received', 9, null],
      ['event ignored', '9', 'not a command (4 chars)'],
      ['event handled', '9', 'ignored'],
      ['update received', 10, null],
      ['event ignored', '10', 'edited message'],
      ['event handled', '10', 'ignored'],
    ]);
    expect(lines[0]).toMatchObject({
      kinds: ['message'],
      events: ['text'],
      chat: 'private',
      chatId: '42',
    });
    // Message text is user content and never logged.
    expect(JSON.stringify(lines)).not.toContain('سلام');
  });

  it('shows an update that produces no game event', async () => {
    const { log, lines } = capture();
    await handler(log)({ update_id: 11, message: { ...message } });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ msg: 'update received', events: [] });
  });
});

describe('group privacy is reported at startup', () => {
  const tg = (readsAllGroupMessages: boolean) =>
    ({ username: 'LuluBot', readsAllGroupMessages }) as Parameters<typeof logGroupPrivacy>[0];

  it('warns, with the fix, when Telegram says Group Privacy is still on', () => {
    const { log, lines } = capture();
    logGroupPrivacy(tg(false), log);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 'warn', bot: 'LuluBot' });
    expect(lines[0]!.msg).toContain('group privacy is ON');
    expect(String(lines[0]!.fix)).toContain('/setprivacy');
  });

  it('only notes it when plain group messages are delivered', () => {
    const { log, lines } = capture();
    logGroupPrivacy(tg(true), log);
    expect(lines.map((l) => l.level)).toEqual(['info']);
  });
});
