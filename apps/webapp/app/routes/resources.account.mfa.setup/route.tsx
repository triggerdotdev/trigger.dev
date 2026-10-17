import { type ActionFunctionArgs } from "@remix-run/server-runtime";
import { typedjson } from "remix-typedjson";
import { z } from "zod";
import { env } from "~/env.server";
import {
  redirectWithSuccessMessage,
  redirectWithErrorMessage,
  typedJsonWithSuccessMessage,
} from "~/models/message.server";
import { MultiFactorAuthenticationService } from "~/services/mfa/multiFactorAuthentication.server";
import { requireUserId } from "~/services/session.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { MfaRateLimitError } from "~/services/mfa/mfaRateLimiterGlobal.server";
import { sanitizeRedirectPath } from "~/utils";
import { accountSecurityPath, mfaSetupPath, rootPath } from "~/utils/pathBuilder";
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
    // Where to send the user once enrollment is complete. Supplied by the
    // forced-setup page so a user who was bounced there mid-navigation lands
    // back where they were headed.
    redirectTo: z.string().optional(),
  }),
  z.object({
    action: z.literal("cancel-totp"),
  }),
  z.object({
    action: z.literal("validate-totp"),
    totpCode: z.string().length(6, "TOTP code must be 6 digits"),
  }),
]);

// Where enrollment sends the user when they did not arrive via the forced
// setup page (i.e. they enabled MFA voluntarily from Account → Security).
const DEFAULT_ENROLLMENT_REDIRECT = accountSecurityPath();

/**
 * Resolves the post-enrollment destination.
 *
 * `redirectTo` is user-influenced (it round-trips through the browser), so it
 * goes through the same sanitizer the login flow uses: it must be a relative,
 * navigable path, otherwise we fall back to the security page.
 */
function enrollmentRedirectPath(redirectTo: string | undefined): string {
  if (env.MFA_REQUIRED) {
    return sanitizeRedirectPath(redirectTo, rootPath());
  }

  return sanitizeRedirectPath(redirectTo, DEFAULT_ENROLLMENT_REDIRECT);
}

/**
 * Where to send the user when enrollment fails with an error.
 *
 * Under `MFA_REQUIRED` they have nowhere else to go — every other dashboard
 * path bounces them straight back here — so send them to the setup page
 * directly rather than making them round-trip through the gate.
 */
function enrollmentErrorRedirectPath(): string {
  return env.MFA_REQUIRED ? mfaSetupPath() : DEFAULT_ENROLLMENT_REDIRECT;
}

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
        // Refused here too (the service refuses it independently) so the
        // client gets a clean error rather than an unexpected redirect when
        // the instance requires MFA.
        if (env.MFA_REQUIRED) {
          return typedjson({
            action: "disable-mfa" as const,
            success: false as const,
            error:
              "Multi-factor authentication is required on this instance and cannot be disabled.",
          });
        }

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
        return redirectWithSuccessMessage(
          enrollmentRedirectPath(submission.data.redirectTo),
          request,
          "Successfully enabled MFA"
        );
      }
    }
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return redirectWithErrorMessage(enrollmentErrorRedirectPath(), request, error.message);
    }

    if (error instanceof MfaRateLimitError) {
      return redirectWithErrorMessage(
        enrollmentErrorRedirectPath(),
        request,
        "Too many attempts. Please try again later."
      );
    }

    // Re-throw unexpected errors
    throw error;
  }
}

export function MfaSetup({
  isEnabled,
  isRequired = false,
}: {
  isEnabled: boolean;
  isRequired?: boolean;
}) {
  const {
    state,
    actions,
    isQrDialogOpen,
    isRecoveryDialogOpen: _isRecoveryDialogOpen,
    isDisableDialogOpen,
  } = useMfaSetup(isEnabled);

  const handleToggle = (enabled: boolean) => {
    if (enabled && !state.isEnabled) {
      actions.enableMfa();
    } else if (!enabled && state.isEnabled) {
      actions.openDisableDialog();
    }
  };

  return (
    <>
      {/*
        With MFA_REQUIRED the second factor cannot be turned off, so the toggle
        and the disable dialog are omitted entirely — there is no state the
        user is allowed to reach by interacting with them.
      */}
      {!isRequired && <MfaToggle isEnabled={state.isEnabled} onToggle={handleToggle} />}

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

      {!isRequired && (
        <MfaDisableDialog
          isOpen={isDisableDialogOpen}
          isSubmitting={state.isSubmitting}
          error={state.error}
          onDisable={actions.disableMfa}
          onCancel={actions.cancelDisable}
        />
      )}
    </>
  );
}
