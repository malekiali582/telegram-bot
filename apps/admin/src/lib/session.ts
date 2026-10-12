import type { LoginRequest, SessionView } from '@lulu/api/contract';
import type { QueryClient } from '@tanstack/react-query';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api, setCsrfToken, setUnauthenticatedHandler } from './api.ts';

export const SESSION_KEY = ['session'] as const;

/** Why the login page is showing, when it is not the first visit. Cleared by a login. */
export type LoggedOutReason = 'expired' | 'logged_out' | null;
let reason: LoggedOutReason = null;
export const loggedOutReason = (): LoggedOutReason => reason;

function forget(client: QueryClient, why: LoggedOutReason) {
  reason = why;
  setCsrfToken(null);
  // Nothing from the old session stays in memory.
  client.removeQueries({ predicate: (q) => q.queryKey[0] !== SESSION_KEY[0] });
  client.setQueryData(SESSION_KEY, null);
}

export function installSessionHandling(client: QueryClient): void {
  setUnauthenticatedHandler(() => forget(client, 'expired'));
}

/** The current session, or null when logged out. */
export function useSession() {
  return useQuery({
    queryKey: SESSION_KEY,
    queryFn: async (): Promise<SessionView | null> => {
      try {
        const session = await api.get<SessionView>('/api/auth/session');
        setCsrfToken(session.csrfToken);
        return session;
      } catch (err) {
        if (err instanceof ApiError && err.code === 'unauthenticated') {
          setCsrfToken(null);
          return null;
        }
        throw err;
      }
    },
    staleTime: 5 * 60_000,
    retry: (count, err) => !(err instanceof ApiError && err.status > 0) && count < 2,
  });
}

export function useLogin() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: LoginRequest) => api.post<SessionView>('/api/auth/login', input),
    onSuccess: (session) => {
      reason = null;
      setCsrfToken(session.csrfToken);
      client.setQueryData(SESSION_KEY, session);
    },
  });
}

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/api/auth/logout'),
    onSettled: () => forget(client, 'logged_out'),
  });
}
