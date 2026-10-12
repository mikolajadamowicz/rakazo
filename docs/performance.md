# Desktop performance benchmarks

Rakazo measures the production Vite renderer inside a packaged Electron directory build against a
disposable Postgres database, the scripted agent runtime, and the fake sandbox. No provider account
or production data is used.

Run a baseline from a local Conductor workspace with Docker available:

```sh
pnpm perf:desktop -- --label=before
```

The command uses `CONDUCTOR_PORT` and the next allocated port for its web and API servers. Reports
are written to `.context/performance/<label>.json` and `.md`, which remain local to the workspace.
Override the number of cold and warm launch samples when iterating:

```sh
pnpm perf:desktop -- --label=quick --samples=2
```

To compare packaged assets with remote asset loading under a deterministic network delay:

```bash
pnpm perf:desktop -- --label=remote-80ms --asset-delay=80 --remote-renderer
pnpm perf:desktop -- --label=bundled-80ms --asset-delay=80 --skip-build
```

On macOS, compare destroy/recreate against the retained warm window with:

```bash
pnpm perf:desktop -- --label=reopen-destroyed --disable-warm-window
pnpm perf:desktop -- --label=reopen-retained --skip-build
```

After changing one performance-sensitive behavior, record another report and compare them:

```sh
pnpm perf:desktop -- --label=after
pnpm perf:compare .context/performance/before.json .context/performance/after.json
```

## Definitions

- **Cache-cold launch** uses a fresh copy of an authenticated profile and clears Chromium's HTTP and
  code caches before navigation. It is not an OS-filesystem cold start.
- **Warm launch** fully quits and relaunches Electron while preserving the primed profile and caches.
- **Shell usable** means authenticated bots and the active 100-message thread have committed and
  painted.
- **Settings painted/settled** separates React content paint from the end of the panel transition.
- **Typing** records keydown to the next animation frame with a 100-message transcript mounted.
- **Idle CPU/memory** samples every second for 12 seconds. Summed working-set memory is retained
  alongside raw per-process samples; Chromium working sets can double-count shared pages.
- **Streaming** drives the real subscription/reducer path with scripted progress every 50 ms.

Runtime CPU and launch measurements are informational until enough samples exist on a fixed Mac.
Bundle sizes are deterministic enough for automated regression checks. Keep hardware, platform, and
build mode fixed. A comparison that intentionally changes Electron or renderer mode measures the
combined migration result; it cannot attribute the change to either layer in isolation.

# Web latency and request benchmark

The web benchmark loads a production build of the web app in Chromium against the real API, a
disposable Postgres database, the scripted agent runtime and the fake sandbox. The API adds a fixed
round trip to every request (`BENCH_RTT_MS`, default 60) and counts requests per procedure, so
request waterfalls and polling show up as numbers.

Start the API against an empty database, then a production build behind `vite preview`, then the
driver:

```sh
DATABASE_URL=postgres://<user>@<host>:<port>/<disposable-db> \
  pnpm exec tsx packages/testkit/src/cli/web-performance-server.ts

cd apps/web
pnpm build
API_PROXY_TARGET=http://127.0.0.1:3120 WEB_PORT=5190 SCREEN_PROXY_SECRET=<any-32-chars> \
  pnpm exec vite preview --port 5190 --strictPort

BENCH_LABEL=after pnpm exec playwright test -c bench/playwright.config.ts
```

Reports go to `test-report/web-performance/<label>.json`. `BENCH_PROFILE=1` also saves a CPU profile
of the last page load. Recreate the database between runs so every label sees the same data.

## What it measures

- **Shell usable**: navigation start until the active thread's newest message and the composer are
  in the DOM, sampled every frame. Eight warm loads; the median is reported.
- **Full transcript mounted**: the same, until the oldest loaded message is in the DOM.
- **Boot requests**: requests made until the shell is usable, and two and a half seconds later.
- **Idle**: requests, server time and page main-thread time over 45 seconds with nothing happening.
- **Per run**: requests from pressing Enter until the run has finished and settled.
- **Typing**: keydown to next frame with the seeded transcript mounted. This is frame-bound.
