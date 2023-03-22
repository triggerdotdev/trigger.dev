import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import invariant from "tiny-invariant";
import { Container } from "~/components/layout/Container";
import { Header } from "~/components/layout/Header";
import {
  SideMenuContainer,
  WorkflowsSideMenu,
} from "~/components/navigation/SideMenu";
import { RuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import {
  CurrentEventRule,
  WorkflowSlugPresenter,
} from "~/presenters/workflowSlugPresenter.server";
import { requireUser } from "~/services/session.server";
import { useMatchesData } from "~/utils";

export const loader = async ({ request, params }: LoaderArgs) => {
  const user = await requireUser(request);
  const { organizationSlug, workflowSlug } = params;
  invariant(organizationSlug, "organizationSlug not found");
  invariant(workflowSlug, "workflowSlug not found");

  const presenter = new WorkflowSlugPresenter();

  return typedjson(
    await presenter.data({
      user,
      organizationSlug,
      workflowSlug,
    })
  );
};

export default function WorkflowSlugLayout() {
  return (
    <SideMenuContainer>
      <WorkflowsSideMenu />
      <div className="relative grid w-full grid-rows-[3.6rem_auto] overflow-y-auto bg-slate-850">
        <Header context="workflows" />
        <Container>
          <Outlet />
        </Container>
      </div>
    </SideMenuContainer>
  );
}

export function useCurrentEnvironment(): RuntimeEnvironment {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug"
  );

  if (!routeMatch) {
    throw new Error(
      "useCurrentEnvironment must be used within a $workflowSlug route"
    );
  }

  return routeMatch.data.currentEnvironment;
}

export function useCurrentEventRule(): CurrentEventRule | undefined {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug"
  );

  if (!routeMatch) {
    return;
  }

  return routeMatch.data.currentEventRule;
}

export function useOptionalCurrentEnvironment():
  | RuntimeEnvironment
  | undefined {
  const routeMatch = useMatchesData(
    "routes/__app/orgs/$organizationSlug/__org/workflows/$workflowSlug"
  );

  if (!routeMatch) {
    return;
  }

  return routeMatch.data.currentEnvironment;
}
