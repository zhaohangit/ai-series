import { describe, it, expect, vi } from "vitest";
describe("local account bootstrap", () => {
  it("waits for a single session response before any authenticated request", async () => {
    vi.resetModules();
    const paths: string[] = [];
    let resolveSession: (value: Response) => void = () => {};
    const pending = new Promise<Response>(
      (resolve) => (resolveSession = resolve),
    );
    const original = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const path = String(input);
      paths.push(path);
      if (path === "/api/session") return pending;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    try {
      const { api, ensureSession } = await import("./api");
      const boot = ensureSession();
      const first = api("/projects");
      const second = api("/assets");
      expect(paths).toEqual(["/api/session"]);
      resolveSession(
        new Response(JSON.stringify({ user: { id: "one-account" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await Promise.all([boot, first, second]);
      expect(paths.filter((p) => p === "/api/session")).toHaveLength(1);
      expect(paths).toEqual(["/api/session", "/api/projects", "/api/assets"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
