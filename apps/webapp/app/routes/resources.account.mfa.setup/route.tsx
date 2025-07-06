import { Form } from "@remix-run/react";
import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { DownloadIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import React, { useState, useEffect } from "react";
import { redirect, typedjson, useTypedFetcher } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { CopyButton } from "~/components/primitives/CopyButton";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/primitives/InputOTP";
import { Label } from "~/components/primitives/Label";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { Switch } from "~/components/primitives/Switch";
import {
  redirectWithErrorMessage,
  redirectWithSuccessMessage,
  typedJsonWithErrorMessage,
  typedJsonWithSuccessMessage,
} from "~/models/message.server";
import { MultiFactorAuthenticationService } from "~/services/mfa/multiFactorAuthentication.server";
import { requireUserId } from "~/services/session.server";

const formSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("enable-mfa"),
  }),
  z.object({
    action: z.literal("disable-mfa"),
    totpCode: z.string().optional(),
    recoveryCode: z.string().optional(),
  }),
  z.object({
    action: z.literal("saved-recovery-codes"),
  }),
  z.object({
    action: z.literal("cancel-totp"),
  }),
  z.object({
    action: z.literal("validate-totp"),
    totpCode: z.string().length(6, "TOTP code must be 6 digits"),
  }),
]);

function validateForm(formData: FormData) {
  const formEntries = Object.fromEntries(formData.entries());

  const result = formSchema.safeParse(formEntries);

  if (!result.success) {
    return {
      valid: false as const,
      errors: result.error.flatten().fieldErrors,
    };
  }

  return {
    valid: true as const,
    data: result.data,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  const userId = await requireUserId(request);

  const formData = await request.formData();

  const submission = validateForm(formData);

  if (!submission.valid) {
    return typedjson({
      action: "invalid-form" as const,
      errors: submission.errors,
    });
  }

  const mfaSetupService = new MultiFactorAuthenticationService();

  switch (submission.data.action) {
    case "enable-mfa": {
      const result = await mfaSetupService.enableTotp(userId);

      return typedjson({
        action: "enable-mfa" as const,
        secret: result.secret,
        otpAuthUrl: result.otpAuthUrl,
      });
    }
    case "disable-mfa": {
      const result = await mfaSetupService.disableTotp(userId, {
        totpCode: submission.data.totpCode,
        recoveryCode: submission.data.recoveryCode,
      });

      if (result.success) {
        return typedJsonWithSuccessMessage(
          {
            action: "disable-mfa" as const,
            success: true as const,
          },
          request,
          "Successfully disabled MFA"
        );
      } else {
        return typedjson({
          action: "disable-mfa" as const,
          success: false as const,
          error: "Invalid code provided. Please try again.",
        });
      }
    }
    case "validate-totp": {
      const result = await mfaSetupService.validateTotpSetup(userId, submission.data.totpCode);

      if (result.success) {
        return typedjson({
          action: "validate-totp" as const,
          success: true as const,
          recoveryCodes: result.recoveryCodes,
        });
      } else {
        return typedjson({
          action: "validate-totp" as const,
          success: false as const,
          error: "Invalid code provided. Please try again.",
          otpAuthUrl: result.otpAuthUrl,
          secret: result.secret,
        });
      }
    }
    case "cancel-totp": {
      return typedjson({
        action: "cancel-totp" as const,
        success: true as const,
      });
    }
    case "saved-recovery-codes": {
      return redirectWithSuccessMessage("/account/security", request, "Successfully enabled MFA");
    }
  }
}

export function MfaSetup({ isEnabled }: { isEnabled: boolean }) {
  const fetcher = useTypedFetcher<typeof action>();
  const [showDisableDialog, setShowDisableDialog] = useState(false);

  const formAction = fetcher.formData?.get("action");

  const data = fetcher.data;

  // TODO: Remove this
  console.log("fetcher.state", fetcher.state);
  console.log("fetcher.formData", Object.fromEntries(fetcher.formData?.entries() ?? []));
  console.log("fetcher.data", fetcher.data);

  const isMfaEnabled =
    (fetcher.state === "submitting" && formAction === "enable-mfa") ||
    (data && data.action === "enable-mfa") ||
    (isEnabled && !(data?.action === "disable-mfa" && data.success)) ||
    (data && data.action === "validate-totp" && !data.success);

  const [totpCode, setTotpCode] = useState("");

  // Additional state for disable MFA functionality
  const [recoveryCode, setRecoveryCode] = useState("");
  const [showRecoveryCode, setShowRecoveryCode] = useState(false);
  const [mfaDisableError, setMfaDisableError] = useState<string | undefined>(undefined);

  const qrCodeValue = data && "otpAuthUrl" in data ? data.otpAuthUrl : undefined;
  const secretKey = data && "secret" in data ? data.secret : undefined;
  const recoveryCodes =
    data?.action === "validate-totp" && data.success ? data.recoveryCodes ?? [] : [];

  const showQrDialog =
    (data?.action === "enable-mfa" || (data?.action === "validate-totp" && !data.success)) &&
    typeof qrCodeValue === "string" &&
    typeof secretKey === "string";

  const showRecoveryDialog =
    data?.action === "validate-totp" && Array.isArray(recoveryCodes) && recoveryCodes.length > 0;

  const showInvalidTotpErrorMessage = data?.action === "validate-totp" && !data.success;

  const isDisabling = fetcher.state === "submitting" && formAction === "disable-mfa";

  // Set error from fetcher data
  useEffect(() => {
    if (data?.action === "disable-mfa" && !data.success && data.error) {
      setMfaDisableError(data.error);
    }
  }, [data]);

  // Clear TOTP code when form is submitted
  useEffect(() => {
    if (
      fetcher.state === "submitting" &&
      (formAction === "validate-totp" || formAction === "disable-mfa")
    ) {
      setTotpCode("");
    }
  }, [fetcher.state, formAction]);

  // Close disable dialog on successful disable
  const shouldCloseDisableDialog = data?.action === "disable-mfa" && data.success;

  useEffect(() => {
    if (shouldCloseDisableDialog) {
      setShowDisableDialog(false);
      setTotpCode("");
      setRecoveryCode("");
      setShowRecoveryCode(false);
    }
  }, [shouldCloseDisableDialog]);

  const handleSwitchChange = (checked: boolean) => {
    if (checked && !isMfaEnabled) {
      fetcher.submit(
        { action: "enable-mfa" },
        {
          method: "POST",
          action: `/resources/account/mfa/setup`,
        }
      );
    } else if (!checked && isMfaEnabled) {
      setShowDisableDialog(true);
    }
  };

  const handleQrConfirm = (e: React.FormEvent) => {
    e.preventDefault();

    fetcher.submit(
      { action: "validate-totp", totpCode },
      { method: "POST", action: `/resources/account/mfa/setup` }
    );

    setTotpCode("");
  };

  const handleQrCancel = () => {
    setTotpCode("");
    // Don't change the switch state when canceling

    fetcher.submit(
      { action: "cancel-totp" },
      { method: "POST", action: `/resources/account/mfa/setup` }
    );
  };

  const handleRecoveryComplete = (e: React.FormEvent) => {
    e.preventDefault();

    fetcher.submit(
      { action: "saved-recovery-codes" },
      { method: "POST", action: `/resources/account/mfa/setup` }
    );
  };

  const downloadRecoveryCodes = () => {
    const content = recoveryCodes.join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "trigger-dev-recovery-codes.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDisableCancel = () => {
    setShowDisableDialog(false);
    setTotpCode("");
    setRecoveryCode("");
    setShowRecoveryCode(false);
    setMfaDisableError(undefined);
  };

  const handleDisableMfa = (e: React.FormEvent) => {
    e.preventDefault();

    fetcher.submit(
      { action: "disable-mfa", totpCode, recoveryCode },
      { method: "POST", action: `/resources/account/mfa/setup` }
    );
  };

  const handleSwitchToRecoveryCode = () => {
    setShowRecoveryCode(true);
    setMfaDisableError(undefined);
  };

  const handleSwitchToTotpCode = () => {
    setShowRecoveryCode(false);
    setMfaDisableError(undefined);
  };

  return (
    <>
      <Form method="post" className="w-full">
        <InputGroup className="mb-4">
          <Label>Multi-factor authentication</Label>
          <Paragraph variant="small">
            Enable an extra layer of security by requiring a one-time code from your authenticator
            app (TOTP) each time you log in.
          </Paragraph>
        </InputGroup>
        <div className="flex items-center justify-between">
          <Switch
            id="mfa"
            variant="medium"
            label={isMfaEnabled ? "Enabled" : "Enable"}
            labelPosition="right"
            className="-ml-2 w-fit pr-3"
            checked={isMfaEnabled}
            onCheckedChange={handleSwitchChange}
          />
        </div>
      </Form>

      {/* QR Code Dialog */}
      <Dialog open={showQrDialog}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Enable authenticator app</DialogTitle>
          </DialogHeader>
          <Form method="post" onSubmit={handleQrConfirm}>
            <div className="flex flex-col gap-4 pt-3">
              <Paragraph>
                Scan the QR code below with your preferred authenticator app then enter the 6 digit
                code that the app generates. Alternatively, you can copy the secret below and paste
                it into your app.
              </Paragraph>

              <div className="flex flex-col items-center justify-center gap-y-4 rounded border border-grid-dimmed bg-background-bright py-4">
                <div className="overflow-hidden rounded-lg border border-grid-dimmed">
                  <QRCodeSVG value={qrCodeValue!} size={300} marginSize={3} />
                </div>
                <CopyableText value={secretKey!} className="font-mono text-base tracking-wide" />
              </div>

              <div className="mb-4 flex items-center justify-center">
                <InputOTP
                  maxLength={6}
                  value={totpCode}
                  onChange={(value) => setTotpCode(value)}
                  variant="large"
                  name="totpCode"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && totpCode.length === 6) {
                      handleQrConfirm(e);
                    }
                  }}
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
            </div>

            {showInvalidTotpErrorMessage && (
              <FormError>Invalid code provided. Please try again.</FormError>
            )}

            <DialogFooter>
              <Button type="button" variant="secondary/medium" onClick={handleQrCancel}>
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary/medium"
                disabled={totpCode.length !== 6}
                shortcut={{ key: "Enter" }}
                hideShortcutKey
              >
                Confirm
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Recovery Codes Dialog */}
      <Dialog open={showRecoveryDialog}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Recovery codes</DialogTitle>
          </DialogHeader>
          <Form method="post" onSubmit={handleRecoveryComplete}>
            <input type="hidden" name="action" value="save-recovery-codes" />
            <div className="flex flex-col gap-2 pb-0 pt-3">
              <Paragraph spacing>
                Copy and store these recovery codes carefully in case you lose your device.
              </Paragraph>

              <div className="flex flex-col gap-6 rounded border border-grid-dimmed bg-background-bright pt-6">
                <div className="grid grid-cols-3 gap-2">
                  {recoveryCodes.map((code, index) => (
                    <div key={index} className="text-center font-mono text-sm text-text-bright">
                      {code}
                    </div>
                  ))}
                </div>
                <div className="flex items-center justify-end border-t border-grid-bright px-1.5 py-1.5">
                  <Button
                    type="button"
                    variant="minimal/medium"
                    onClick={downloadRecoveryCodes}
                    LeadingIcon={DownloadIcon}
                  >
                    Download
                  </Button>
                  <CopyButton
                    value={recoveryCodes.join("\n")}
                    buttonVariant="minimal"
                    showTooltip={false}
                  >
                    Copy
                  </CopyButton>
                </div>
              </div>
            </div>

            <DialogFooter className="justify-end border-t-0">
              <Button
                type="submit"
                variant="primary/medium"
                shortcut={{ key: "Enter" }}
                hideShortcutKey
                autoFocus
              >
                Continue
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>

      {/* Disable MFA Confirmation Dialog */}
      <Dialog open={showDisableDialog} onOpenChange={handleDisableCancel}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Disable multi-factor authentication</DialogTitle>
          </DialogHeader>
          <Form method="post" onSubmit={handleDisableMfa}>
            <input type="hidden" name="action" value="disable-mfa" />

            {showRecoveryCode ? (
              <>
                <Paragraph className="mb-6 text-center">
                  Enter one of your recovery codes.
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
                      value={recoveryCode}
                      onChange={(e) => setRecoveryCode(e.target.value)}
                    />
                  </InputGroup>
                </Fieldset>

                <Button
                  type="button"
                  onClick={handleSwitchToTotpCode}
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
                  Enter the code from your authenticator app.
                </Paragraph>
                <Fieldset className="flex w-full flex-col items-center gap-y-2">
                  <InputOTP
                    maxLength={6}
                    value={totpCode}
                    onChange={(value) => setTotpCode(value)}
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
                  <input type="hidden" name="totpCode" value={totpCode} />
                </Fieldset>
                <Button
                  type="button"
                  onClick={handleSwitchToRecoveryCode}
                  variant="minimal/small"
                  data-action="use recovery code"
                  className="mt-4"
                >
                  Use a recovery code
                </Button>
              </>
            )}

            {mfaDisableError && <FormError>{mfaDisableError}</FormError>}

            <DialogFooter>
              <Button type="button" variant="secondary/medium" onClick={handleDisableCancel}>
                Cancel
              </Button>
              <Button type="submit" variant="primary/medium" disabled={isDisabling}>
                {isDisabling ? <Spinner className="mr-2 size-5" color="white" /> : null}
                {isDisabling ? (
                  <span className="text-text-bright">Disabling…</span>
                ) : (
                  <span className="text-text-bright">Disable MFA</span>
                )}
              </Button>
            </DialogFooter>
          </Form>
        </DialogContent>
      </Dialog>
    </>
  );
}
