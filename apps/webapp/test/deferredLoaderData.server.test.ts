import { defer } from "@remix-run/node";
import { describe, expect, it } from "vitest";
import { settleDeferredLoaderData } from "~/utils/deferredLoaderData.server";

function contextWith(deferred: ReturnType<typeof defer>) {
  return { staticHandlerContext: { activeDeferreds: { "routes/page": deferred } } } as never;
}

describe("settleDeferredLoaderData", () => {
  // Catches: a page sent in one piece rendering while deferred data is still loading, which puts
  // that data after the script that starts hydration.
  it("waits until no deferred value is pending", async () => {
    let resolve!: (value: string) => void;
    const deferred = defer({
      ready: "now",
      slow: new Promise<string>((r) => {
        resolve = r;
      }),
    });

    const settled = settleDeferredLoaderData(contextWith(deferred), 5_000);
    expect(deferred.pendingKeys).toEqual(["slow"]);

    resolve("later");
    await settled;
    expect(deferred.pendingKeys).toEqual([]);
  });

  it("counts a rejected value as settled", async () => {
    const deferred = defer({ broken: Promise.reject(new Error("nope")) });
    await settleDeferredLoaderData(contextWith(deferred), 5_000);
    expect(deferred.pendingKeys).toEqual([]);
  });

  it("stops waiting after the limit", async () => {
    const deferred = defer({ never: new Promise(() => {}) });
    await settleDeferredLoaderData(contextWith(deferred), 10);
    expect(deferred.pendingKeys).toEqual(["never"]);
  });

  it("returns at once when the page has no deferred data", async () => {
    await settleDeferredLoaderData(
      { staticHandlerContext: { activeDeferreds: null } } as never,
      5_000
    );
  });
});
