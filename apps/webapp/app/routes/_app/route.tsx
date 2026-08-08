import { Outlet } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { redirect, typedjson } from "remix-typedjson";
import { AskAIRoot } from "~/components/AskAI";
import { RouteErrorDisplay } from "~/components/ErrorDisplay";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUser } from "~/services/session.server";
import { tenantContext } from "~/services/tenantContext.server";
import { confirmBasicDetailsPath } from "~/utils/pathBuilder";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await requireUser(request);
  tenantContext.enrich({ userId: user.id });

  //you have to confirm basic details before you can do anything
  if (!user.confirmedBasicDetails) {
    return redirect(confirmBasicDetailsPath());
  }

  return typedjson(
    {},
    {
      headers: { "Set-Cookie": await commitSession(await clearRedirectTo(request)) },
    }
  );
};

export default function App() {
  // Above every signed-in page, and outside the `Outlet`: ⌘I fires from org-level pages too,
  // where the agent's provider is not mounted, and the Kapa dialog has to outlive navigation.
  return (
    <AskAIRoot>
      {() => (
        <AppContainer>
          <Outlet />
        </AppContainer>
      )}
    </AskAIRoot>
  );
}

export function ErrorBoundary() {
  return (
    <>
      <AppContainer>
        <MainCenteredContainer>
          <RouteErrorDisplay />
        </MainCenteredContainer>
      </AppContainer>
    </>
  );
}
