/**
 * Minimal structured logger: one JSON object per line on stdout/stderr.
 * Secrets never reach the output: bot tokens are masked anywhere in strings, and
 * fields whose names look sensitive are dropped entirely.
 */

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };

export interface Logger {
  trace(msg: string, fields?: Record<string, unknown>): void;
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

const SENSITIVE_KEY = /token|password|secret|cookie|authorization|session/i;
// Telegram bot tokens: "<digits>:<35+ url-safe chars>", also inside URLs.
const BOT_TOKEN = /\d{6,}:[A-Za-z0-9_-]{30,}/g;

export function redact(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return value.replace(BOT_TOKEN, '[redacted-token]');
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1) };
  }
  if (depth > 4 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => !SENSITIVE_KEY.test(k))
      .map(([k, v]) => [k, redact(v, depth + 1)]),
  );
}

export function createLogger(
  options: {
    level?: LogLevel;
    bindings?: Record<string, unknown>;
    /** `pretty` is a short human-readable line for development terminals. */
    format?: 'json' | 'pretty';
    write?: (line: string, level: LogLevel) => void;
  } = {},
): Logger {
  const min = ORDER[options.level ?? 'info'];
  const bindings = options.bindings ?? {};
  const write =
    options.write ??
    ((line: string, level: LogLevel) =>
      (ORDER[level] >= ORDER.warn ? process.stderr : process.stdout).write(`${line}\n`));

  const log =
    (level: LogLevel) =>
    (msg: string, fields: Record<string, unknown> = {}) => {
      if (ORDER[level] < min) return;
      const time = new Date().toISOString();
      if (options.format === 'pretty') {
        const extra = redact({ ...bindings, ...fields }) as Record<string, unknown>;
        const rest = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
        write(
          `${time.slice(11, 19)} ${level.toUpperCase().padEnd(5)} ${redact(msg) as string}${rest}`,
          level,
        );
        return;
      }
      const entry = redact({ time, level, msg, ...bindings, ...fields });
      write(JSON.stringify(entry), level);
    };

  return {
    trace: log('trace'),
    debug: log('debug'),
    info: log('info'),
    warn: log('warn'),
    error: log('error'),
    child: (more) => createLogger({ ...options, bindings: { ...bindings, ...more } }),
  };
}

/** Discards everything; for tests. */
export const silentLogger: Logger = createLogger({ write: () => {} });
