import { type MetaFunction } from "@remix-run/react";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Header2 } from "~/components/primitives/Headers";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { MfaSetup } from "../resources.account.mfa.setup/route";
import { SessionDurationSetting } from "../resources.account.session-duration/SessionDurationSetting";
import { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { requireUser } from "~/services/session.server";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { prisma } from "~/db.server";
import {
  getAllowedSessionOptions,
  getOrganizationSessionCap,
  DEFAULT_SESSION_DURATION_SECONDS,
} from "~/services/sessionDuration.server";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Security | Trigger.dev`,
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const [userRecord, orgCapSeconds] = await Promise.all([
    prisma.user.findUnique({
      where: { id: user.id },
      select: { sessionDuration: true },
    }),
    getOrganizationSessionCap(user.id),
  ]);

  const sessionDuration = userRecord?.sessionDuration ?? DEFAULT_SESSION_DURATION_SECONDS;
  const sessionDurationOptions = getAllowedSessionOptions(orgCapSeconds, sessionDuration);

  return typedjson({
    user,
    sessionDuration,
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
        <MainHorizontallyCenteredContainer className="grid place-items-center overflow-visible">
          <div className="mb-3 w-full border-b border-grid-dimmed pb-3">
            <Header2>Security</Header2>
          </div>
          <MfaSetup isEnabled={!!user.mfaEnabledAt} />
          <div className="mt-6 w-full border-t border-grid-dimmed pt-6">
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
