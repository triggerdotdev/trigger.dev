import { Form } from "@remix-run/react";
import { DownloadIcon } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
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
import { FormError } from "~/components/primitives/FormError";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/primitives/InputOTP";
import { Paragraph } from "~/components/primitives/Paragraph";

type SetupData = { secret: string; otpAuthUrl: string };

type MfaSetupDialogProps = {
  isOpen: boolean;
  setupData?: SetupData;
  recoveryCodes?: string[];
  error?: string;
  isSubmitting: boolean;
  onValidate: (code: string) => void;
  onCancel: () => void;
  onSaveRecoveryCodes: () => void;
};

export function MfaSetupDialog({
  isOpen,
  setupData,
  recoveryCodes,
  error,
  isSubmitting,
  onValidate,
  onCancel,
  onSaveRecoveryCodes,
}: MfaSetupDialogProps) {
  if (recoveryCodes && recoveryCodes.length > 0) {
    return (
      <Dialog open={isOpen}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Recovery codes</DialogTitle>
          </DialogHeader>
          <MfaRecoveryCodesForm recoveryCodes={recoveryCodes} onContinue={onSaveRecoveryCodes} />
        </DialogContent>
      </Dialog>
    );
  }

  if (!setupData) return null;

  return (
    <Dialog open={isOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Enable authenticator app</DialogTitle>
        </DialogHeader>
        <MfaQrCodeForm
          setupData={setupData}
          error={error}
          isSubmitting={isSubmitting}
          onValidate={onValidate}
          onCancel={onCancel}
        />
      </DialogContent>
    </Dialog>
  );
}

/** The QR code, the secret and the code input. Without `onCancel` there is no Cancel button. */
export function MfaQrCodeForm({
  setupData,
  error,
  isSubmitting,
  onValidate,
  onCancel,
}: {
  setupData: SetupData;
  error?: string;
  isSubmitting: boolean;
  onValidate: (code: string) => void;
  onCancel?: () => void;
}) {
  const [totpCode, setTotpCode] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onValidate(totpCode);
    setTotpCode("");
  };

  const handleCancel = () => {
    setTotpCode("");
    onCancel?.();
  };

  return (
    <Form method="post" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-4 pt-3">
        <Paragraph>
          Scan the QR code below with your preferred authenticator app then enter the 6 digit code
          that the app generates. Alternatively, you can copy the secret below and paste it into
          your app.
        </Paragraph>

        <div className="flex flex-col items-center justify-center gap-y-4 rounded border border-grid-dimmed bg-background-bright py-4">
          <div className="overflow-hidden rounded-lg border border-grid-dimmed">
            <QRCodeSVG value={setupData.otpAuthUrl} size={300} marginSize={3} />
          </div>
          <CopyableText value={setupData.secret} className="font-mono text-sm tracking-wide" />
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
                handleSubmit(e);
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

      <div className="mb-4 flex justify-center">{error && <FormError>{error}</FormError>}</div>

      <DialogFooter className={onCancel ? undefined : "justify-end"}>
        {onCancel ? (
          <Button type="button" variant="secondary/medium" onClick={handleCancel}>
            Cancel
          </Button>
        ) : null}
        <Button
          type="submit"
          variant="primary/medium"
          disabled={totpCode.length !== 6 || isSubmitting}
          shortcut={{ key: "Enter" }}
          hideShortcutKey
        >
          Confirm
        </Button>
      </DialogFooter>
    </Form>
  );
}

export function MfaRecoveryCodesForm({
  recoveryCodes,
  onContinue,
}: {
  recoveryCodes: string[];
  onContinue: () => void;
}) {
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onContinue();
  };

  const downloadRecoveryCodes = () => {
    const blob = new Blob([recoveryCodes.join("\n")], { type: "text/plain" });
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
    <Form method="post" onSubmit={handleSubmit}>
      <div className="flex flex-col gap-2 pb-0 pt-3">
        <Paragraph spacing>
          Copy and store these recovery codes carefully in case you lose your device.
        </Paragraph>

        <div className="flex flex-col rounded border border-grid-dimmed bg-background-bright">
          <div className="grid grid-cols-3 gap-x-2 gap-y-4 px-3 py-6">
            {recoveryCodes.map((code, index) => (
              <span key={index} className="text-center font-mono text-xs text-text-bright">
                {code}
              </span>
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
  );
}
