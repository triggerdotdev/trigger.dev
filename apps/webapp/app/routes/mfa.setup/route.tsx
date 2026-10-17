import { LockClosedIcon } from "@heroicons/react/20/solid";
import { redirect, type LoaderFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { DownloadIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { BackgroundWrapper } from "~/components/BackgroundWrapper";
import { AppContainer, MainCenteredContainer } from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CopyButton } from "~/components/primitives/CopyButton";
import { FormError } from "~/components/primitives/FormError";
import { FormTitle } from "~/components/primitives/FormTitle";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/primitives/InputOTP";
import { Paragraph } from "~/components/primitives/Paragraph";
import { requireUser } from "~/services/session.server";
import { sanitizeRedirectPath } from "~/utils";
import { rootPath } from "~/utils/pathBuilder";
import { pageMeta } from "~/utils/pageTitle";
import { useMfaSetup } from "../resources.account.mfa.setup/useMfaSetup";

export const meta = pageMeta("Set up multi-factor authentication");

/**
 * Forced MFA enrollment.
 *
 * Reached when the instance sets `MFA_REQUIRED` and a signed-in user has not
 * enrolled a second factor: `requireUser`, the root loader and the `_app`
 * layout all redirect here for every other dashboard request, so this is the
 * one place a MFA-less session can land.
 *
 * Unlike `/account/security` (where enrollment is one option among several),
 * the flow here is inline and has no way out — the authenticator QR, the code
 * entry and the recovery codes are the whole page.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  // Not gated: `/mfa/setup` is on the MFA exemption list, so this cannot loop.
  const user = await requireUser(request);
  const url = new URL(request.url);

  // `redirectTo` is user-influenced (it round-trips through the query string),
  // so it goes through the same sanitizer the login flow uses.
  const redirectTo = sanitizeRedirectPath(url.searchParams.get("redirectTo"), rootPath());

  // Already enrolled — they set it up in another tab, or the flag was enabled
  // after they'd finished. Send them on to where they were going.
  if (user.mfaEnabledAt) {
    throw redirect(redirectTo);
  }

  return typedjson({ redirectTo });
}

export default function Page() {
  const { redirectTo } = useTypedLoaderData<typeof loader>();

  return <ForcedMfaEnrollment redirectTo={redirectTo} />;
}

function ForcedMfaEnrollment({ redirectTo }: { redirectTo: string }) {
  const { state, actions } = useMfaSetup(false, redirectTo);
  const [totpCode, setTotpCode] = useState("");

  const isEnrolled = state.phase === "showing-recovery" && !!state.recoveryCodes;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (totpCode.length !== 6) return;
    actions.validateTotp(totpCode);
    setTotpCode("");
  };

  const downloadRecoveryCodes = () => {
    if (!state.recoveryCodes) return;

    const blob = new Blob([state.recoveryCodes.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trigger-dev-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <AppContainer className="bg-background-deep">
      <BackgroundWrapper>
        <MainCenteredContainer
          variant="onboarding"
          className="max-w-130 rounded-lg border border-grid-bright bg-background-dimmed p-6 shadow-lg"
        >
          <FormTitle
            title="Multi-factor authentication is required"
            LeadingIcon={<LockClosedIcon className="size-7 text-amber-400" />}
            description="Your organization requires a second factor before you can use the dashboard. Set one up now with your authenticator app."
          />

          {isEnrolled ? (
            <RecoveryCodes
              codes={state.recoveryCodes ?? []}
              onDownload={downloadRecoveryCodes}
              onContinue={actions.saveRecoveryCodes}
              isSubmitting={state.isSubmitting}
            />
          ) : state.setupData ? (
            <AuthenticatorSetup
              otpAuthUrl={state.setupData.otpAuthUrl}
              secret={state.setupData.secret}
              totpCode={totpCode}
              onTotpCodeChange={setTotpCode}
              onSubmit={handleSubmit}
              error={state.error}
              isSubmitting={state.isSubmitting}
            />
          ) : (
            <StartEnrollment
              onStart={actions.enableMfa}
              isSubmitting={state.isSubmitting}
              error={state.error}
            />
          )}
        </MainCenteredContainer>
      </BackgroundWrapper>
    </AppContainer>
  );
}

function StartEnrollment({
  onStart,
  isSubmitting,
  error,
}: {
  onStart: () => void;
  isSubmitting: boolean;
  error?: string;
}) {
  return (
    <div className="flex flex-col gap-4 pt-2">
      <Paragraph spacing>
        You'll scan a QR code with an app like Google Authenticator, 1Password or Authy, then enter
        the 6-digit code it generates to prove it's set up correctly.
      </Paragraph>
      <div className="flex flex-col gap-2">
        <Button type="button" variant="primary/medium" onClick={onStart} isLoading={isSubmitting}>
          Set up authenticator app
        </Button>
        {error && <FormError>{error}</FormError>}
      </div>
    </div>
  );
}

function AuthenticatorSetup({
  otpAuthUrl,
  secret,
  totpCode,
  onTotpCodeChange,
  onSubmit,
  error,
  isSubmitting,
}: {
  otpAuthUrl: string;
  secret: string;
  totpCode: string;
  onTotpCodeChange: (code: string) => void;
  onSubmit: (e: React.FormEvent) => void;
  error?: string;
  isSubmitting: boolean;
}) {
  return (
    <Form method="post" onSubmit={onSubmit}>
      <div className="flex flex-col gap-4 pt-3">
        <Paragraph>
          Scan the QR code below with your authenticator app, then enter the 6-digit code it
          generates. You can also copy the secret into your app manually.
        </Paragraph>

        <div className="flex flex-col items-center justify-center gap-y-4 rounded border border-grid-dimmed bg-background-bright py-4">
          <div className="overflow-hidden rounded-lg border border-grid-dimmed">
            <QRCodeSVG value={otpAuthUrl} size={260} marginSize={3} />
          </div>
          <CopyableText value={secret} className="font-mono text-sm tracking-wide" />
        </div>

        <div className="flex items-center justify-center">
          <InputOTP
            maxLength={6}
            value={totpCode}
            onChange={onTotpCodeChange}
            variant="large"
            name="totpCode"
          >
            <InputOTPGroup variant="large">
              <InputOTPSlot index={0} variant="large" autoFocus />
              <InputOTPSlot index={1} variant="large" />
              <InputOTPSlot index={2} variant="large" />
              <InputOTPSlot index={3} variant="large" />
              <InputOTPSlot index={4} variant="large" />
              <InputOTPSlot index={5} variant="large" />
            </InputOTPGroup>
          </InputOTP>
        </div>

        {error && <FormError>{error}</FormError>}

        <Button
          type="submit"
          variant="primary/medium"
          disabled={totpCode.length !== 6 || isSubmitting}
          isLoading={isSubmitting}
          shortcut={{ key: "Enter" }}
          hideShortcutKey
        >
          Confirm
        </Button>
      </div>
    </Form>
  );
}

function RecoveryCodes({
  codes,
  onDownload,
  onContinue,
  isSubmitting,
}: {
  codes: string[];
  onDownload: () => void;
  onContinue: () => void;
  isSubmitting: boolean;
}) {
  return (
    <div className="flex flex-col gap-3 pt-3">
      <Paragraph spacing>
        Multi-factor authentication is on. Copy and store these recovery codes somewhere safe —
        they're the only way back in if you lose your device. Each code works once.
      </Paragraph>

      <div className="flex flex-col rounded border border-grid-dimmed bg-background-bright">
        <div className="grid grid-cols-3 gap-x-2 gap-y-4 px-3 py-6">
          {codes.map((code, index) => (
            <span key={index} className="text-center font-mono text-xs text-text-bright">
              {code}
            </span>
          ))}
        </div>
        <div className="flex items-center justify-end border-t border-grid-bright px-1.5 py-1.5">
          <Button
            type="button"
            variant="minimal/medium"
            onClick={onDownload}
            LeadingIcon={DownloadIcon}
          >
            Download
          </Button>
          <CopyButton value={codes.join("\n")} buttonVariant="minimal" showTooltip={false}>
            Copy
          </CopyButton>
        </div>
      </div>

      <Button
        type="button"
        variant="primary/medium"
        onClick={onContinue}
        isLoading={isSubmitting}
        shortcut={{ key: "Enter" }}
        hideShortcutKey
        autoFocus
      >
        Continue
      </Button>
    </div>
  );
}
