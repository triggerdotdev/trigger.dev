import { type MetaFunction } from "@remix-run/react";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { MfaSetup } from "../resources.account.mfa.setup/route";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { requireUser } from "~/services/session.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Security | Trigger.dev`,
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  return typedjson({
    user,
  });
}

export default function Page() {
  const { user } = useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Security" />
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer className="grid place-items-center overflow-visible">
          <div className="mb-3 w-full border-b border-grid-dimmed pb-3">
            <Header2>Security</Header2>
          </div>
          <MfaSetup isEnabled={!!user.mfaEnabledAt} />
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
