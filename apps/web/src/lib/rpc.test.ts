import { afterEach, describe, expect, it, vi } from "vitest";
import { clearSpaceSelection, rpc, selectedSpaceId, selectSpace } from "./rpc.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("space selection storage", () => {
  it("reports localStorage write failures without throwing", () => {
    const localStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: () => {
        throw new Error("quota exceeded");
      },
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(false);
    expect(() => clearSpaceSelection()).not.toThrow();
    expect(selectedSpaceId()).toBeNull();
  });

  it("treats an already-persisted selection as success when writes fail", () => {
    const localStorage = {
      getItem: (key: string) => (key === "rakazo:space-id" ? "space-support" : null),
      setItem: () => {
        throw new Error("quota exceeded");
      },
      removeItem: vi.fn(),
    };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(selectSpace("space-other")).toBe(false);
  });

  it("reports when a space selection was persisted", () => {
    const setItem = vi.fn();
    const localStorage = { getItem: () => null, setItem, removeItem: vi.fn() };
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);

    expect(selectSpace("space-support")).toBe(true);
    expect(setItem).toHaveBeenCalledWith("rakazo:space-id", "space-support");
  });
});

describe("request dedupe", () => {
  function stubBrowser() {
    const fetch = vi.fn(async () => Response.json({ json: [] }));
    vi.stubGlobal("window", {
      location: { origin: "http://rakazo.test", pathname: "/" },
      localStorage: { getItem: () => null },
    });
    vi.stubGlobal("fetch", fetch);
    return fetch;
  }

  it("shares one request between identical reads issued together", async () => {
    const fetch = stubBrowser();

    await Promise.all([rpc.bots.list(), rpc.bots.list(), rpc.bots.list()]);

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps writes and explicit-space reads as separate requests", async () => {
    const fetch = stubBrowser();

    await Promise.allSettled([
      rpc.threads.markRead({ botId: "bot-a" }),
      rpc.threads.markRead({ botId: "bot-a" }),
      rpc.bots.list(undefined, { context: { spaceId: "space-a" } }),
      rpc.bots.list(undefined, { context: { spaceId: "space-b" } }),
    ]);

    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
