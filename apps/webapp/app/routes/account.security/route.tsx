import type { LoaderFunctionArgs } from "@remix-run/server-runtime";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Callout } from "~/components/primitives/Callout";
import { Header2 } from "~/components/primitives/Headers";
import { TextLink } from "~/components/primitives/TextLink";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { $replica } from "~/db.server";
import { isMfaRequiredByOrganization } from "~/services/mfa/mfaRequirement.server";
import { requireUser } from "~/services/session.server";
import {
  getAllowedSessionOptions,
  getEffectiveSessionDuration,
} from "~/services/sessionDuration.server";
import { MfaSetup } from "../resources.account.mfa.setup/route";
import { SessionDurationSetting } from "../resources.account.session-duration/SessionDurationSetting";
import { pageMeta } from "~/utils/pageTitle";
import { logoutPath } from "~/utils/pathBuilder";

export const meta = pageMeta("Security");

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);

  const { durationSeconds, orgCapSeconds } = await getEffectiveSessionDuration(user.id, $replica);
  const sessionDurationOptions = getAllowedSessionOptions(orgCapSeconds, durationSeconds);
  const mfaRequired = await isMfaRequiredByOrganization(user.id, $replica);

  return typedjson({
    user,
    sessionDuration: durationSeconds,
    sessionDurationOptions,
    orgCapSeconds,
    mfaRequired,
  });
}

export default function Page() {
  const { user, sessionDuration, sessionDurationOptions, orgCapSeconds, mfaRequired } =
    useTypedLoaderData<typeof loader>();

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Security" />
      </NavBar>

      <PageBody>
        <MainHorizontallyCenteredContainer className="max-w-150 overflow-visible">
          <div className="w-full border-b border-grid-dimmed pb-3">
            <Header2>Security</Header2>
          </div>
          {mfaRequired && !user.mfaEnabledAt ? (
            <Callout variant="warning" className="mt-4">
              Your organization requires multi-factor authentication. Turn it on below to keep using
              Trigger.dev, or <TextLink to={logoutPath()}>log out</TextLink>.
            </Callout>
          ) : null}
          <div className="w-full border-b border-grid-dimmed py-4">
            <MfaSetup isEnabled={!!user.mfaEnabledAt} isRequired={mfaRequired} />
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
