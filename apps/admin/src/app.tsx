import type { SessionView } from '@lulu/api/contract';
import { useMemo } from 'react';
import type { RouteObject } from 'react-router';
import { createBrowserRouter, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { Layout } from './components/layout.tsx';
import { ErrorState, Loading } from './components/states.tsx';
import { loggedOutReason, useSession } from './lib/session.ts';
import { navFor } from './nav.ts';
import { LoginPage } from './pages/login.tsx';
import { ComingSoon, NotFound } from './pages/placeholder.tsx';

export function routesFor(session: SessionView): RouteObject[] {
  return [
    {
      path: '/',
      element: <Layout session={session} />,
      children: [
        ...navFor(session.user.role).map((item) => ({
          ...(item.path === '/' ? { index: true } : { path: item.path.slice(1) }),
          element: <ComingSoon item={item} />,
        })),
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
