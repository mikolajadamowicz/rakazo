/**
 * API for the web performance benchmark (docs/performance.md): the real app against a disposable
 * database, the scripted runtime and the fake sandbox, with a fixed simulated round trip and a
 * per-procedure request ledger at /__bench/counts.
 */
import { execSync } from "node:child_process";
import path from "node:path";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL to a disposable Postgres database");
const apiPort = Number(process.env.API_PORT ?? 3120);
const webPort = Number(process.env.WEB_PORT ?? 5190);
const rttMs = Number(process.env.BENCH_RTT_MS ?? 60);
const webOrigin = `http://127.0.0.1:${webPort}`;

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  REALTIME_DATABASE_URL: databaseUrl,
  WAKEUP_DRIVER: "memory",
  SANDBOX_PROVIDER: "fake",
  AGENT_RUNTIME: "scripted",
  CLOUD_AGENT_PROVIDER: "emulator",
  COMPOSIO_API_KEY: "",
  BETTER_AUTH_SECRET: "test-secret-test-secret-32chars!",
  ENCRYPTION_KEY: "test-encryption-key-test-encryption-key",
  SANDBOX_SUPERVISOR_TOKEN: "test-supervisor-token-test-32chars",
  SCREEN_PROXY_SECRET: "test-screen-proxy-secret-test-32chars",
  BETTER_AUTH_URL: webOrigin,
  WEB_ORIGIN: webOrigin,
  API_PORT: String(apiPort),
  API_URL: `http://127.0.0.1:${apiPort}`,
  DATA_DIR: path.resolve("test-report", "web-performance-data"),
  SIGNUPS_ENABLED: "true",
  SIGNUP_ALLOWLIST: "",
  CI: "1",
});

execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
  stdio: "inherit",
  env: process.env,
  cwd: path.resolve("packages/db"),
});

const [{ ComposioEmulator, EmailEmulator }, { createApp }, { serve }] = await Promise.all([
  import("@rakazo/adapters"),
  import("../../../../apps/api/src/app.ts"),
  import("@hono/node-server"),
]);
const handles = await createApp({
  databaseUrl,
  prisma: undefined,
  composio: new ComposioEmulator(),
  email: new EmailEmulator(),
  integrationsCatalogUrl: "https://catalog.example.test/",
});

// API calls by procedure, plus server-side time. Requests the driver itself makes are not counted.
let counts: Record<string, number> = {};
let serverMs = 0;
let serverMsByPath: Record<string, number[]> = {};
serve({
  port: apiPort,
  hostname: "127.0.0.1",
  fetch: async (request) => {
    const { pathname } = new URL(request.url);
    if (pathname === "/__bench/reset") {
      counts = {};
      serverMs = 0;
      serverMsByPath = {};
      return Response.json({ ok: true });
    }
    if (pathname === "/__bench/counts") return Response.json({ counts, serverMs, serverMsByPath });
    if (!request.headers.get("x-bench-driver")) counts[pathname] = (counts[pathname] ?? 0) + 1;
    // Simulated network round trip so request waterfalls cost what they cost in production.
    if (rttMs > 0) await new Promise((resolve) => setTimeout(resolve, rttMs));
    const started = performance.now();
    const response = await handles.app.fetch(request);
    const elapsed = performance.now() - started;
    serverMs += elapsed;
    const timings = serverMsByPath[pathname] ?? [];
    timings.push(Math.round(elapsed));
    serverMsByPath[pathname] = timings;
    return response;
  },
});
console.log(`web performance api on ${apiPort}, rtt ${rttMs}ms`);
