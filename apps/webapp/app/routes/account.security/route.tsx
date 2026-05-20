import { type MetaFunction } from "@remix-run/react";
import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { $replica } from "~/db.server";
import { requireUser } from "~/services/session.server";
import {
  getAllowedSessionOptions,
  getEffectiveSessionDuration,
} from "~/services/sessionDuration.server";
import { MfaSetup } from "../resources.account.mfa.setup/route";
import { SessionDurationSetting } from "../resources.account.session-duration/SessionDurationSetting";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Security | Trigger.dev`,
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { durationSeconds, orgCapSeconds } = await getEffectiveSessionDuration(user.id, $replica);
  const sessionDurationOptions = getAllowedSessionOptions(orgCapSeconds, durationSeconds);

  return typedjson({
    user,
    sessionDuration: durationSeconds,
    sessionDurationOptions,
    orgCapSeconds,
  });
}

export default function Page() {
  const { user, sessionDuration, sessionDurationOptions, orgCapSeconds } =
    useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Security" />
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer className="max-w-[37.5rem] overflow-visible">
          <div className="w-full border-b border-grid-dimmed pb-3">
            <Header2>Security</Header2>
          </div>
          <div className="w-full border-b border-grid-dimmed py-4">
            <MfaSetup isEnabled={!!user.mfaEnabledAt} />
          </div>
          <div className="w-full border-b border-grid-dimmed py-4">
            <SessionDurationSetting
              currentValue={sessionDuration}
              options={sessionDurationOptions}
              orgCapSeconds={orgCapSeconds}
            />
          </div>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
