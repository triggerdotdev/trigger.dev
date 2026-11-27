import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { isCalendarDay } from "~/components/deployments/deployActivityDays";
import { $replica, sqlDatabaseSchema } from "~/db.server";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import {
  getTimezonePreference,
  setDeployActivityPreference,
  uiPreferencesStorage,
} from "~/services/preferences/uiPreferences.server";
import { resolveProjectAuthScope } from "~/services/projectAuthScope.server";
import { dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import {
  type DeploymentActivityDay,
  type DeploymentOnDay,
  deploymentActivityByDay,
  deploymentsOnDay,
  safeTimeZone,
} from "~/v3/deploymentActivity.server";

const DaySchema = z.string().refine(isCalendarDay);

export type DeploymentActivityResponse = {
  /** The calendar days are in this time zone. */
  timeZone: string;
  /** YYYY-MM-DD in that time zone: the grid's last cell. */
  today: string;
  days: DeploymentActivityDay[];
};

export type DeploymentDayResponse = { day: string; deployments: DeploymentOnDay[] };

/**
 * The deployments list's activity grid. It's read when the grid is shown, not with the list
 * (which polls):
 * - no params: this environment's deployments per day, last 53 weeks
 * - `?day=YYYY-MM-DD`: that day's deployments, for the hover card
 */
export const loader = dashboardLoader(
  {
    params: EnvironmentParamSchema,
    context: (params) => resolveProjectAuthScope(params.organizationSlug, params.projectParam),
    authorization: { action: "read", resource: { type: "deployments" } },
  },
  async ({ params, user, request }) => {
    const project = await findProjectBySlug(params.organizationSlug, params.projectParam, user.id);
    if (!project) {
      throw new Response(undefined, { status: 404, statusText: "Project not found" });
    }

    const environment = await findEnvironmentBySlug(project.id, params.envParam, user.id);
    if (!environment) {
      throw new Response(undefined, { status: 404, statusText: "Environment not found" });
    }

    const timeZone = safeTimeZone(await getTimezonePreference(request));
    const url = new URL(request.url);

    if (url.searchParams.has("day")) {
      const day = DaySchema.safeParse(url.searchParams.get("day"));
      if (!day.success) {
        throw new Response(undefined, { status: 400, statusText: "Invalid day" });
      }
      return json<DeploymentDayResponse>({
        day: day.data,
        deployments: await deploymentsOnDay($replica, sqlDatabaseSchema, {
          environmentId: environment.id,
          day: day.data,
          timeZone,
        }),
      });
    }

    const activity = await deploymentActivityByDay($replica, sqlDatabaseSchema, {
      environmentId: environment.id,
      timeZone,
    });
    return json<DeploymentActivityResponse>({ timeZone, ...activity });
  }
);

/** Saves whether the deployments list shows the grid (`show=true|false`), for every environment. */
export async function action({ request }: ActionFunctionArgs) {
  await requireUserId(request);
  const show = z.enum(["true", "false"]).safeParse((await request.formData()).get("show"));
  if (!show.success) {
    return json({ success: false }, { status: 400 });
  }

  const session = await setDeployActivityPreference(show.data === "true", request);
  return json(
    { success: true },
    { headers: { "Set-Cookie": await uiPreferencesStorage.commitSession(session) } }
  );
}
