/**
 * `npm run check:panel-browser`: the admin panel's full scenario in a real headless
 * browser (Edge or Chrome, via the DevTools protocol), at phone (390 px) and desktop
 * (1440 px) widths.
 *
 * It starts its own `dev:panel` in a fresh temporary folder on free ports (it never
 * touches .lulu-dev, .lulu-panel-dev or a running panel), signs in with the password that
 * run prints, walks every page and the main actions, and fails on:
 *   - a page that scrolls sideways, shows an error state, or throws in the browser;
 *   - any attempt to reach Telegram (dev:panel blocks and reports it).
 * Screenshots go to the folder printed at the end. Browser: BROWSER_PATH, or Edge/Chrome
 * in their usual places.
 */
import type { ChildProcess } from 'node:child_process';
import { fork, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BROWSERS = [
  process.env.BROWSER_PATH,
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/microsoft-edge',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const failures: string[] = [];
const fail = (what: string) => {
  failures.push(what);
  process.stdout.write(`  ✗ ${what}\n`);
};
const ok = (what: string) => process.stdout.write(`  ✓ ${what}\n`);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// ── 1. an isolated dev:panel ──

async function startPanel(dir: string) {
  const ports = { db: await freePort(), api: await freePort(), panel: await freePort() };
  const child = fork('scripts/dev-panel.ts', ['--new-password'], {
    execArgv: ['--conditions=@lulu/source', '--import', 'tsx'],
    env: {
      ...process.env,
      PANEL_DEV_DIR: dir,
      PANEL_DEV_DB_PORT: String(ports.db),
      PANEL_DEV_API_PORT: String(ports.api),
      PANEL_DEV_PORT: String(ports.panel),
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  child.stdout!.on('data', (d: Buffer) => (output += d.toString()));
  child.stderr!.on('data', (d: Buffer) => (output += d.toString()));
  const deadline = Date.now() + 10 * 60_000; // the first run seeds sample data
  while (!output.includes('روشن است') && Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`dev:panel stopped:\n${output}`);
    await sleep(500);
  }
  const password = /رمز:\s+(\S+)/.exec(output)?.[1];
  if (!password) throw new Error(`dev:panel did not start or print a password:\n${output}`);
  return { child, password, url: `http://127.0.0.1:${ports.panel}`, output: () => output };
}

async function stopPanel(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.send('shutdown');
  for (let i = 0; i < 60 && child.exitCode === null; i++) await sleep(500);
  if (child.exitCode === null) child.kill();
}

// ── 2. a small DevTools-protocol client ──

class Browser {
  private ws!: WebSocket;
  private id = 0;
  private pending = new Map<number, (m: { result?: unknown; error?: unknown }) => void>();
  readonly problems: string[] = [];
  private proc!: ChildProcess;

  async open(executable: string, profile: string): Promise<void> {
    const port = await freePort();
    this.proc = spawn(
      executable,
      [
        '--headless=new',
        '--disable-gpu',
        '--no-first-run',
        '--no-default-browser-check',
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profile}`,
        'about:blank',
      ],
      { stdio: 'ignore' },
    );
    let targets: { type: string; webSocketDebuggerUrl: string }[] = [];
    for (let i = 0; i < 100 && targets.length === 0; i++) {
      try {
        const list = (await (
          await fetch(`http://127.0.0.1:${port}/json`)
        ).json()) as typeof targets;
        targets = list.filter((t) => t.type === 'page');
      } catch {
        await sleep(200);
      }
    }
    if (!targets[0]) throw new Error('the browser did not open a debugging port');
    this.ws = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve) => this.ws.addEventListener('open', resolve));
    this.ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data)) as {
        id?: number;
        method?: string;
        params?: Record<string, unknown>;
        result?: unknown;
        error?: unknown;
      };
      if (m.id !== undefined) {
        this.pending.get(m.id)?.(m);
        this.pending.delete(m.id);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const details = m.params?.exceptionDetails as { exception?: { description?: string } };
        this.problems.push(`browser exception: ${details.exception?.description ?? 'unknown'}`);
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        const args = (m.params.args as { value?: unknown; description?: string }[]) ?? [];
        const text = args.map((a) =>
          typeof a.value === 'string' ? a.value : (a.description ?? JSON.stringify(a.value)),
        );
        this.problems.push(`console error: ${text.join(' ')}`);
      }
    });
    await this.send('Page.enable');
    await this.send('Runtime.enable');
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (m) =>
        m.error ? reject(new Error(`${method}: ${JSON.stringify(m.error)}`)) : resolve(m.result),
      );
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval<T>(expression: string): Promise<T> {
    const r = (await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text: string } };
    if (r.exceptionDetails) throw new Error(`evaluate: ${r.exceptionDetails.text}`);
    return r.result?.value as T;
  }

  private viewport = { width: 1440, height: 900 };

  async size(width: number, height: number, remember = false): Promise<void> {
    if (remember) this.viewport = { width, height };
    await this.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 600,
    });
  }

  async goto(url: string): Promise<void> {
    await this.send('Page.navigate', { url });
    await sleep(300);
    await this.settle();
  }

  /** Waits until no spinner is left (data loaded or failed). */
  async settle(timeoutMs = 20_000): Promise<void> {
    const end = Date.now() + timeoutMs;
    await sleep(200);
    while (Date.now() < end) {
      const busy = await this.eval<boolean>(
        `document.readyState !== 'complete' || [...document.querySelectorAll('[role=status]')].some(e => e.textContent.includes('در حال بارگذاری'))`,
      ).catch(() => true);
      if (!busy) return;
      await sleep(200);
    }
  }

  async waitFor(text: string, timeoutMs = 20_000): Promise<boolean> {
    const end = Date.now() + timeoutMs;
    while (Date.now() < end) {
      if (await this.eval<boolean>(`document.body.innerText.includes(${JSON.stringify(text)})`)) {
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  /** Clicks the first enabled button or link whose text starts with `text`. */
  click(text: string, scope = 'document'): Promise<boolean> {
    return this.eval<boolean>(`(() => {
      const el = [...${scope}.querySelectorAll('button, a, label')].find(
        (b) => b.textContent.trim().startsWith(${JSON.stringify(text)}) && !b.disabled);
      if (!el) return false;
      el.click();
      return true;
    })()`);
  }

  /** Types into the field whose label starts with `label` (React-controlled inputs). */
  fill(label: string, value: string): Promise<boolean> {
    return this.eval<boolean>(`(() => {
      const l = [...document.querySelectorAll('label')].find(
        (x) => x.textContent.trim().startsWith(${JSON.stringify(label)}));
      const el = l && (l.control ?? l.querySelector('input, textarea'));
      if (!el) return false;
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  /** The whole page: the viewport grows to the page height for the shot, then returns. */
  async screenshot(file: string): Promise<void> {
    const { width, height } = this.viewport;
    // The panel scrolls inside its frame, not the document: take the tallest scroller.
    const full = await this.eval<number>(
      `Math.max(...[...document.querySelectorAll('*')].map((e) => e.scrollHeight))`,
    );
    await this.size(width, Math.min(Math.max(full, height), 8000));
    await sleep(300);
    const { data } = (await this.send('Page.captureScreenshot', { format: 'png' })) as {
      data: string;
    };
    writeFileSync(file, Buffer.from(data, 'base64'));
    await this.size(width, height);
  }

  close(): void {
    this.ws.close();
    this.proc.kill();
  }
}

// ── 3. the scenario ──

async function checkPage(b: Browser, out: string, name: string, expect: string) {
  if (!(await b.waitFor(expect))) fail(`${name}: «${expect}» did not appear`);
  await b.settle();
  const state = await b.eval<{ overflow: number; error: string | null }>(`({
    overflow: document.documentElement.scrollWidth - innerWidth,
    error: [...document.querySelectorAll('main [role=alert]')]
      .find((e) => e.querySelector('button')?.textContent.includes('دوباره'))?.innerText ?? null,
  })`);
  if (state.overflow > 0) fail(`${name}: scrolls sideways by ${state.overflow}px`);
  if (state.error) fail(`${name}: error state «${state.error.split('\n')[0]}»`);
  await b.screenshot(join(out, `${name}.png`));
  if (state.overflow <= 0 && !state.error) ok(name);
}

const PAGES: [path: string, name: string, expect: string][] = [
  ['/', 'dashboard', 'بازیکن فعال امروز'],
  ['/players', 'players', 'بازیکن‌ها'],
  ['/transactions', 'transactions', 'تراکنش‌ها'],
  ['/groups', 'groups', 'گروه‌ها'],
  ['/groups/migrations', 'group-migrations', 'مهاجرت'],
  ['/economy', 'economy', 'سطح‌های بازیکن'],
  ['/economy?tab=history', 'economy-history', 'نسخهٔ'],
  ['/ghosts', 'ghosts', 'بستهٔ تازه'],
  ['/announcements', 'announcements', 'اطلاعیهٔ تازه'],
  ['/admins', 'admins', 'مدیر تازه'],
  ['/audit', 'audit', 'سابقهٔ کارها'],
  ['/account', 'account', 'نشست‌های باز'],
  ['/system', 'system', 'صف ارسال'],
];

async function login(b: Browser, url: string, password: string) {
  await b.goto(`${url}/`);
  if (!(await b.waitFor('ورود'))) fail('login page did not appear');
  await b.fill('نام کاربری', 'owner');
  await b.fill('رمز', password);
  await b.click('ورود');
  if (!(await b.waitFor('بازیکن فعال امروز'))) fail('login did not reach the dashboard');
}

async function desktopActions(b: Browser, url: string, out: string, password: string) {
  // A player profile and a group, opened from their lists.
  await b.goto(`${url}/players`);
  await b.eval(`document.querySelector('main a[href^="/players/"]')?.click()`);
  await checkPage(b, out, 'desktop-player', 'تاریخچهٔ تراکنش');
  await b.goto(`${url}/groups`);
  await b.eval(
    `document.querySelector('main a[href^="/groups/"]:not([href="/groups/migrations"])')?.click()`,
  );
  await checkPage(b, out, 'desktop-group', 'کارهای مدیر');

  // A ghost batch for the first night without one.
  await b.goto(`${url}/ghosts`);
  await b.eval(`(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    [...document.querySelectorAll('form textarea')].forEach((t, i) => {
      setter.call(t, '[نمونه] متن آزمایشی شمارهٔ ' + (i + 1) + ' از بررسی مرورگر');
      t.dispatchEvent(new Event('input', { bubbles: true }));
    });
  })()`);
  await b.click('ثبت بسته');
  if (await b.waitFor('ثبت شد')) ok('ghost batch added');
  else fail('ghost batch was not added');

  // An announcement to every group (the sender is simulated in dev:panel).
  await b.goto(`${url}/announcements`);
  await b.fill('متن اطلاعیه', '[نمونه] اطلاعیهٔ آزمایشی بررسی مرورگر');
  await sleep(300);
  await b.click('ارسال به');
  await b.click('بله، بفرست');
  if (await b.waitFor('در صف ارسال')) ok('announcement queued');
  else fail('announcement was not queued');

  // A new admin, then the audit log shows it.
  await b.goto(`${url}/admins`);
  await b.click('مدیر تازه');
  await b.fill('نام کاربری', 'browser_check');
  await b.click('رمز تصادفی');
  await b.fill('رمز خودتان', password);
  await b.click('ساختن حساب');
  if (await b.waitFor('ساخته شد')) ok('admin created');
  else fail('admin was not created');
  await b.goto(`${url}/audit?action=admin.create`);
  if (await b.waitFor('افزودن مدیر')) ok('audit log shows the new admin');
  else fail('audit log does not show the new admin');
}

async function main() {
  const executable = BROWSERS.find((p) => p && existsSync(p));
  if (!executable) {
    process.stderr.write('No Edge or Chrome found; set BROWSER_PATH to the browser executable.\n');
    process.exit(2);
  }
  const work = mkdtempSync(join(tmpdir(), 'lulu-panel-check-'));
  const out = join(work, 'screenshots');
  mkdirSync(out);
  process.stdout.write(
    `Starting an isolated dev:panel in ${work} (first run seeds sample data)…\n`,
  );
  const panel = await startPanel(join(work, 'panel'));
  const browser = new Browser();
  try {
    await browser.open(executable, join(work, 'profile'));
    for (const [width, height, label] of [
      [1440, 900, 'desktop'],
      [390, 844, 'phone'],
    ] as const) {
      process.stdout.write(`\n${label} (${width} px)\n`);
      await browser.size(width, height, true);
      await login(browser, panel.url, panel.password);
      for (const [path, name, expect] of PAGES) {
        await browser.goto(`${panel.url}${path}`);
        await checkPage(browser, out, `${label}-${name}`, expect);
      }
      if (label === 'desktop') {
        await desktopActions(browser, panel.url, out, panel.password);
      } else {
        await browser.goto(`${panel.url}/`);
        await browser.eval(`document.querySelector('[aria-label="باز کردن منو"]')?.click()`);
        await sleep(400);
        if (await browser.eval<boolean>(`!!document.querySelector('[aria-label="منو"]')`)) {
          ok('phone menu opens');
        } else {
          fail('phone menu does not open');
        }
        await browser.screenshot(join(out, 'phone-menu.png'));
      }
      await browser.goto(`${panel.url}/`);
      await browser.click('خروج');
      if (await browser.waitFor('نام کاربری')) ok('logout returns to the login page');
      else fail('logout did not return to the login page');
    }
    for (const problem of browser.problems) fail(problem);
    if (/اتصال به تلگرام .* مسدود شد/.test(panel.output())) {
      fail('something tried to reach Telegram');
    } else {
      ok('no connection to Telegram was attempted');
    }
  } finally {
    browser.close();
    await stopPanel(panel.child);
  }
  process.stdout.write(`\nScreenshots: ${out}\n`);
  if (failures.length > 0) {
    process.stdout.write(
      `\n${failures.length} problem(s):\n${failures.map((f) => `  - ${f}`).join('\n')}\n`,
    );
    process.exit(1);
  }
  // The sample database is not needed any more; the screenshots stay.
  rmSync(join(work, 'panel'), { recursive: true, force: true });
  process.stdout.write('\nAll checks passed.\n');
}

await main();
