/**
 * Development only: explains, in the user's terms, why Node cannot reach api.telegram.org
 * while a browser on the same computer can. Used by `npm run dev` and `npm run dev:doctor`.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { platform } from 'node:os';

const TELEGRAM_HOST = 'api.telegram.org';

/** Addresses a public host never has: a filtering DNS answer or a local redirect. */
function isPrivateIPv4(address: string): boolean {
  const [a = 0, b = 0] = address.split('.').map(Number);
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  return Promise.race([
    promise.catch(() => undefined),
    new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), ms)),
  ]);
}

/** Windows "system proxy" (what VPN apps set in proxy mode); browsers use it, Node does not. */
async function windowsSystemProxy(): Promise<string | undefined> {
  if (platform() !== 'win32') return undefined;
  const result = await withTimeout(
    promisify(execFile)(
      'reg',
      ['query', String.raw`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`],
      { windowsHide: true },
    ),
    5_000,
  );
  const output = result?.stdout;
  if (!output || !/ProxyEnable\s+REG_DWORD\s+0x1\b/.test(output)) return undefined;
  return /ProxyServer\s+REG_SZ\s+(\S+)/.exec(output)?.[1] ?? 'on';
}

/**
 * The Windows ProxyServer value as a TELEGRAM_PROXY address. It is either `host:port`
 * (one proxy for everything, sometimes with a scheme) or `http=host:port;https=…`.
 */
export function proxyUrlFromSystemSetting(value: string): string | undefined {
  const perScheme = new Map(
    value
      .split(';')
      .map((part) => part.split('='))
      .filter((kv): kv is [string, string] => kv.length === 2)
      .map(([k, v]) => [k.trim().toLowerCase(), v.trim()]),
  );
  const address = perScheme.size ? (perScheme.get('https') ?? perScheme.get('http')) : value.trim();
  if (!address) return undefined;
  const url = /^[a-z]+:\/\//i.test(address) ? address : `http://${address}`;
  return /^https?:\/\/[^\s/]+\/?$/.test(url) ? url : undefined;
}

/** Hides a password in a proxy address before it is printed. */
export function redactProxy(proxy: string): string {
  return proxy.replace(/\/\/[^/@]*@/, '//***@');
}

/**
 * Persian lines (each starting with "•") describing what is wrong with the connection.
 * `proxy` is the TELEGRAM_PROXY the bot used, if any.
 */
export async function telegramNetworkHints(proxy?: string): Promise<string[]> {
  const hints: string[] = [];
  const system = await windowsSystemProxy();
  const suggested = system ? proxyUrlFromSystemSetting(system) : undefined;

  if (proxy) {
    hints.push(
      `• ربات از پراکسی TELEGRAM_PROXY=${redactProxy(proxy)} استفاده کرد و از آن جوابی نگرفت. ` +
        'مطمئن شوید فیلترشکن روشن است و این پورت HTTP (یا mixed) آن است، نه SOCKS.',
    );
    if (suggested && suggested !== proxy) {
      hints.push(
        `• پراکسی سیستمی ویندوز الان ${suggested} است؛ شاید TELEGRAM_PROXY باید همین باشد.`,
      );
    }
    hints.push('• یا TELEGRAM_PROXY را در .env خالی کنید و حالت TUN فیلترشکن را روشن کنید.');
    return hints;
  }

  const resolved = await withTimeout(lookup(TELEGRAM_HOST, { family: 4 }), 5_000);
  if (!resolved) {
    hints.push(
      `• نام ${TELEGRAM_HOST} پیدا نشد (DNS جواب نداد): اینترنت یا فیلترشکن را بررسی کنید.`,
    );
  } else if (isPrivateIPv4(resolved.address)) {
    hints.push(
      `• DNS برای ${TELEGRAM_HOST} آدرس ${resolved.address} را داد که آدرس فیلترینگ است، نه تلگرام. ` +
        'یعنی ترافیک Node از فیلترشکن رد نمی‌شود.',
    );
  }
  if (system) {
    hints.push(
      `• پراکسی سیستمی ویندوز روشن است (${system}). فیلترشکن در حالت «System Proxy» است: ` +
        'مرورگر از آن رد می‌شود ولی Node.js از پراکسی سیستمی استفاده نمی‌کند.',
    );
  }
  if (suggested) {
    hints.push(
      `• این خط را به .env اضافه کنید و دوباره اجرا کنید: TELEGRAM_PROXY=${suggested}`,
      '• یا در برنامهٔ فیلترشکن حالت TUN (یا «VPN mode» / «کل سیستم») را روشن کنید.',
    );
  } else {
    hints.push(
      '• در برنامهٔ فیلترشکن حالت TUN (یا «VPN mode» / «کل سیستم») را روشن کنید، ' +
        'یا آدرس پراکسی HTTP آن را در .env بگذارید: TELEGRAM_PROXY=http://127.0.0.1:<پورت>',
    );
  }
  return hints;
}
