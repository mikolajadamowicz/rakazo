# Web latency and request-flood plan

Goal: make the web app (and the Electron shell that hosts it) at least twice as fast and responsive,
and stop it flooding the API with requests. Mobile shares the backend and most of the same patterns,
so each step names the mobile counterpart where one exists.

## Where the time goes today

Findings come from reading the code. Phase 0 turns them into measured numbers before anything ships.

### Client (apps/web, packages/core, packages/chat-ui)

1. **A 3 s `spaces.list` poll runs the whole time the shell is visible** (`apps/web/src/pages/Shell.tsx`,
   the `setInterval(..., 3_000)` next to `refreshVisibleBots`). That is about 20 requests per minute per tab even
   when nothing changes and the realtime stream is up. Focus and visibility changes add more. Every
   response calls `setBots(list)` with a new array and no equality check, so `ShellPage` (about 7k lines),
   the transcript and every `MessageView` re-render every 3 s. Mobile does the same every 5 s
   (`apps/mobile/app/index.tsx`, `spaces/list` + `me`).
2. **Realtime events trigger full refetches.** In the `threads.subscribe` handler in `Shell.tsx`:
   - `run.started`, terminal and bot events each refetch `spaces.list`.
   - Terminal and `waiting_input` events refetch `threads.get` plus `routines.list`, `skills.list` and
     `computer.screenUrl`.
   - Every bot message sends `threads.markRead`.

   One finished run costs about 6–7 requests on top of an event that already carried the data, and
   groups multiply that by member count.
3. **Reconnect storm.** `packages/core/src/thread-subscription.ts` resets `retryMs` to 250 ms on every
   frame, heartbeats included, and runs a full `refresh()` (4 requests) on every reconnect. A
   connection that a proxy keeps idling out loops at 250 ms–5 s, refetching each time.
4. **N+1 for @-mentions.** `rpc.routines.list({ botId })` runs once per bot, plus `connections.list` and
   `connections.catalog`, after boot and again whenever a bot is added, removed or renamed.
5. **Boot waterfall.** `get-session` → `SubscriptionGate` (capabilities → `loadMe` → `billing.status`)
   → about 7 shell-mount requests → N+2 mention requests. That is about 13 + N requests at least
   four round-trips deep before the shell settles.
6. **Pollers that ignore hidden tabs.**
   - `computer.updates`: every 15 s, but stuck at 1.5 s while any update is listed.
   - `ActivityList`: 2 × `runs.list` every 15 s.
   - `RoutineRunHistory`: every 15 s.
   - Files and Terminal: 3 s each while the computer panel is open.
7. **Rendering.**
   - The transcript has no virtualization.
   - `memo` on `Transcript` and `MessageView` is defeated by inline arrows (`onReply`, `onQuote`,
     `onSpeak={() => onSpeak(message)}`) and by `workingBots`/`peerBot` changing identity each render.
   - The streaming message re-parses all of its markdown on every progress event.
   - With streaming off, `stripLiveStreamingProgress` still creates a new `messages` array per event.
8. **Bundle.**
   - `ShellPage` statically imports `RoutineEditor`, `GroupPanel`, `ActivityList`, `bot-panel`, the
     computer and teach UI, and the markdown stack.
   - `vite.config.ts` has no chunking configuration.
   - The `@rakazo/contracts` and `@rakazo/core` barrels pull zod schemas and `croner` into the main chunk.

### Server (apps/api, packages/db, packages/auth)

1. **`spaces.list` is the most expensive endpoint, and it is the one being polled.** `spaceNavigationDto`
   runs 2 sequential queries, then 8 query groups. `repos.listBots` includes, per bot:
   - the thread
   - 16 messages with full `blocks` JSON
   - the latest run and the active run
   - the computer
   - a per-bot fallback of up to 4 more `message.findMany` calls

   Prisma uses the default `query` relation strategy here, so a nested `take` across many parents
   may be applied in memory after loading every row (verify in Phase 0).
2. **The DB pool is 4 connections** (`DEFAULT_POOL_MAX` in `packages/db/src/client.ts`, no `DB_POOL_MAX`
   in compose). All RPC traffic, the job publisher, the bridge reconciler and transactions share it.
   `threads.get` holds two connections at once. Queued checkouts wait up to 10 s.
3. **About 6 sequential queries of auth per request.**
   - better-auth session + user, with no `cookieCache` or `secondaryStorage`.
   - `requireMembership`: a join, then a re-fetch of the user, then `deploymentSettings`.
   - Long-lived streams repeat the whole lookup every 10 s (`SESSION_RECHECK_MS`).
4. **Unbounded work in hot reads.**
   - `threads.get` loads every live event of the active run inside a `FOR SHARE` transaction.
   - `loadMessagePage` loops `while (true)` over peer-only pages.
   - The "active" `runs.list` has no `take`.
5. **Indexes.**
   - No index leads with `runs.botId`; only `(spaceId, botId)` exists, and Postgres 16 has no skip scan.
   - No index matches `runs.list` "recent", which filters on `spaceId, userId, status` and orders by
     `completedAt`.
   - `messages.runId` is not indexed.
   - `(threadId, seq)` is indexed twice on both `Message` and `Event`, which taxes every streaming insert.
6. **No conditional responses.** `/rpc/*` is `no-store` with no ETag, so every poll re-sends the full
   payload. CORS sends no `maxAge`. Compression exists only behind Caddy.
7. **No rate limit on `/rpc/*`.**
8. **`computer.heartbeat` awaits the sandbox provider's `keepAlive`** before responding.

## Targets ("twice as fast")

Record each metric before and after with the existing harness (`pnpm perf:desktop`,
`pnpm perf:compare`) plus the additions in Phase 0. A phase is done when its rows move.

| Metric | Target |
| --- | --- |
| Cache-cold shell usable, median | ≤ 50% of baseline |
| Warm shell usable, median | ≤ 50% of baseline |
| Requests from navigation to shell settled (20 bots) | ≤ 8, no more than 2 round-trips deep (from ~33, 4+ deep) |
| Requests per minute, idle visible tab, stream healthy | ≤ 1, heartbeats excluded (from ~20+) |
| Requests per minute, hidden tab | 0 |
| Requests per finished run | ≤ 1 (from ~6–7) |
| `spaces.list` server p95 | ≤ 50% of baseline |
| Auth overhead per RPC | ≤ 1 query on a warm cache (from ~6) |
| Typing key-to-frame p95 with 100 messages | ≤ 50% of baseline |
| Streaming total CPU, median | ≤ 50% of baseline |
| Event-to-paint (server emit → message painted) | ≤ 50% of baseline |

## Phase 0: measure first (1–2 days)

- Extend `packages/testkit` performance reports with a request ledger. Count `/rpc/*` and `/api/auth/*`
  requests per procedure:
  - during boot
  - over a 60 s idle window, visible and hidden
  - during one scripted run

  Add the counts to `pnpm perf:compare` rows, so the request-flood fix shows up as a number in the PR.
- Add a `Server-Timing` header (total, db, auth) to `/rpc/*` responses behind an existing logging or
  debug setting, and log the per-procedure query count from Prisma's query event.
- Turn on Prisma query logging for one `spaces.list` against a seeded space with 20 bots and long
  threads. Confirm or rule out the in-memory nested `take`. That result decides how big Phase 3 is.
- Add an event-to-paint mark to the streaming benchmark.
- Record a `before` report on fixed hardware.

## Phase 1: stop the flood (quick wins, each a small PR)

1. **Remove the 3 s `spaces.list` poll while the thread stream is healthy.** Refresh only on focus or
   visibility (debounced, at most once every 30 s), on reconnect, and as a slow 60 s safety net while
   visible. Do the same for mobile's 5 s loop.
2. **Skip no-op state updates.** Compare the `spaces.list` result (a cheap stable hash or a field-wise
   equality check) before calling `setBots`, `setGroups`, `setBotSections` or `setSpaces`. This alone
   removes the full-shell re-render every 3 s.
3. **Coalesce event-driven refetches.** Funnel `refreshBots` and `refreshThread` calls from events through
   a trailing debounce (about 250 ms) with in-flight dedup, so a burst of run events costs one request.
   Drop `refreshThread` on terminal events wherever the event stream has already delivered the final
   message and run state. Batch `markRead` to one call per thread per visible burst, sending the
   highest seq.
4. **Fix the reconnect backoff.** Reset `retryMs` only after a real event or a stream that stayed up
   at least 30 s, not on heartbeats. Replace the full `refresh()` on reconnect with `threads.head`. Fetch
   the snapshot only when the cursor gap is larger than the event backlog the server will replay.
5. **Pause every poller when the tab is hidden.** Covers `computer.updates` (and drop the 1.5 s rate
   once updates are only failed or finished), `ActivityList`, `RoutineRunHistory`, Files and Terminal.
   Move them onto one shared `useVisiblePoll(interval, fn)` helper in `packages/core` so the rule
   lives in one place.
6. **Remove the N+1 mention fetch.** Either add a `routines.listForSpace` procedure, or load routine
   mentions lazily when the composer opens the mention menu. Reuse the `routines.list` already
   fetched in `refreshThread` for the active bot.
7. **Server quick wins:**
   - Set the API pool to about 15–20 via the existing `poolMax` option and compose `DB_POOL_MAX`.
     Document the Postgres `max_connections` budget alongside the worker's 8.
   - Turn on better-auth `session.cookieCache` with a short `maxAge` (about 60 s). Revocation still
     takes effect within that window, and the 10 s stream re-check keeps its meaning.
   - Cache `deploymentSettings` in-process with invalidation on write. Cache the `requireMembership`
     result per (session, space) for a few seconds.
   - Add `maxAge: 600` to the CORS middleware.
   - Make `computer.heartbeat` fire `keepAlive` without awaiting it.

Expected effect: idle traffic drops from about 20+ to about 1 request per minute per tab. Per-request
server time drops by the auth overhead (about 6 queries). The shell stops re-rendering on its own.

## Phase 2: push instead of poll

1. **Add a space-level realtime topic** (`spaces.subscribe`, or extend the existing stream) on the
   current LISTEN/NOTIFY fan-out. It emits small `bot.updated`, `run.status`, `thread.preview` and
   `group.updated` deltas, and the client applies them to the bot list in place. `spaces.list` then
   becomes a boot and resync call only. Mobile subscribes to the same topic, so the contract lives in
   `packages/contracts`.
2. **Add a revision to `spaces.list`**, for example the max event id or a per-space counter. Clients
   send `ifRevision` and the server returns `{ unchanged: true }` without running the 10 queries.
   This is the fallback for clients that cannot hold a stream.
3. **Make terminal events self-contained.** Include the final run status and any
   routine/skill/screen deltas in the event payload, so no client needs `threads.get` after a run.

## Phase 3: make the hot reads cheap

1. **Denormalize the sidebar preview.** Store `lastMessagePreview`, `lastMessageAt` and
   `activeRunStatus` on the thread (or bot), written in the same transaction that inserts the
   message or changes the run. `listBots` stops loading 16 messages with `blocks` per bot, and the
   per-bot fallback disappears.
2. If Phase 0 confirms in-memory nested `take`, set `relationLoadStrategy: "join"` (or rewrite with a
   lateral join) for the remaining nested includes.
3. **Indexes** (one migration):
   - add `runs(botId, status, createdAt)`
   - add `runs(spaceId, userId, status, completedAt)`
   - add `messages(runId)`
   - drop the duplicate `(threadId, seq)` indexes on `Message` and `Event`
4. **Bound the unbounded reads.**
   - Cap `liveEvents` in `threads.get` (keep the latest N per run; the stream backfills the rest).
   - Add a page budget to the `loadMessagePage` loop.
   - Add `take` to "active" `runs.list`.
   - Fetch `resolveBusyBotName` outside the transaction.
5. **Cut the boot to one round-trip.** Extend `rpc.bootstrap` to return session, capabilities,
   billing status, `me` and the first `spaces.list` page together. Start it before `SubscriptionGate`
   renders, so the gate reads from it instead of chaining three calls. Move `memory.providerConfig`,
   `voice.status`, `messaging.status` and `agentSkills.list` behind first use, or into bootstrap if
   the first screen needs them.
6. Opt the safe idempotent reads (`links.favicon`, `voice.catalog`, model catalog) out of `no-store`
   with a short `private, max-age`, keeping account and chat responses `no-store`.

## Phase 4: render less

1. **Stabilize props.**
   - Pass `onReply`, `onQuote` and `onOpenPeerMessages` as `useCallback`s.
   - Pass `onSpeak` and the message id instead of a per-row closure.
   - Memoize `workingBots` and derive `peerBot` from a bot map whose identity changes only when a bot does.

   Check with React Profiler that an idle 60 s produces zero commits.
2. **Throttle streaming paint.** Coalesce `thread.progress` into one commit per animation frame. Split
   the streaming markdown into a stable prefix (completed blocks, memoized) and a live tail, so each
   token re-parses only the tail. Hoist `remarkPlugins` and `urlTransform` to module constants. With
   streaming off, return the same `messages` array when nothing visible changed.
3. **Virtualize the transcript.** Start with `content-visibility: auto` plus `contain-intrinsic-size`
   on message rows (no dependency, safe with existing scroll anchoring), and move to windowing only if
   the 100+ message typing numbers still miss the target. Replace the `scrollHeight` read in the
   per-messages `useLayoutEffect` with a sentinel `IntersectionObserver`.
4. **Split the bundle.**
   - `React.lazy` `RoutineEditor`, `ActivityList`, `GroupPanel`, `BotSettings`, the computer workspace
     and the teach overlays.
   - Lazy-load `react-markdown` + `remark-gfm` behind the first message render, with plain-text fallback.
   - Import contracts and core through narrow entry points instead of the barrels.

   Add `build.rollupOptions.output.manualChunks` for vendor splitting, and keep the existing bundle-size
   regression check as the guard.
5. **Fix `LoadingState`.** Replace its 100 ms `setInterval` re-render with a CSS animation.

## Phase 5: guard against regressions

- Add a per-user token-bucket rate limit on `/rpc/*` in the API, sized generously (for example
  20 req/s sustained per session). It catches runaway clients without affecting normal use; log and
  return 429 with `Retry-After`. Keep it provider-neutral and in-process; nothing hosted is required.
- Fail the performance comparison when idle requests per minute exceed the target, or when boot
  requests grow, so a new poller can't quietly bring the flood back.
- Check SSE latency through Caddy with `encode` enabled; exclude `text/event-stream` from encoding if
  flushing adds delay.

## Order and expected payoff

| Step | Effort | Flood | Latency |
| --- | --- | --- | --- |
| Phase 0: measurement | S | baseline | baseline |
| Phase 1.1–1.5: polls, no-op updates, coalescing, backoff | S | ~90% fewer idle requests | removes the 3 s full re-render |
| Phase 1.7: pool, auth cache, settings cache | S | — | about 6 fewer queries on every request; ends pool queueing |
| Phase 1.6 + 3.5: N+1 removal, one-round-trip boot | M | 13 + N → ≤ 8 on boot | removes 2–3 boot round-trips |
| Phase 3.1–3.4: denormalized preview, indexes, bounds | M | — | `spaces.list` and `threads.get` p95 down sharply |
| Phase 4.1–4.3: memo, streaming paint, virtualization | M | — | typing and streaming CPU about halved |
| Phase 2: space topic and revisions | L | polling replaced by push | updates arrive at event latency |
| Phase 4.4: bundle split | M | — | cold shell-usable down |

Phases 0 and 1 alone should clear the "half the requests, twice as responsive" bar for the idle and
run paths. Phases 3 and 4 carry the cold-boot and long-thread numbers the rest of the way. Phase 2 is
the structural fix that keeps the flood from coming back as features add more state.
