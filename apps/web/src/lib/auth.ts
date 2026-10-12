import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient, type ReactAuthClient } from "better-auth/react";

declare global {
  interface Window {
    __rakazoEarlySession?: Promise<Response>;
  }
}

/** index.html starts the first session lookup early; only the client's first request may use it. */
async function authFetch(input: RequestInfo | URL, init?: RequestInit) {
  const early = typeof window === "undefined" ? undefined : window.__rakazoEarlySession;
  if (early) {
    window.__rakazoEarlySession = undefined;
    const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
    const method = (
      init?.method ?? (input instanceof Request ? input.method : "GET")
    ).toUpperCase();
    if (url.pathname === "/api/auth/get-session" && url.search === "" && method === "GET") {
      const response = await early.catch(() => null);
      if (response) return response;
    }
  }
  return fetch(input, init);
}

export const authClient: ReactAuthClient<{
  plugins: [ReturnType<typeof organizationClient>];
}> = createAuthClient({
  plugins: [organizationClient()],
  fetchOptions: { customFetchImpl: authFetch },
});
