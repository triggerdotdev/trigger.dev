import type { LoaderFunctionArgs } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import type { ShouldRevalidateFunction } from "@remix-run/react";
import { useEffect, useRef } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { ShieldCheckIcon } from "lucide-react";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { FormTitle } from "~/components/primitives/FormTitle";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { TextLink } from "~/components/primitives/TextLink";
import { prisma } from "~/db.server";
import { isMfaSetupRequired } from "~/services/mfa/mfaRequirement.server";
import { requireUser } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";
import { logoutPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { MfaQrCodeForm, MfaRecoveryCodesForm } from "../resources.account.mfa.setup/MfaSetupDialog";
import { useMfaSetup } from "../resources.account.mfa.setup/useMfaSetup";

export const meta = pageMeta("Set up multi-factor authentication");

export async function loader({ request }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const redirectTo = sanitizeRedirectPath(new URL(request.url).searchParams.get("redirectTo"));

  if (user.mfaEnabledAt || !(await isMfaSetupRequired(user.id))) throw redirect(redirectTo);

  const organization = await prisma.organization.findFirst({
    where: { mfaRequired: true, deletedAt: null, members: { some: { userId: user.id } } },
    select: { title: true },
  });

  return typedjson({ redirectTo, organizationTitle: organization?.title });
}

// Turning MFA on would make the loader redirect away before the recovery codes are shown.
export const shouldRevalidate: ShouldRevalidateFunction = () => false;

export default function Page() {
  const { redirectTo, organizationTitle } = useTypedLoaderData<typeof loader>();
  const { state, actions } = useMfaSetup(false);

  // A fresh secret per page view; the ref stops a double effect from minting two.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    actions.enableMfa();
  }, [actions]);

  const recoveryCodes = state.recoveryCodes?.length ? state.recoveryCodes : undefined;

  return (
    <AppContainer className="bg-background-deep">
      <BackgroundWrapper>
        <MainCenteredContainer
          variant="centered"
          className="max-w-116 rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg"
        >
          <FormTitle
            LeadingIcon={<ShieldCheckIcon className="size-7 text-indigo-500" />}
            title={recoveryCodes ? "Recovery codes" : "Set up multi-factor authentication"}
            description={
              recoveryCodes
                ? undefined
                : `${organizationTitle ?? "Your organization"} requires multi-factor authentication. Set it up to keep using Trigger.dev.`
            }
            className="mb-0"
          />

          {recoveryCodes ? (
            <MfaRecoveryCodesForm
              recoveryCodes={recoveryCodes}
              onContinue={() => actions.saveRecoveryCodes(redirectTo)}
            />
          ) : state.setupData ? (
            <MfaQrCodeForm
              setupData={state.setupData}
              error={state.error}
              isSubmitting={state.isSubmitting}
              onValidate={actions.validateTotp}
            />
          ) : (
            <div className="flex justify-center py-16">
              <Spinner className="size-6" />
            </div>
          )}

          {recoveryCodes ? null : (
            <Paragraph variant="small" className="pt-3 text-center">
              Not the right account? <TextLink to={logoutPath()}>Log out</TextLink>
            </Paragraph>
          )}
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
