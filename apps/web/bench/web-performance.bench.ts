import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { activeBotId, completeOnboarding, signup } from "../e2e/helpers";

async function rpc<T>(page: Page, procedure: string, body: unknown): Promise<T> {
  const response = await page.request.post(`/rpc/${procedure}`, {
    data: { json: body },
    headers: { "x-bench-driver": "1" },
  });
  const parsed = (await response.json()) as { json?: T };
  if (!response.ok()) throw new Error(`${procedure} ${response.status()}`);
  return parsed.json as T;
}

const API = process.env.BENCH_API ?? "http://127.0.0.1:3120";
const label = process.env.BENCH_LABEL ?? "run";
const outDir = process.env.BENCH_OUT ?? path.resolve("../../test-report/web-performance");
const BOTS = 12;
const SEED_SENDS = 25;
const IDLE_MS = 45_000;

async function reset() {
  await fetch(`${API}/__bench/reset`);
}
async function counts(): Promise<{
  counts: Record<string, number>;
  serverMs: number;
  serverMsByPath: Record<string, number[]>;
}> {
  return (await fetch(`${API}/__bench/counts`)).json();
}
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs: number[]) =>
  [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))];

async function mainThreadMs(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  return async () => {
    const { metrics } = await cdp.send("Performance.getMetrics");
    const get = (name: string) => metrics.find((m) => m.name === name)?.value ?? 0;
    return { task: get("TaskDuration") * 1000, script: get("ScriptDuration") * 1000 };
  };
}

async function waitRunsIdle(page: Page, botId: string) {
  for (let i = 0; i < 150; i += 1) {
    const thread = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", { botId });
    if (!thread.run || !["queued", "leased", "running"].includes(thread.run.status ?? "")) return;
    await page.waitForTimeout(200);
  }
  throw new Error("run did not settle");
}

test("web latency and request flood", async ({ page }) => {
  const result: Record<string, unknown> = { label };
  await signup(page, `bench-${Date.now()}@rakazo.test`, "password12", "Bench");
  await completeOnboarding(page);
  const chiefId = activeBotId(page);
  for (let i = 0; i < BOTS - 1; i += 1) {
    await rpc(page, "bots/create", {
      name: `Bot ${i + 1}`,
      title: "",
      description: "",
      notifyOnFinish: true,
      computerMode: "team",
    });
  }
  for (let i = 0; i < SEED_SENDS; i += 1) {
    await rpc(page, "threads/send", {
      botId: chiefId,
      text: `seed message number ${i} with **some** markdown and a list:\n\n- one\n- two`,
    });
    await waitRunsIdle(page, chiefId);
  }
  const lastSeed = `seed message number ${SEED_SENDS - 1}`;

  // 1. Shell usable: reload until the active thread's newest message has painted.
  const usable: number[] = [];
  const fullTranscript: number[] = [];
  const bootRequests: number[] = [];
  const bootRequestsSettled: number[] = [];
  let bootBreakdown: Record<string, number> = {};
  const waterfall: string[] = [];
  const LOADS = 9;
  for (let i = 0; i < LOADS; i += 1) {
    await page.goto("about:blank");
    const t0 = Date.now();
    const onDone = (req: import("@playwright/test").Request) => {
      const url = new URL(req.url());
      if (i === LOADS - 1 && /^\/(rpc|api)\//.test(url.pathname))
        waterfall.push(
          `${req.timing().startTime ? Math.round(req.timing().startTime - t0) : "?"}ms +${Math.round(req.timing().responseEnd)} ${url.pathname}`,
        );
    };
    page.on("requestfinished", onDone);
    await reset();
    const start = Date.now();
    const profiling = i === LOADS - 1 && process.env.BENCH_PROFILE;
    const cdp = profiling ? await page.context().newCDPSession(page) : undefined;
    if (cdp) {
      await cdp.send("Profiler.enable");
      await cdp.send("Profiler.setSamplingInterval", { interval: 100 });
      await cdp.send("Profiler.start");
    }
    await page.goto(`/app/${chiefId}`);
    // Sampled every frame in the page; time origin is navigation start.
    const handle = await page.waitForFunction(
      (text) =>
        document.querySelector('[data-testid="transcript"]')?.textContent?.includes(text) &&
        document.querySelector('textarea[placeholder^="Message"]')
          ? performance.now()
          : false,
      lastSeed,
      { polling: "raf", timeout: 30_000 },
    );
    const elapsed = Math.round((await handle.jsonValue()) as number);
    if (cdp) {
      const { profile } = await cdp.send("Profiler.stop");
      mkdirSync(outDir, { recursive: true });
      writeFileSync(path.join(outDir, `${label}-boot.cpuprofile`), JSON.stringify(profile));
    }
    if (i === LOADS - 1)
      result.bootMarks = await page.evaluate(() =>
        performance
          .getEntriesByType("mark")
          .filter((m) => m.name.startsWith("rk:"))
          .map((m) => `${Math.round(m.startTime)} ${m.name}`),
      );
    void start;
    const atUsable = total((await counts()).counts);
    const fullHandle = await page.waitForFunction(
      () =>
        document
          .querySelector('[data-testid="transcript"]')
          ?.textContent?.includes("seed message number 0 ")
          ? performance.now()
          : false,
      undefined,
      { polling: "raf", timeout: 30_000 },
    );
    const full = Math.round((await fullHandle.jsonValue()) as number);
    await page.waitForTimeout(2_500);
    const settled = await counts();
    page.off("requestfinished", onDone);
    if (i === 0) continue; // first load warms the server and HTTP caches
    usable.push(elapsed);
    fullTranscript.push(full);
    bootRequests.push(atUsable);
    bootRequestsSettled.push(total(settled.counts));
    bootBreakdown = settled.counts;
    result.bootServerMsByPath = settled.serverMsByPath;
  }
  result.shellUsableMedianMs = median(usable);
  result.shellUsableSamples = usable;
  result.fullTranscriptMountedMedianMs = median(fullTranscript);
  result.requestsAtShellUsable = median(bootRequests);
  result.requestsBootSettled = median(bootRequestsSettled);
  result.bootBreakdown = bootBreakdown;
  result.bootWaterfall = waterfall;

  // Server-only cost of the two heaviest reads, called one after another from the driver.
  await reset();
  for (let i = 0; i < 15; i += 1) {
    await rpc(page, "bootstrap", { botId: chiefId });
    await rpc(page, "spaces/list", undefined);
  }
  const serverOnly = (await counts()).serverMsByPath;
  result.serverBootstrapMedianMs = median(serverOnly["/rpc/bootstrap"] ?? []);
  result.serverSpacesListMedianMs = median(serverOnly["/rpc/spaces/list"] ?? []);

  // 2. Idle visible tab: requests per minute and main-thread time.
  await page.waitForTimeout(3_000);
  const sample = await mainThreadMs(page);
  const before = await sample();
  await reset();
  await page.waitForTimeout(IDLE_MS);
  const idle = await counts();
  const after = await sample();
  const minutes = IDLE_MS / 60_000;
  result.idleRequestsPerMin = Math.round((total(idle.counts) / minutes) * 10) / 10;
  result.idleBreakdown = idle.counts;
  result.idleServerMsPerMin = Math.round(idle.serverMs / minutes);
  result.idleMainThreadMsPerMin = Math.round((after.task - before.task) / minutes);
  result.idleScriptMsPerMin = Math.round((after.script - before.script) / minutes);

  // 3. One finished run: requests from send to settled, and time from Enter to reply painted.
  const composer = page.getByRole("combobox", { name: /^Message/ });
  const runs: number[] = [];
  const replyMs: number[] = [];
  let runBreakdown: Record<string, number> = {};
  for (let i = 0; i < 3; i += 1) {
    const text = `bench run ${i} ${Date.now()}`;
    const messages = page.getByTestId("transcript").locator("[data-message-id]");
    const before = await messages.count();
    await reset();
    await composer.fill(text);
    const sent = Date.now();
    await page.keyboard.press("Enter");
    await expect(messages).toHaveCount(before + 2, { timeout: 30_000 });
    replyMs.push(Date.now() - sent);
    await waitRunsIdle(page, chiefId).catch(() => undefined);
    await page.waitForTimeout(2_000);
    const c = await counts();
    runs.push(total(c.counts));
    runBreakdown = c.counts;
  }
  result.requestsPerRunMedian = median(runs);
  result.runBreakdown = runBreakdown;
  result.sendToReplyPaintedMedianMs = median(replyMs);

  // 4. Typing: keydown to next frame with the seeded transcript mounted.
  await composer.click();
  await composer.fill("");
  await page.evaluate(() => {
    const w = window as unknown as { __keyLat: number[]; __keyWork: number[] };
    w.__keyLat = [];
    w.__keyWork = [];
    window.addEventListener(
      "keydown",
      () => {
        const t = performance.now();
        requestAnimationFrame(() => setTimeout(() => w.__keyLat.push(performance.now() - t), 0));
        // Main-thread work for the keystroke: the task that dispatches it, including React's render.
        const channel = new MessageChannel();
        channel.port1.onmessage = () => w.__keyWork.push(performance.now() - t);
        channel.port2.postMessage(null);
      },
      true,
    );
  });
  await page.keyboard.type("the quick brown fox jumps over the lazy dog again and again", {
    delay: 40,
  });
  await page.waitForTimeout(500);
  const lat = await page.evaluate(() => (window as unknown as { __keyLat: number[] }).__keyLat);
  result.typingKeyToFrameP95Ms = Math.round(p95(lat) * 10) / 10;
  result.typingKeyToFrameMedianMs = Math.round(median(lat) * 10) / 10;
  const work = await page.evaluate(() => (window as unknown as { __keyWork: number[] }).__keyWork);
  result.typingKeyWorkP95Ms = Math.round(p95(work) * 10) / 10;
  result.typingKeyWorkMedianMs = Math.round(median(work) * 10) / 10;

  console.log(JSON.stringify(result, null, 2));
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, `${label}.json`), JSON.stringify(result, null, 2));
});
