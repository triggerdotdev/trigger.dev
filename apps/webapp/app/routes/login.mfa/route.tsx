import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
  Session,
} from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import React, { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/primitives/InputOTP";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { authenticator } from "~/services/auth.server";
import { commitSession, getUserSession, sessionStorage } from "~/services/sessionStorage.server";
import { getSession as getMessageSession } from "~/models/message.server";
import { MultiFactorAuthenticationService } from "~/services/mfa/multiFactorAuthentication.server";
import { redirectWithErrorMessage, redirectBackWithErrorMessage } from "~/models/message.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { checkMfaRateLimit, MfaRateLimitError } from "~/services/mfa/mfaRateLimiter.server";

export const meta: MetaFunction = ({ matches }) => {
  const parentMeta = matches
    .flatMap((match) => match.meta ?? [])
    .filter((meta) => {
      if ("title" in meta) return false;
      if ("name" in meta && meta.name === "viewport") return false;
      return true;
    });

  return [
    ...parentMeta,
    { title: `Multi-factor authentication` },
    {
      name: "viewport",
      content: "width=device-width,initial-scale=1",
    },
  ];
};

export async function loader({ request }: LoaderFunctionArgs) {
  // Check if user is already fully authenticated
  await authenticator.isAuthenticated(request, {
    successRedirect: "/",
  });

  const session = await getUserSession(request);

  // Check if there's a pending MFA user ID
  const pendingUserId = session.get("pending-mfa-user-id");
  if (!pendingUserId) {
    // No pending MFA, redirect to login
    return redirect("/login");
  }

  // Get flash message for MFA errors
  const messageSession = await getMessageSession(request.headers.get("cookie"));
  const toastMessage = messageSession.get("toastMessage");

  let mfaError: string | undefined;
  if (toastMessage?.type === "error") {
    mfaError = toastMessage.message;
  }

  return typedjson(
    {
      mfaError,
    },
    {
      headers: { "Set-Cookie": await commitSession(session) },
    }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  try {
    const session = await getUserSession(request);
    const pendingUserId = session.get("pending-mfa-user-id");

    if (!pendingUserId) {
      return redirect("/login");
    }

    const payload = Object.fromEntries(await request.formData());

    const { action } = z
      .object({
        action: z.enum(["verify-recovery", "verify-mfa"]),
      })
      .parse(payload);

    const mfaService = new MultiFactorAuthenticationService();

    if (action === "verify-recovery") {
      const recoveryCode = payload.recoveryCode as string;

      if (!recoveryCode) {
        return redirectBackWithErrorMessage(request, "Recovery code is required");
      }

      // Rate limit MFA verification attempts
      await checkMfaRateLimit(pendingUserId);

      const result = await mfaService.verifyRecoveryCodeForLogin(pendingUserId, recoveryCode);

      if (!result.success) {
        return redirectBackWithErrorMessage(request, result.error || "Invalid authentication code");
      }
      // Recovery code verified - complete the login
      return await completeLogin(request, session, pendingUserId);
    } else if (action === "verify-mfa") {
      const mfaCode = payload.mfaCode as string;

      if (!mfaCode || mfaCode.length !== 6) {
        return redirectBackWithErrorMessage(request, "Valid 6-digit code is required");
      }

      // Rate limit MFA verification attempts
      await checkMfaRateLimit(pendingUserId);

      const result = await mfaService.verifyTotpForLogin(pendingUserId, mfaCode);

      if (!result.success) {
        return redirectBackWithErrorMessage(request, result.error || "Invalid authentication code");
      }

      // TOTP code verified - complete the login
      return await completeLogin(request, session, pendingUserId);
    }

    return redirect("/login");
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return redirectWithErrorMessage("/login", request, error.message);
    }

    if (error instanceof MfaRateLimitError) {
      return redirectBackWithErrorMessage(request, error.message);
    }

    throw error;
  }
}

async function completeLogin(request: Request, session: Session, userId: string) {
  // Create a new authenticated session
  const authSession = await sessionStorage.getSession(request.headers.get("Cookie"));
  authSession.set(authenticator.sessionKey, { userId });

  // Get the redirect URL and clean up pending MFA data
  const redirectTo = session.get("pending-mfa-redirect-to") ?? "/";
  session.unset("pending-mfa-user-id");
  session.unset("pending-mfa-redirect-to");

  return redirect(redirectTo, {
    headers: {
      "Set-Cookie": await sessionStorage.commitSession(authSession),
    },
  });
}

export default function LoginMfaPage() {
  const data = useTypedLoaderData<typeof loader>();
  const rawMfaError = "mfaError" in data ? data.mfaError : undefined;
  const navigate = useNavigation();
  const [showRecoveryCode, setShowRecoveryCode] = useState(false);
  const [mfaCode, setMfaCode] = useState("");
  const [hideError, setHideError] = useState(false);

  // Clear the MFA code when form submission completes (success or failure)
  const prevNavigationState = React.useRef(navigate.state);
  React.useEffect(() => {
    if (prevNavigationState.current === "submitting" && navigate.state === "idle") {
      setMfaCode("");
    }
    prevNavigationState.current = navigate.state;
  }, [navigate.state]);

  // Reset hideError when a new error appears
  React.useEffect(() => {
    if (rawMfaError) {
      setHideError(false);
    }
  }, [rawMfaError]);

  // Clear error and MFA code when switching between modes
  const handleShowRecoveryCode = (show: boolean) => {
    setShowRecoveryCode(show);
    setHideError(true);
    if (!show) {
      setMfaCode("");
    }
  };

  // Only show error if not explicitly hidden and we have an error
  const mfaError = hideError ? undefined : rawMfaError;

  const isLoading =
    (navigate.state === "loading" || navigate.state === "submitting") &&
    navigate.formAction !== undefined;

  return (
    <LoginPageLayout>
      <Form method="post">
        <div className="flex max-w-xs flex-col items-center justify-center">
          <Header1 className="pb-4 text-center font-semibold leading-7 sm:text-2xl md:text-3xl md:leading-8 lg:text-4xl lg:leading-9">
            Multi-factor authentication
          </Header1>
          {showRecoveryCode ? (
            <>
              <Paragraph className="mb-6 text-center">
                Enter one of your recovery codes to log in.
              </Paragraph>
              <Fieldset className="flex w-full flex-col items-center gap-y-2">
                <InputGroup>
                  <Input
                    type="password"
                    name="recoveryCode"
                    spellCheck={false}
                    placeholder="Enter recovery code"
                    variant="large"
                    required
                    autoFocus
                  />
                </InputGroup>

                <Button
                  name="action"
                  value="verify-recovery"
                  type="submit"
                  variant="primary/large"
                  disabled={isLoading}
                  fullWidth
                  data-action="verify recovery code"
                >
                  {isLoading ? <Spinner className="mr-2 size-5" color="white" /> : null}
                  {isLoading ? (
                    <span className="text-text-bright">Verifying…</span>
                  ) : (
                    <span className="text-text-bright">Verify</span>
                  )}
                </Button>
                {typeof mfaError === "string" && <FormError>{mfaError}</FormError>}
              </Fieldset>
              <Button
                type="button"
                onClick={() => handleShowRecoveryCode(false)}
                variant="minimal/small"
                data-action="use authenticator app"
                className="mt-4"
              >
                Use an authenticator app
              </Button>
            </>
          ) : (
            <>
              <Paragraph variant="base" className="mb-6 text-center">
                Open your authenticator app to get your code. Then enter it below.
              </Paragraph>
              <Fieldset className="flex w-full flex-col items-center gap-y-2">
                <InputOTP
                  maxLength={6}
                  value={mfaCode}
                  onChange={(value) => setMfaCode(value)}
                  variant="large"
                  fullWidth
                >
                  <InputOTPGroup variant="large" fullWidth>
                    <InputOTPSlot index={0} autoFocus variant="large" fullWidth />
                    <InputOTPSlot index={1} variant="large" fullWidth />
                    <InputOTPSlot index={2} variant="large" fullWidth />
                    <InputOTPSlot index={3} variant="large" fullWidth />
                    <InputOTPSlot index={4} variant="large" fullWidth />
                    <InputOTPSlot index={5} variant="large" fullWidth />
                  </InputOTPGroup>
                </InputOTP>
                <input type="hidden" name="mfaCode" value={mfaCode} />

                <Button
                  name="action"
                  value="verify-mfa"
                  type="submit"
                  variant="primary/large"
                  disabled={isLoading || mfaCode.length !== 6}
                  fullWidth
                  data-action="verify mfa code"
                >
                  {isLoading ? <Spinner className="mr-2 size-5" color="white" /> : null}
                  {isLoading ? (
                    <span className="text-text-bright">Verifying…</span>
                  ) : (
                    <span className="text-text-bright">Verify</span>
                  )}
                </Button>
                {typeof mfaError === "string" && <FormError>{mfaError}</FormError>}
              </Fieldset>
              <Button
                type="button"
                onClick={() => handleShowRecoveryCode(true)}
                variant="minimal/small"
                data-action="use recovery code"
                className="mt-4"
              >
                Use a recovery code
              </Button>
            </>
          )}
        </div>
      </Form>
    </LoginPageLayout>
  );
}
