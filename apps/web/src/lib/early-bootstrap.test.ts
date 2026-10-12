import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { initialBootstrapTarget } from "./bootstrap-target";

const html = readFileSync(fileURLToPath(new URL("../../index.html", import.meta.url)), "utf8");
const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
  .map((match) => match[1] ?? "")
  .find((body) => body.includes("__rakazoEarlyBootstrap"));

function runInlineScript(pathname: string, desktop: boolean, spaceId: string | null) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const win: Record<string, unknown> = desktop ? { rakazoDesktop: {} } : {};
  new Function("window", "location", "localStorage", "fetch", script ?? "")(
    win,
    { pathname },
    { getItem: () => spaceId },
    (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(new Response("{}"));
    },
  );
  return { early: win.__rakazoEarlyBootstrap as { botId?: string } | undefined, calls };
}

// index.html cannot import the bundle, so its copy of the routing rule is pinned here.
describe("index.html early bootstrap", () => {
  it.each([
    ["/app", false],
    ["/app/bot-1", false],
    ["/app/bot%201", false],
    ["/app/%E0%A4%A", false],
    ["/app/g/group-1", false],
    ["/app/artifacts/a-1", false],
    ["/app/board", false],
    ["/", true],
    ["/", false],
    ["/sign-in", false],
    ["/onboarding", true],
  ])("matches initialBootstrapTarget for %s (desktop %s)", (pathname, desktop) => {
    const target = initialBootstrapTarget(pathname, desktop);
    const { early, calls } = runInlineScript(pathname, desktop, null);
    expect(Boolean(early)).toBe(Boolean(target));
    if (!target) return expect(calls).toHaveLength(0);
    expect(early?.botId).toBe(target.botId);
    expect(calls.map((call) => call.url)).toEqual(["/api/auth/get-session", "/rpc/bootstrap"]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      json: target.botId ? { botId: target.botId } : {},
    });
  });

  it("sends the selected space", () => {
    const { calls } = runInlineScript("/app/bot-1", false, "space-2");
    expect(calls[1]?.init.headers).toMatchObject({ "x-rakazo-space-id": "space-2" });
  });
});
