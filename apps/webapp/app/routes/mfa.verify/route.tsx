import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/node";
import { json, redirect } from "@remix-run/node";
import { Form, useActionData, useNavigate, useNavigation, useSubmit } from "@remix-run/react";
import { ShieldCheckIcon } from "lucide-react";
import { REGEXP_ONLY_DIGITS } from "input-otp";
import React, { useState } from "react";
import { z } from "zod";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/primitives/InputOTP";
import { prisma } from "~/db.server";
import { checkMfaRateLimit, MfaRateLimitError } from "~/services/mfa/mfaRateLimiterGlobal.server";
import { MFA_VERIFIED_AT_SESSION_KEY } from "~/services/mfa/mfaPolicy.server";
import { MultiFactorAuthenticationService } from "~/services/mfa/multiFactorAuthentication.server";
import { requireUserId } from "~/services/session.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import { sanitizeRedirectPath } from "~/utils";
import { accountSecurityPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";

export const meta = pageMeta("Confirm it's you");

function redirectToFrom(request: Request) {
  return sanitizeRedirectPath(new URL(request.url).searchParams.get("redirectTo"));
}

async function requireMfaUser(request: Request) {
  const userId = await requireUserId(request);
  const user = await prisma.user.findFirst({
    where: { id: userId },
    select: { mfaEnabledAt: true },
  });
  if (!user?.mfaEnabledAt) throw redirect(accountSecurityPath());
  return userId;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMfaUser(request);
  return json({ redirectTo: redirectToFrom(request) });
}

const ActionSchema = z.object({ mfaCode: z.string().regex(/^\d{6}$/) });

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireMfaUser(request);

  const parsed = ActionSchema.safeParse(Object.fromEntries(await request.formData()));
  if (!parsed.success) {
    return json({ error: "Enter the 6-digit code from your authenticator app." }, { status: 400 });
  }

  const rateLimited = await checkMfaRateLimit(userId).then(
    () => false,
    (error) => {
      if (error instanceof MfaRateLimitError) return true;
      throw error;
    }
  );
  if (rateLimited) {
    return json({ error: "Too many attempts. Please try again later." }, { status: 429 });
  }

  const result = await new MultiFactorAuthenticationService().verifyTotpForLogin(
    userId,
    parsed.data.mfaCode
  );
  if (!result.success) {
    return json({ error: result.error ?? "Invalid authentication code" }, { status: 400 });
  }

  const session = await getUserSession(request);
  session.set(MFA_VERIFIED_AT_SESSION_KEY, Date.now());
  return redirect(redirectToFrom(request), {
    headers: { "Set-Cookie": await commitSession(session) },
  });
}

export default function MfaVerifyPage() {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const navigate = useNavigate();
  const submit = useSubmit();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [mfaCode, setMfaCode] = useState("");
  const isSubmitting = navigation.state !== "idle";

  // A failed attempt clears the code so the next one can be typed straight away.
  React.useEffect(() => {
    if (navigation.state !== "idle" || !actionData?.error) return;
    // oxlint-disable-next-line react/set-state-in-effect -- Resets the input after a failed submission.
    setMfaCode("");
    inputRef.current?.focus();
  }, [navigation.state, actionData]);

  const submitCode = (code: string) => {
    if (isSubmitting) return;
    submit({ mfaCode: code }, { method: "post", replace: true });
  };

  // Back to the page the member was on; a direct visit has no in-app history to go back to.
  const cancel = () => {
    if ((window.history.state?.idx ?? 0) > 0) navigate(-1);
    else navigate("/");
  };

  return (
    <AppContainer className="bg-background-deep">
      <BackgroundWrapper>
        <MainCenteredContainer
          variant="centered"
          className="max-w-104 rounded-lg border border-grid-bright bg-background-dimmed p-5 shadow-lg"
        >
          <FormTitle
            LeadingIcon={<ShieldCheckIcon className="size-7 text-indigo-500" />}
            title="Confirm it's you"
            description="Your organization asks for a code from your authenticator app before you continue."
          />
          <Form method="post" replace>
            <Fieldset className="flex w-full flex-col items-center gap-y-2">
              <InputOTP
                ref={inputRef}
                maxLength={6}
                value={mfaCode}
                onChange={setMfaCode}
                onComplete={submitCode}
                pattern={REGEXP_ONLY_DIGITS}
                pasteTransformer={(pasted) => pasted.replace(/\D/g, "")}
                autoComplete="one-time-code"
                autoFocus
                variant="large"
                fullWidth
              >
                <InputOTPGroup variant="large" fullWidth>
                  {[0, 1, 2, 3, 4, 5].map((index) => (
                    <InputOTPSlot key={index} index={index} variant="large" fullWidth />
                  ))}
                </InputOTPGroup>
              </InputOTP>
              <input type="hidden" name="mfaCode" value={mfaCode} />
              {actionData?.error ? <FormError>{actionData.error}</FormError> : null}
            </Fieldset>
            <FormButtons
              className="mt-4"
              confirmButton={
                <Button
                  type="submit"
                  variant="primary/small"
                  disabled={isSubmitting || mfaCode.length !== 6}
                  isLoading={isSubmitting}
                  data-action="verify mfa step-up"
                >
                  Verify
                </Button>
              }
              cancelButton={
                <Button type="button" variant="secondary/small" onClick={cancel}>
                  Cancel
                </Button>
              }
            />
          </Form>
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}
