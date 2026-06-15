import { type LoaderFunctionArgs, redirect } from "@remix-run/server-runtime";
import { EnvironmentParamSchema, v3EnvironmentPath } from "~/utils/pathBuilder";

/**
 * The standalone `/schedules` listing page was removed when the unified
 * Tasks page subsumed the Agents / Standard / Schedules listings. This
 * thin redirect catches bookmarks and shared links pointing at the old
 * URL and sends users to the Tasks page pre-filtered to Scheduled tasks.
 *
 * Individual schedule routes (`/schedules/:scheduleParam`,
 * `/schedules/edit/:scheduleParam`, `/schedules/new`) live in sibling
 * route files and are unaffected.
 */
export async function loader({ params }: LoaderFunctionArgs) {
  const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);
  const tasksPath = v3EnvironmentPath(
    { slug: organizationSlug },
    { slug: projectParam },
    { slug: envParam }
  );
  return redirect(`${tasksPath}?types=SCHEDULED`);
}
