import type { EntryContext } from "@remix-run/node";

/**
 * Waits, for up to `timeoutMs`, for the deferred loader data of the page being rendered.
 *
 * A page sent in one piece puts deferred data that was still loading when it rendered after
 * the script that starts hydration. A browser can then start hydrating before it has read that
 * part of the page, and hydration of the whole page fails (React #418, then #423). Data that
 * has already settled is written before that script instead.
 */
export async function settleDeferredLoaderData(
  context: Pick<EntryContext, "staticHandlerContext">,
  timeoutMs: number
) {
  const pending = Object.values(context.staticHandlerContext.activeDeferreds ?? {}).flatMap(
    (deferred) => deferred.pendingKeys.map((key) => deferred.data[key])
  );
  if (pending.length === 0) return;

  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled(pending),
    new Promise((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
    }),
  ]);
  clearTimeout(timer);
}
