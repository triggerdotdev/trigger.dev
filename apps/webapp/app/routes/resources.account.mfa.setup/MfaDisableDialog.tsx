import { Form } from "@remix-run/react";
import { useState } from "react";
import { Button } from "~/components/primitives/Buttons";
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
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";

interface MfaDisableDialogProps {
  isOpen: boolean;
  isSubmitting: boolean;
  error?: string;
  onDisable: (totpCode?: string, recoveryCode?: string) => void;
  onCancel: () => void;
}

export function MfaDisableDialog({
  isOpen,
  isSubmitting,
  error,
  onDisable,
  onCancel,
}: MfaDisableDialogProps) {
  const [totpCode, setTotpCode] = useState("");
  const [recoveryCode, setRecoveryCode] = useState("");
  const [useRecoveryCode, setUseRecoveryCode] = useState(false);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onDisable(useRecoveryCode ? undefined : totpCode, useRecoveryCode ? recoveryCode : undefined);
  };

  const handleCancel = () => {
    setTotpCode("");
    setRecoveryCode("");
    setUseRecoveryCode(false);
    onCancel();
  };

  const handleSwitchToRecoveryCode = () => {
    setUseRecoveryCode(true);
    setTotpCode("");
  };

  const handleSwitchToTotpCode = () => {
    setUseRecoveryCode(false);
    setRecoveryCode("");
  };

  return (
    <Dialog open={isOpen} onOpenChange={handleCancel}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Disable multi-factor authentication</DialogTitle>
        </DialogHeader>
        <Form method="post" onSubmit={handleSubmit}>
          {useRecoveryCode ? (
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
              </Fieldset>
              <Button
                type="button"
                onClick={handleSwitchToRecoveryCode}
                variant="minimal/small"
                className="mt-4"
              >
                Use a recovery code
              </Button>
            </>
          )}

          {error && <FormError>{error}</FormError>}

          <DialogFooter>
            <Button type="button" variant="secondary/medium" onClick={handleCancel}>
              Cancel
            </Button>
            <Button type="submit" variant="primary/medium" disabled={isSubmitting}>
              {isSubmitting ? <Spinner className="mr-2 size-5" color="white" /> : null}
              {isSubmitting ? (
                <span className="text-text-bright">Disabling…</span>
              ) : (
                <span className="text-text-bright">Disable MFA</span>
              )}
            </Button>
          </DialogFooter>
        </Form>
      </DialogContent>
    </Dialog>
  );
}