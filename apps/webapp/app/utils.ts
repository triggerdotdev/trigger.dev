import type { RouteMatch } from "@remix-run/react";
import { useMatches } from "@remix-run/react";
import humanizeDuration from "humanize-duration";

const DEFAULT_REDIRECT = "/";

/**
 * This should be used any time the redirect path is user-provided
 * (Like the query string on our login/signup pages). This avoids
 * open-redirect vulnerabilities.
 * @param {string} to The redirect destination
 * @param {string} defaultRedirect The redirect to use if the to is unsafe.
 */
export function safeRedirect(
  to: FormDataEntryValue | string | null | undefined,
  defaultRedirect: string = DEFAULT_REDIRECT
) {
  if (!to || typeof to !== "string") {
    return defaultRedirect;
  }

  if (!to.startsWith("/") || to.startsWith("//")) {
    return defaultRedirect;
  }

  return to;
}

/**
 * This base hook is used in other hooks to quickly search for specific data
 * across all loader data using useMatches.
 * @param {string} id The route id
 * @returns {JSON|undefined} The router data or undefined if not found
 */
export function useMatchesData(
  id: string | string[],
  debug: boolean = false
): RouteMatch | undefined {
  const matchingRoutes = useMatches();

  if (debug) {
    console.log("matchingRoutes", matchingRoutes);
  }

  const paths = Array.isArray(id) ? id : [id];

  // Get the first matching route
  const route = paths.reduce((acc, path) => {
    if (acc) return acc;
    return matchingRoutes.find((route) => route.id === path);
  }, undefined as RouteMatch | undefined);

  return route;
}

export function validateEmail(email: unknown): email is string {
  return typeof email === "string" && email.length > 3 && email.includes("@");
}

export function hydrateObject<T>(object: any): T {
  return hydrateDates(object) as T;
}

export function hydrateDates(object: any): any {
  if (object === null || object === undefined) {
    return object;
  }

  if (object instanceof Date) {
    return object;
  }

  if (
    typeof object === "string" &&
    object.match(/\d{4}-\d{2}-\d{2}/) &&
    !isNaN(Date.parse(object))
  ) {
    return new Date(object);
  }

  if (typeof object === "object") {
    if (Array.isArray(object)) {
      return object.map((item) => hydrateDates(item));
    } else {
      const hydratedObject: any = {};
      for (const key in object) {
        hydratedObject[key] = hydrateDates(object[key]);
      }
      return hydratedObject;
    }
  }

  return object;
}

type DurationOptions = {
  style?: "long" | "short";
  maxDecimalPoints?: number;
};

export function formatDuration(
  start?: Date | null,
  end?: Date | null,
  options?: DurationOptions
): string {
  if (!start || !end) {
    return "–";
  }

  return formatDurationMilliseconds(dateDifference(start, end), options);
}

export function formatDurationMilliseconds(
  milliseconds: number,
  options?: DurationOptions
): string {
  let duration = humanizeDuration(milliseconds, {
    maxDecimalPoints: options?.maxDecimalPoints ?? 1,
    largest: 2,
  });

  if (!options) {
    return duration;
  }

  switch (options.style) {
    case "short":
      duration = duration.replace(" seconds", "s");
      duration = duration.replace(" second", "s");
      duration = duration.replace(" minutes", "m");
      duration = duration.replace(" minute", "m");
      duration = duration.replace(" hours", "h");
      duration = duration.replace(" hour", "h");
      duration = duration.replace(" days", "d");
      duration = duration.replace(" day", "d");
      duration = duration.replace(" weeks", "w");
      duration = duration.replace(" week", "w");
      duration = duration.replace(" months", "mo");
      duration = duration.replace(" month", "mo");
      duration = duration.replace(" years", "y");
      duration = duration.replace(" year", "y");
  }

  return duration;
}

export function titleCase(original: string): string {
  return original
    .split(" ")
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

function dateDifference(date1: Date, date2: Date) {
  return Math.abs(date1.getTime() - date2.getTime());
}

// Takes an api key (either trigger_live_xxxx or trigger_development_xxxx) and returns trigger_live_********
export const obfuscateApiKey = (apiKey: string) => {
  const [prefix, slug, secretPart] = apiKey.split("_");
  return `${prefix}_${slug}_${"*".repeat(secretPart.length)}`;
};

export function appEnvTitleTag(
  appEnv?: "test" | "production" | "development" | "staging"
): string {
  if (!appEnv) {
    return "";
  }

  switch (appEnv) {
    case "test":
      return " (test)";
    case "production":
      return "";
    case "development":
      return " (dev)";
    case "staging":
      return " (staging)";
  }
}
