import { ActionFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { redirectWithSuccessMessage, redirectWithErrorMessage, typedJsonWithSuccessMessage } from "~/models/message.server";
import { MultiFactorAuthenticationService } from "~/services/mfa/multiFactorAuthentication.server";
import { requireUserId } from "~/services/session.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { useMfaSetup } from "./useMfaSetup";
import { MfaToggle } from "./MfaToggle";
import { MfaSetupDialog } from "./MfaSetupDialog";
import { MfaDisableDialog } from "./MfaDisableDialog";

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
  try {
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
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return redirectWithErrorMessage("/account/security", request, error.message);
    }
    
    // Re-throw unexpected errors
    throw error;
  }
}

export function MfaSetup({ isEnabled }: { isEnabled: boolean }) {
  const { state, actions, isQrDialogOpen, isRecoveryDialogOpen, isDisableDialogOpen } = useMfaSetup(isEnabled);

  const handleToggle = (enabled: boolean) => {
    if (enabled && !state.isEnabled) {
      actions.enableMfa();
    } else if (!enabled && state.isEnabled) {
      actions.openDisableDialog();
    }
  };

  return (
    <>
      <MfaToggle
        isEnabled={state.isEnabled}
        onToggle={handleToggle}
      />

      <MfaSetupDialog
        isOpen={isQrDialogOpen}
        setupData={state.setupData}
        recoveryCodes={state.recoveryCodes}
        error={state.error}
        isSubmitting={state.isSubmitting}
        onValidate={actions.validateTotp}
        onCancel={actions.cancelSetup}
        onSaveRecoveryCodes={actions.saveRecoveryCodes}
      />

      <MfaDisableDialog
        isOpen={isDisableDialogOpen}
        isSubmitting={state.isSubmitting}
        error={state.error}
        onDisable={actions.disableMfa}
        onCancel={actions.cancelDisable}
      />
    </>
  );
}
