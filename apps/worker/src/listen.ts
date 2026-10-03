import type { Logger } from '@lulu/runtime';
import pg from 'pg';

/**
 * PostgreSQL LISTEN on a dedicated connection; reconnects after failures. Used to wake
 * the outbox sender the moment a transaction that queued messages commits.
 */
export function listenForNotifications(
  url: string,
  channel: string,
  onNotify: () => void,
  log: Logger,
): { close(): Promise<void> } {
  let closed = false;
  let client: pg.Client | undefined;

  const connect = async () => {
    if (closed) return;
    const c = new pg.Client({ connectionString: url, application_name: 'lulu-listen' });
    c.on('notification', () => onNotify());
    c.on('error', (err) => {
      log.warn('listen connection lost; reconnecting', { error: err });
      void c.end().catch(() => {});
      if (!closed) setTimeout(() => void connect(), 5_000);
    });
    try {
      await c.connect();
      await c.query(`LISTEN ${channel}`);
      client = c;
    } catch (err) {
      log.warn('listen connect failed; retrying', { error: err });
      void c.end().catch(() => {});
      if (!closed) setTimeout(() => void connect(), 5_000);
    }
  };
  void connect();

  return {
    async close() {
      closed = true;
      await client?.end().catch(() => {});
    },
  };
}
