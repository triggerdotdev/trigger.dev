import { conform, useForm } from "@conform-to/react";
import { parse } from "@conform-to/zod";
import { Form, type MetaFunction, useActionData } from "@remix-run/react";
import { type ActionFunction, json } from "@remix-run/server-runtime";
import { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { z } from "zod";
import {
  MainHorizontallyCenteredContainer,
  PageBody,
  PageContainer,
} from "~/components/layout/AppLayout";
import { Button } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "~/components/primitives/Dialog";
import { DialogClose } from "@radix-ui/react-dialog";
import { Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Label } from "~/components/primitives/Label";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Switch } from "~/components/primitives/Switch";
import { prisma } from "~/db.server";
import { useUser } from "~/hooks/useUser";
import { redirectWithSuccessMessage } from "~/models/message.server";
import { updateUser } from "~/models/user.server";
import { requireUserId } from "~/services/session.server";
import { accountPath } from "~/utils/pathBuilder";
import { CopyButton } from "~/components/primitives/CopyButton";
import { DownloadIcon } from "lucide-react";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "~/components/primitives/InputOTP";

export const meta: MetaFunction = () => {
  return [
    {
      title: `Security | Trigger.dev`,
    },
  ];
};

function createSchema(
  constraints: {
    isEmailUnique?: (email: string) => Promise<boolean>;
  } = {}
) {
  return z.object({
    name: z
      .string({ required_error: "You must enter a name" })
      .min(2, "Your name must be at least 2 characters long")
      .max(50),
    email: z
      .string()
      .email()
      .superRefine((email, ctx) => {
        if (constraints.isEmailUnique === undefined) {
          //client-side validation skips this
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: conform.VALIDATION_UNDEFINED,
          });
        } else {
          // Tell zod this is an async validation by returning the promise
          return constraints.isEmailUnique(email).then((isUnique) => {
            if (isUnique) {
              return;
            }

            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              message: "Email is already being used by a different account",
            });
          });
        }
      }),
    marketingEmails: z.preprocess((value) => value === "on", z.boolean()),
  });
}

export const action: ActionFunction = async ({ request }) => {
  const userId = await requireUserId(request);

  const formData = await request.formData();

  // TODO: Handle MFA actions here (enable/disable/validate TOTP)
  const action = formData.get("action");

  if (action === "enable-mfa") {
    // TODO: Validate TOTP code and enable MFA for user
    return json({ success: true });
  }

  if (action === "disable-mfa") {
    // TODO: Disable MFA for user
    return json({ success: true });
  }

  const formSchema = createSchema({
    isEmailUnique: async (email) => {
      const existingUser = await prisma.user.findFirst({
        where: {
          email,
        },
      });

      if (!existingUser) {
        return true;
      }

      if (existingUser.id === userId) {
        return true;
      }

      return false;
    },
  });

  const submission = await parse(formData, { schema: formSchema, async: true });

  if (!submission.value || submission.intent !== "submit") {
    return json(submission);
  }

  return json({ success: true });
};

export default function Page() {
  const lastSubmission = useActionData();

  // MFA state management - TODO: Get actual MFA state from backend
  const [isMfaEnabled, setIsMfaEnabled] = useState(false);
  const [showQrDialog, setShowQrDialog] = useState(false);
  const [showRecoveryDialog, setShowRecoveryDialog] = useState(false);
  const [showDisableDialog, setShowDisableDialog] = useState(false);
  const [totpCode, setTotpCode] = useState("");

  // TODO: Replace with actual data from backend
  const qrCodeValue =
    "otpauth://totp/Trigger.dev:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Trigger.dev";
  const secretKey = "JBSWY3DPEHPK3PXP";
  const recoveryCodes = [
    "abc123def456",
    "ghi789jkl012",
    "mno345pqr678",
    "stu901vwx234",
    "yz567abc890d",
    "efg123hij456",
    "klm789nop012",
    "qrs345tuv678",
  ];

  const [form, {}] = useForm({
    id: "security",
    // TODO: type this
    lastSubmission: lastSubmission as any,
    onValidate({ formData }) {
      return parse(formData, { schema: createSchema() });
    },
  });

  const handleSwitchChange = (checked: boolean) => {
    if (checked && !isMfaEnabled) {
      // Show QR code dialog to enable MFA
      setShowQrDialog(true);
    } else if (!checked && isMfaEnabled) {
      // Show confirmation dialog before disabling MFA
      setShowDisableDialog(true);
    }
  };

  const handleQrConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Submit TOTP code to backend for validation
    console.log("Validating TOTP code:", totpCode);

    // For now, simulate successful validation
    setShowQrDialog(false);
    setShowRecoveryDialog(true);
    setTotpCode("");
  };

  const handleQrCancel = () => {
    setShowQrDialog(false);
    setTotpCode("");
    // Don't change the switch state when canceling
  };

  const handleRecoveryComplete = (e: React.FormEvent) => {
    e.preventDefault();
    setShowRecoveryDialog(false);
    setIsMfaEnabled(true);
  };

  const handleEditMfa = () => {
    // Show QR dialog again with fresh QR code
    setShowQrDialog(true);
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

  const handleDisableMfa = (e: React.FormEvent) => {
    e.preventDefault();
    // TODO: Handle disabling MFA - backend call
    setShowDisableDialog(false);
    setIsMfaEnabled(false);
  };

  const handleDisableCancel = () => {
    setShowDisableDialog(false);
    // Don't change the switch state when canceling
  };

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
          <Form method="post" {...form.props} className="w-full">
            <InputGroup className="mb-4">
              <Label>Multi-factor authentication</Label>
              <Paragraph variant="small">
                Enable an extra layer of security by requiring a one-time code from your
                authenticator app (TOTP) each time you log in.
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
              {isMfaEnabled && (
                <Button type="button" variant="minimal/medium" onClick={handleEditMfa}>
                  Edit
                </Button>
              )}
            </div>
          </Form>

          {/* QR Code Dialog */}
          <Dialog open={showQrDialog} onOpenChange={setShowQrDialog}>
            <DialogContent showCloseButton={false}>
              <DialogHeader>
                <DialogTitle>Enable authenticator app</DialogTitle>
              </DialogHeader>
              <Form method="post" onSubmit={handleQrConfirm}>
                <input type="hidden" name="action" value="enable-mfa" />
                <div className="flex flex-col gap-4 pt-3">
                  <Paragraph>
                    Scan the QR code below with your preferred authenticator app then enter the 6
                    digit code that the app generates. Alternatively, you can copy the secret below
                    and paste it into your app.
                  </Paragraph>

                  <div className="flex flex-col items-center justify-center gap-y-4 rounded border border-grid-dimmed bg-background-bright py-4">
                    <div className="overflow-hidden rounded-lg border border-grid-dimmed">
                      <QRCodeSVG value={qrCodeValue} size={300} marginSize={3} />
                    </div>
                    <CopyableText value={secretKey} className="font-mono text-base tracking-wide" />
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
          <Dialog open={showRecoveryDialog} onOpenChange={setShowRecoveryDialog}>
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
          <Dialog open={showDisableDialog} onOpenChange={setShowDisableDialog}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Disable multi-factor authentication</DialogTitle>
              </DialogHeader>
              <Form method="post" onSubmit={handleDisableMfa}>
                <input type="hidden" name="action" value="disable-mfa" />
                <div className="pb-4 pt-3">
                  <Paragraph>
                    Are you sure you want to disable multi-factor authentication?
                  </Paragraph>
                </div>

                <DialogFooter>
                  <Button type="button" variant="secondary/medium" onClick={handleDisableCancel}>
                    Close
                  </Button>
                  <Button type="submit" variant="primary/medium" autoFocus>
                    Disable MFA
                  </Button>
                </DialogFooter>
              </Form>
            </DialogContent>
          </Dialog>
        </MainHorizontallyCenteredContainer>
      </PageBody>
    </PageContainer>
  );
}
