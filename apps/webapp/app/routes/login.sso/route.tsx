import { ArrowLeftIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form, useNavigation } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { InputGroup } from "~/components/primitives/InputGroup";
import { Paragraph } from "~/components/primitives/Paragraph";
import { Spinner } from "~/components/primitives/Spinner";
import { authenticator } from "~/services/auth.server";

type Reason = "default" | "domain_policy" | "oauth_blocked" | "expired";

const REASON_VALUES: ReadonlySet<Reason> = new Set<Reason>([
  "default",
  "domain_policy",
  "oauth_blocked",
  "expired",
]);

function parseReason(value: string | null): Reason {
  if (!value) return "default";
  return REASON_VALUES.has(value as Reason) ? (value as Reason) : "default";
}

const CONTENT: Record<Reason, { heading: string; body: string }> = {
  default: {
    heading: "Sign in with SSO",
    body: "Enter your work email.",
  },
  domain_policy: {
    heading: "SSO required",
    body:
      "Trigger.dev couldn't send a magic link because your organization requires single sign-on. Continue to your identity provider.",
  },
  oauth_blocked: {
    heading: "SSO required",
    body:
      "You can't use that provider to sign in — your organization requires SSO. Continue with your identity provider.",
  },
  expired: {
    heading: "Login attempt timed out",
    body: "Your SSO login attempt expired. Click Try again to restart.",
  },
};

const ERROR_MESSAGES: Record<string, string> = {
  missing_email: "Please enter your work email.",
  no_sso_for_domain:
    "We couldn't find an SSO configuration for that email's domain. Try a different login method.",
  no_org_for_domain: "We couldn't complete sign-in. Try again or contact your administrator.",
  no_active_connection: "Your organization doesn't have an active SSO connection yet.",
  feature_disabled: "SSO is not currently available.",
  rate_limited: "Too many SSO sign-in attempts. Please try again shortly.",
  sso_failed: "We couldn't complete sign-in. Try again.",
  missing_code: "We couldn't complete sign-in. Try again.",
};

export const meta: MetaFunction = () => [
  { title: "Sign in with SSO – Trigger.dev" },
  { name: "viewport", content: "width=device-width,initial-scale=1" },
];

export async function loader({ request }: LoaderFunctionArgs) {
  // Already-authenticated users have no business on the SSO form — bounce
  // them home, mirroring the /login/magic loader guard. Combined with
  // /login/sso being non-navigable, a crafted `?redirectTo=/login/sso`
  // can't strand a signed-in user here either.
  await authenticator.isAuthenticated(request, {
    successRedirect: "/",
  });

  const url = new URL(request.url);
  const reason = parseReason(url.searchParams.get("reason"));
  const email = url.searchParams.get("email") ?? "";
  const errorCode = url.searchParams.get("error");
  const redirectTo = url.searchParams.get("redirectTo") ?? "/";

  return typedjson({
    reason,
    email,
    redirectTo,
    errorMessage: errorCode ? (ERROR_MESSAGES[errorCode] ?? "We couldn't complete sign-in. Try again.") : null,
  });
}

export default function LoginSsoPage() {
  const { reason, email, redirectTo, errorMessage } = useTypedLoaderData<typeof loader>();
  const navigation = useNavigation();
  const isLoading =
    (navigation.state === "loading" || navigation.state === "submitting") &&
    navigation.formAction === "/auth/sso";

  const content = CONTENT[reason];
  const emailReadOnly = reason === "oauth_blocked";

  return (
    <LoginPageLayout>
      <Form method="post" action="/auth/sso">
        <input type="hidden" name="redirectTo" value={redirectTo} />
        <input type="hidden" name="flow" value="user_initiated" />
        <div className="flex flex-col items-center justify-center">
          <Header1 className="pb-4 text-center font-semibold sm:text-2xl md:text-3xl lg:text-4xl">
            {content.heading}
          </Header1>
          <Paragraph variant="base" className="mb-6 text-center">
            {content.body}
          </Paragraph>
          <Fieldset className="flex w-full flex-col items-center gap-y-2">
            <InputGroup>
              <Input
                type="email"
                name="email"
                spellCheck={false}
                placeholder="Work email"
                variant="large"
                required
                autoFocus={!emailReadOnly}
                defaultValue={email}
                readOnly={emailReadOnly}
              />
            </InputGroup>

            <Button
              type="submit"
              variant="primary/large"
              disabled={isLoading}
              fullWidth
              data-action="continue with sso"
            >
              {isLoading ? (
                <Spinner className="mr-2 size-5" color="white" />
              ) : (
                <LockClosedIcon className="mr-2 size-5 text-text-bright" />
              )}
              <span className="text-text-bright">
                {isLoading
                  ? "Redirecting…"
                  : reason === "expired"
                    ? "Try again"
                    : "Continue with SSO"}
              </span>
            </Button>

            {errorMessage && <FormError>{errorMessage}</FormError>}
          </Fieldset>

          <LinkButton
            to="/login"
            variant="minimal/small"
            LeadingIcon={ArrowLeftIcon}
            leadingIconClassName="text-text-dimmed group-hover:text-text-bright transition"
            className="mt-6"
            data-action="all login options"
          >
            All login options
          </LinkButton>
        </div>
      </Form>
    </LoginPageLayout>
  );
}
