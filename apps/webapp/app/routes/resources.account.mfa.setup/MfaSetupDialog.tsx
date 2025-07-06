import { Form } from "@remix-run/react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
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

interface MfaSetupDialogProps {
  isOpen: boolean;
  setupData?: {
    secret: string;
    otpAuthUrl: string;
  };
  error?: string;
  isSubmitting: boolean;
  onValidate: (code: string) => void;
  onCancel: () => void;
}

export function MfaSetupDialog({
  isOpen,
  setupData,
  error,
  isSubmitting,
  onValidate,
  onCancel,
}: MfaSetupDialogProps) {
  const [totpCode, setTotpCode] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onValidate(totpCode);
    setTotpCode("");
  };

  const handleCancel = () => {
    setTotpCode("");
    onCancel();
  };

  if (!setupData) return null;

  return (
    <Dialog open={isOpen}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Enable authenticator app</DialogTitle>
        </DialogHeader>
        <Form method="post" onSubmit={handleSubmit}>
          <div className="flex flex-col gap-4 pt-3">
            <Paragraph>
              Scan the QR code below with your preferred authenticator app then enter the 6 digit
              code that the app generates. Alternatively, you can copy the secret below and paste
              it into your app.
            </Paragraph>

            <div className="flex flex-col items-center justify-center gap-y-4 rounded border border-grid-dimmed bg-background-bright py-4">
              <div className="overflow-hidden rounded-lg border border-grid-dimmed">
                <QRCodeSVG value={setupData.otpAuthUrl} size={300} marginSize={3} />
              </div>
              <CopyableText value={setupData.secret} className="font-mono text-base tracking-wide" />
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

          {error && <FormError>{error}</FormError>}

          <DialogFooter>
            <Button type="button" variant="secondary/medium" onClick={handleCancel}>
              Cancel
            </Button>
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
      </DialogContent>
    </Dialog>
  );
}