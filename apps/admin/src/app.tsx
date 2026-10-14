import type { SessionView } from '@lulu/api/contract';
import { useMemo } from 'react';
import type { RouteObject } from 'react-router';
import { createBrowserRouter, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/layout.tsx';
import { ErrorState, Loading } from './components/states.tsx';
import { loggedOutReason, useSession } from './lib/session.ts';
import type { NavItem } from './nav.ts';
import { navFor } from './nav.ts';
import { AccountPage } from './pages/account.tsx';
import { AdminsPage } from './pages/admins.tsx';
import { AnnouncementsPage } from './pages/announcements.tsx';
import { AuditPage } from './pages/audit.tsx';
import { DashboardPage } from './pages/dashboard.tsx';
import { EconomyPage } from './pages/economy.tsx';
import { GhostsPage } from './pages/ghosts.tsx';
import { GroupMigrationsPage } from './pages/group-migrations.tsx';
import { GroupPage } from './pages/group.tsx';
import { GroupsPage } from './pages/groups.tsx';
import { PlayerPage } from './pages/player.tsx';
import { PlayersPage } from './pages/players.tsx';
import { LoginPage } from './pages/login.tsx';
import { NotFound } from './pages/placeholder.tsx';
import { SystemPage } from './pages/system.tsx';
import { TransactionsPage } from './pages/transactions.tsx';

/** The page for each navigation entry. */
function pageFor(item: NavItem, session: SessionView) {
  if (item.path === '/') return <DashboardPage />;
  if (item.path === '/system') return <SystemPage session={session} />;
  if (item.path === '/players') return <PlayersPage />;
  if (item.path === '/transactions') return <TransactionsPage />;
  if (item.path === '/groups') return <GroupsPage />;
  if (item.path === '/economy') return <EconomyPage session={session} />;
  if (item.path === '/ghosts') return <GhostsPage />;
  if (item.path === '/announcements') return <AnnouncementsPage />;
  if (item.path === '/admins') return <AdminsPage />;
  if (item.path === '/audit') return <AuditPage session={session} />;
  if (item.path === '/account') return <AccountPage session={session} />;
  return <NotFound />;
}

export function routesFor(session: SessionView): RouteObject[] {
  return [
    {
      path: '/',
      element: <Layout session={session} />,
      children: [
        ...navFor(session.user.role).map((item) => ({
          ...(item.path === '/' ? { index: true } : { path: item.path.slice(1) }),
          element: pageFor(item, session),
        })),
        { path: 'players/:id', element: <PlayerPage /> },
        { path: 'groups/migrations', element: <GroupMigrationsPage /> },
        { path: 'groups/:id', element: <GroupPage /> },
        { path: '*', element: <NotFound /> },
      ],
    },
  ];
}

function Panel({ session, memory }: { session: SessionView; memory?: string }) {
  // One router per signed-in user and role, so owner-only pages never exist for admins.
  const router = useMemo(
    () =>
      memory !== undefined
        ? createMemoryRouter(routesFor(session), { initialEntries: [memory] })
        : createBrowserRouter(routesFor(session)),
    // Deliberately keyed on user and role only: a refreshed session keeps the same router.
    [session.user.id, session.user.role],
  );
  return <RouterProvider router={router} />;
}

/** Login page until there is a session, then the panel at the current URL. */
export function App({ memoryPath }: { memoryPath?: string }) {
  const session = useSession();
  if (session.isPending) return <Loading />;
  if (session.isError) {
    return <ErrorState error={session.error} onRetry={() => void session.refetch()} />;
  }
  if (!session.data) return <LoginPage reason={loggedOutReason()} />;
  return (
    <Panel session={session.data} {...(memoryPath !== undefined ? { memory: memoryPath } : {})} />
  );
}
