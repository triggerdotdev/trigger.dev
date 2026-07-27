import { StarIcon as StarIconOutline } from "@heroicons/react/24/outline";
import { StarIcon as StarIconSolid } from "@heroicons/react/20/solid";
import { useFetcher, useLocation, useSearchParams } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { useIsImpersonating } from "~/hooks/useOrganizations";
import { useOptionalUser } from "~/hooks/useUser";
import { cn } from "~/utils/cn";
import { Button } from "../primitives/Buttons";
import { ShortcutKey } from "../primitives/ShortcutKey";
import { useShortcuts } from "../primitives/ShortcutsProvider";
import { SimpleTooltip } from "../primitives/Tooltip";
import {
  buildFavoriteLabel,
  canonicalFavoriteUrl,
  FAVORITE_SEARCH_PARAM,
  FAVORITES_ACTION_PATH,
  favoritePageUrl,
  resolvePageMeta,
  useFavorites,
} from "./favoritePages";

/**
 * The star in the page header that favorites the current page (full URL, including filters and
 * tabs) to the side menu. Toggled by click or Option+F.
 */
export function FavoritePageButton({
  pageTitle,
  className,
}: {
  pageTitle?: string;
  className?: string;
}) {
  const user = useOptionalUser();
  const isImpersonating = useIsImpersonating();
  const location = useLocation();
  const favorites = useFavorites();
  const fetcher = useFetcher();
  const { areShortcutsEnabled } = useShortcuts();
  const [, setSearchParams] = useSearchParams();

  // The marker param and pagination position never count toward URL identity, so paging through
  // a favorited view keeps the same favorite (and never saves a soon-stale cursor)
  const url = favoritePageUrl(location.pathname, location.search);

  // A marker that isn't one of this user's favorites came from a shared link (or a favorite
  // that's since been removed): clean it from the URL so the page behaves like a normal visit.
  const marker = new URLSearchParams(location.search).get(FAVORITE_SEARCH_PARAM);
  const hasForeignMarker =
    user !== undefined && marker !== null && !favorites.some((f) => f.id === marker);

  useEffect(() => {
    if (!hasForeignMarker) return;
    setSearchParams(
      (previous) => {
        const next = new URLSearchParams(previous);
        next.delete(FAVORITE_SEARCH_PARAM);
        return next;
      },
      { replace: true, preventScrollReset: true }
    );
  }, [hasForeignMarker, setSearchParams]);
  const existing = favorites.find((favorite) => canonicalFavoriteUrl(favorite.url) === url);
  const isFavorited = existing !== undefined;
  // The tooltip names the favorite: its custom name once saved, else the label saving would use
  // (which includes detail-page ids and filter summaries, e.g. "Runs: Completed, last 7d")
  const pageName =
    existing?.label ?? buildFavoriteLabel(location.pathname, location.search, pageTitle);

  const toggle = () => {
    if (existing) {
      fetcher.submit(
        { intent: "remove", id: existing.id },
        { method: "POST", action: FAVORITES_ACTION_PATH }
      );
    } else {
      fetcher.submit(
        {
          intent: "add",
          id: crypto.randomUUID(),
          url,
          label: buildFavoriteLabel(location.pathname, location.search, pageTitle),
          icon: resolvePageMeta(location.pathname).icon,
        },
        { method: "POST", action: FAVORITES_ACTION_PATH }
      );
    }
  };

  // The listener reads the latest toggle through a ref so it isn't re-attached every render
  const toggleRef = useRef(toggle);
  toggleRef.current = toggle;

  const showButton = user !== undefined && !isImpersonating;

  useEffect(() => {
    if (!showButton || !areShortcutsEnabled) return;

    const onKeyDown = (event: KeyboardEvent) => {
      // Matched on `event.code`: on macOS, Option makes "F" report "ƒ" via `event.key`, so the
      // event.key-based useShortcutKeys hook can't capture Option+letter (see GlobalShortcuts).
      if (
        event.code !== "KeyF" ||
        !event.altKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey
      ) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      event.preventDefault();
      toggleRef.current();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [showButton, areShortcutsEnabled]);

  if (!showButton) {
    return null;
  }

  const tooltipLabel = isFavorited
    ? `Remove ${pageName} from favorites`
    : `Add ${pageName} to favorites`;

  return (
    <SimpleTooltip
      delayDuration={500}
      disableHoverableContent
      asChild
      side="bottom"
      button={
        // Span wrapper: Button drops the pointer-event props Radix injects via asChild, so the
        // tooltip trigger has to be a plain element (same pattern as CollapseMenuButton).
        <span className={cn("flex", className)}>
          <Button
            variant="minimal/small"
            className="aspect-square h-6 p-1"
            onClick={toggle}
            aria-label={tooltipLabel}
            aria-pressed={isFavorited}
            LeadingIcon={
              isFavorited ? (
                <StarIconSolid className="size-4 text-yellow-500" />
              ) : (
                <StarIconOutline className="size-4 text-text-dimmed transition-colors group-hover/button:text-text-bright" />
              )
            }
          />
        </span>
      }
      content={
        <span className="flex items-center gap-2">
          {tooltipLabel}
          <ShortcutKey shortcut={{ modifiers: ["alt"], key: "f" }} variant="medium/bright" />
        </span>
      }
    />
  );
}
