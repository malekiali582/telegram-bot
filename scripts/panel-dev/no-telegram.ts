import net from 'node:net';

/**
 * Blocks every connection from this process to Telegram. The live bot runs elsewhere
 * with the same token, so the panel's development mode must never talk to Telegram:
 * not by polling, not by sending, not by a stray getMe.
 *
 * Every TCP connection in Node (http, https, tls, fetch/undici, grammY) goes through
 * `net.Socket.prototype.connect`, so the check sits there and sees the host name or
 * address before any DNS lookup or byte is sent.
 */

const TELEGRAM_HOST = /(^|\.)(telegram\.org|telegram\.me|t\.me|telesco\.pe|tdesktop\.com)\.?$/i;
/** Telegram's own address ranges (AS62041 / AS59930 / AS44907), for connections by IP. */
const TELEGRAM_RANGES: [number, number][] = [
  ['149.154.160.0', 20],
  ['91.108.4.0', 22],
  ['91.108.8.0', 22],
  ['91.108.12.0', 22],
  ['91.108.16.0', 22],
  ['91.108.20.0', 22],
  ['91.108.56.0', 22],
  ['95.161.64.0', 20],
].map(([base, bits]) => [ipv4ToInt(base as string)!, bits as number]);

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    const n = Number(part);
    if (!/^\d{1,3}$/.test(part) || n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

export function isTelegramHost(host: string): boolean {
  const name = host.replace(/^\[|\]$/g, '').replace(/^::ffff:/i, '');
  if (TELEGRAM_HOST.test(name)) return true;
  const ip = ipv4ToInt(name);
  if (ip === null) return false;
  return TELEGRAM_RANGES.some(
    ([base, bits]) => Math.floor(ip / 2 ** (32 - bits)) === Math.floor(base / 2 ** (32 - bits)),
  );
}

export class TelegramBlockedError extends Error {
  readonly code = 'LULU_TELEGRAM_BLOCKED';
  constructor(host: string) {
    super(`connection to Telegram (${host}) is blocked in the panel's development mode`);
    this.name = 'TelegramBlockedError';
  }
}

export interface TelegramGuard {
  /** Hosts this process tried to reach, in order. */
  readonly blocked: string[];
  uninstall(): void;
}

/** Hosts named by any form of `socket.connect(...)`, including Node's normalized arrays. */
function hostsOf(args: unknown[]): string[] {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first !== null && typeof first === 'object') {
    const options = first as { host?: unknown; servername?: unknown; hostname?: unknown };
    return [options.host, options.servername, options.hostname].filter(
      (h): h is string => typeof h === 'string',
    );
  }
  return typeof args[1] === 'string' ? [args[1]] : [];
}

let installed: TelegramGuard | null = null;

export function blockTelegram(onBlocked?: (host: string) => void): TelegramGuard {
  if (installed) return installed;
  // Kept only to be called with an explicit `this` and to be restored as is.
  // eslint-disable-next-line @typescript-eslint/unbound-method
  const original = net.Socket.prototype.connect;
  const blocked: string[] = [];

  // `connect` has many overloads; this wrapper only inspects the arguments and forwards them.
  const guarded = function (this: net.Socket, ...args: unknown[]) {
    const host = hostsOf(args).find(isTelegramHost);
    if (host !== undefined) {
      blocked.push(host);
      onBlocked?.(host);
      const err = new TelegramBlockedError(host);
      process.nextTick(() => this.destroy(err));
      return this;
    }
    return (original as (...a: unknown[]) => net.Socket).apply(this, args);
  };
  net.Socket.prototype.connect = guarded;

  installed = {
    blocked,
    uninstall() {
      net.Socket.prototype.connect = original;
      installed = null;
    },
  };
  return installed;
}
