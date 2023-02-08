import { Outlet } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { Footer } from "~/components/layout/Footer";
import { AppBody, AppLayout } from "~/components/layout/AppLayout";
import { getOrganizations } from "~/models/organization.server";
import { clearRedirectTo, commitSession } from "~/services/redirectTo.server";
import { requireUserId } from "~/services/session.server";
import { Header } from "~/components/layout/Header";
import { NoMobileOverlay } from "~/components/NoMobileOverlay";
import { IntercomProvider, useIntercom } from "react-use-intercom";
import { useEffect } from "react";
import { getImpersonationId } from "~/services/impersonation.server";

export const loader = async ({ request }: LoaderArgs) => {
  const userId = await requireUserId(request);
  const organizations = await getOrganizations({ userId });
  const impersonationId = await getImpersonationId(request);

  return typedjson(
    {
      organizations,
      impersonationId,
    },
    {
      headers: {
        "Set-Cookie": await commitSession(await clearRedirectTo(request)),
      },
    }
  );
};

const INTERCOM_APP_ID = "pfbctmiv";

export default function App() {
  const { impersonationId } = useTypedLoaderData<typeof loader>();

  return (
    <IntercomProvider appId={INTERCOM_APP_ID}>
      <AppLayout impersonationId={impersonationId}>
        <NoMobileOverlay />
        <Header />
        <AppBody>
          <IntercomSurvey />
          <Outlet />
        </AppBody>
        <Footer />
      </AppLayout>
    </IntercomProvider>
  );
}

function IntercomSurvey() {
  const { boot, shutdown, hide, show, update } = useIntercom();

  useEffect(() => {
    boot({});
    return () => shutdown();
  }, []);

  return <></>;
}
