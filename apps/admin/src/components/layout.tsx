import type { SessionView } from '@lulu/api/contract';
import { FlaskConical, LogOut, Menu, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router';
import { useLogout } from '../lib/session.ts';
import { ROLE_LABEL, navFor } from '../nav.ts';

function NavLinks({ session, onNavigate }: { session: SessionView; onNavigate?: () => void }) {
  const items = navFor(session.user.role);
  const link = (accountMenu: boolean) =>
    items
      .filter((item) => Boolean(item.accountMenu) === accountMenu)
      .map(({ path, label, icon: Icon }) => (
        <NavLink
          key={path}
          to={path}
          end={path === '/'}
          {...(onNavigate ? { onClick: onNavigate } : {})}
          className={({ isActive }) =>
            `flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors ${
              isActive ? 'bg-accent-soft text-accent' : 'text-muted hover:bg-raised hover:text-ink'
            }`
          }
        >
          <Icon aria-hidden className="size-4.5 shrink-0" />
          {label}
        </NavLink>
      ));
  return (
    <nav aria-label="بخش‌های پنل" className="flex flex-1 flex-col gap-1 p-3">
      {link(false)}
      <div className="mt-auto border-t border-line pt-3">{link(true)}</div>
    </nav>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2 px-5 py-4">
      <img src="/favicon.svg" alt="" className="size-7" />
      <span className="font-bold">پنل لولو</span>
    </div>
  );
}

export function Layout({ session }: { session: SessionView }) {
  const [drawerOpen, setDrawerOpen] = useState(false);
  const logout = useLogout();
  const location = useLocation();

  // The drawer closes on navigation and on Escape.
  useEffect(() => setDrawerOpen(false), [location.pathname]);
  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setDrawerOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [drawerOpen]);

  return (
    // A fixed-height frame: the sidebar and banner stay put, only the page content scrolls.
    <div className="flex h-dvh flex-col">
      {session.app.mode === 'dev-panel' ? (
        <div className="flex items-center justify-center gap-2 bg-warn-soft px-4 py-1.5 text-center text-xs text-warn">
          <FlaskConical aria-hidden className="size-3.5 shrink-0" />
          حالت توسعه: دادهٔ نمونه با برچسب «[نمونه]»، بدون اتصال به تلگرام و بدون ارسال پیام
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {/* Sidebar on wide screens (at the start side: right, in RTL). */}
        <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-e border-line bg-surface lg:flex">
          <Brand />
          <NavLinks session={session} />
        </aside>

        {/* Drawer on phones. */}
        {drawerOpen ? (
          <div className="fixed inset-0 z-40 lg:hidden">
            <button
              type="button"
              aria-label="بستن منو"
              className="absolute inset-0 bg-black/60"
              onClick={() => setDrawerOpen(false)}
            />
            <aside
              id="nav-drawer"
              aria-label="منو"
              className="absolute inset-y-0 start-0 flex w-72 max-w-[85vw] flex-col bg-surface shadow-2xl"
            >
              <div className="flex items-center justify-between pe-2">
                <Brand />
                <button
                  type="button"
                  aria-label="بستن منو"
                  onClick={() => setDrawerOpen(false)}
                  className="rounded-lg p-2 text-muted hover:bg-raised"
                >
                  <X aria-hidden className="size-5" />
                </button>
              </div>
              <NavLinks session={session} onNavigate={() => setDrawerOpen(false)} />
            </aside>
          </div>
        ) : null}

        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
          <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-line bg-bg/90 px-4 py-3 backdrop-blur">
            <button
              type="button"
              aria-label="باز کردن منو"
              aria-expanded={drawerOpen}
              aria-controls="nav-drawer"
              onClick={() => setDrawerOpen(true)}
              className="-ms-1 rounded-lg p-2 text-muted hover:bg-raised lg:hidden"
            >
              <Menu aria-hidden className="size-5" />
            </button>
            <div className="ms-auto flex items-center gap-3 text-sm">
              <span className="hidden text-muted sm:inline">
                <span className="ltr-nums text-ink">{session.user.username}</span>
                {' · '}
                {ROLE_LABEL[session.user.role]}
              </span>
              <button
                type="button"
                onClick={() => logout.mutate()}
                disabled={logout.isPending}
                className="inline-flex items-center gap-2 rounded-lg border border-line px-3 py-1.5 text-muted hover:bg-raised hover:text-ink disabled:opacity-50"
              >
                <LogOut aria-hidden className="size-4" />
                خروج
              </button>
            </div>
          </header>
          <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 sm:px-6">
            <Outlet />
          </main>
        </div>
      </div>
    </div>
  );
}
