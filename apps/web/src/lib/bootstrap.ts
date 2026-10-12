import type { AppBootstrap } from "@rakazo/contracts";
import { authClient } from "./auth";
import { fetchAuthCapabilities } from "./auth-capabilities";
import { initialBootstrapTarget } from "./bootstrap-target";
import { markOnce } from "./performance";
import { rpc } from "./rpc";

let ticketBoardEnabled = false;
const capabilityListeners = new Set<() => void>();
export function getTicketBoardEnabled() {
  return ticketBoardEnabled;
}
export function subscribeTicketBoardEnabled(listener: () => void) {
  capabilityListeners.add(listener);
  return () => {
    capabilityListeners.delete(listener);
  };
}

let primedBootstrap: { botId?: string; promise: Promise<AppBootstrap> } | null = null;

const initialTarget = initialBootstrapTarget(
  window.location.pathname,
  Boolean(window.rakazoDesktop),
);
if (initialTarget) {
  const { botId } = initialTarget;
  const promise = requestBootstrap(botId);
  // Authentication can redirect before Shell consumes this speculative request.
  // Register a rejection handler immediately while preserving rejection for a consumer.
  void promise.catch(() => undefined);
  primedBootstrap = { botId, promise };
  // The session and subscription gates sit in front of the shell; start their lookups now
  // instead of after the first render. The session store dedupes its own mount fetch.
  authClient.$store.atoms.session?.listen(() => undefined);
  void fetchAuthCapabilities().catch(() => undefined);
}

/** The speculative first-load bootstrap, left in place for the shell to take. */
export function peekInitialBootstrap(): Promise<AppBootstrap> | undefined {
  return primedBootstrap?.promise;
}

export function takeInitialBootstrap(botId?: string) {
  const primed = primedBootstrap;
  primedBootstrap = null;
  if (primed && primed.botId === botId) return primed.promise;
  return requestBootstrap(botId);
}

function requestBootstrap(botId?: string) {
  markOnce("rk:renderer:bootstrap-request-start");
  return rpc.bootstrap(botId ? { botId } : {}).then((bootstrap) => {
    markOnce("rk:renderer:bootstrap-response");
    ticketBoardEnabled = bootstrap.me.ticketBoardEnabled;
    for (const listener of capabilityListeners) listener();
    return bootstrap;
  });
}
