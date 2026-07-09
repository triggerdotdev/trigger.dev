import { EnvelopeIcon } from "@heroicons/react/20/solid";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { GitHubLightIcon } from "@trigger.dev/companyicons";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { GoogleLogo } from "~/assets/logos/GoogleLogo";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header2 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { isGithubAuthSupported, isGoogleAuthSupported } from "~/services/auth.server";
import { validatePromoCode } from "~/services/platform.v3.server";
import { setPromoCodeCookie } from "~/services/promoCode.server";
import { getUserId } from "~/services/session.server";
import { requestUrl } from "~/utils/requestUrl.server";

export const meta: MetaFunction = () => [{ title: "Claim your Trigger.dev credits" }];

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);
  const url = requestUrl(request);
  const code = url.searchParams.get("code")?.trim() || null;

  const authMethods = {
    showGithubAuth: isGithubAuthSupported,
    showGoogleAuth: isGoogleAuthSupported,
  };

  // Credits are only granted to brand-new accounts, so an already-signed-in
  // user can't redeem a code.
  if (userId) {
    return typedjson({ view: "signed_in" as const, ...authMethods });
  }

  if (!code) {
    return typedjson({ view: "invalid" as const, ...authMethods });
  }

  const validated = await validatePromoCode(code);
  if (!validated || !validated.valid) {
    return typedjson({ view: "invalid" as const, ...authMethods });
  }

  // Stash the code so it survives the OAuth round-trip and can be applied once
  // the new org selects a plan.
  return typedjson(
    {
      view: "valid" as const,
      amountInCents: validated.amountInCents ?? 0,
      expiresAt: validated.expiresAt ?? null,
      ...authMethods,
    },
    { headers: { "Set-Cookie": await setPromoCodeCookie(code) } }
  );
}

function formatDollars(cents: number) {
  const dollars = cents / 100;
  return Number.isInteger(dollars) ? `$${dollars}` : `$${dollars.toFixed(2)}`;
}

function formatExpiry(iso: string | null) {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

function SignInForm({
  showGithubAuth,
  showGoogleAuth,
}: {
  showGithubAuth: boolean;
  showGoogleAuth: boolean;
}) {
  return (
    <Fieldset className="w-full">
      <div className="flex flex-col items-center gap-y-3">
        {showGithubAuth && (
          <Form action="/auth/github" method="post" className="w-full">
            <Button
              type="submit"
              variant="secondary/extra-large"
              fullWidth
              data-action="continue with github"
            >
              <GitHubLightIcon className="mr-2 size-5" />
              <span className="text-text-bright">Continue with GitHub</span>
            </Button>
          </Form>
        )}
        {showGoogleAuth && (
          <Form action="/auth/google" method="post" className="w-full">
            <Button
              type="submit"
              variant="secondary/extra-large"
              fullWidth
              data-action="continue with google"
            >
              <GoogleLogo className="mr-2 size-5" />
              <span className="text-text-bright">Continue with Google</span>
            </Button>
          </Form>
        )}
        <LinkButton
          to="/login/magic"
          variant="secondary/extra-large"
          fullWidth
          data-action="continue with email"
          className="text-text-bright"
        >
          <EnvelopeIcon className="mr-2 size-5 text-text-bright" />
          Continue with Email
        </LinkButton>
      </div>
      <Paragraph variant="extra-small" className="mt-2 text-center">
        By signing up you agree to our{" "}
        <TextLink href="https://trigger.dev/legal" target="_blank">
          terms
        </TextLink>{" "}
        and{" "}
        <TextLink href="https://trigger.dev/legal/privacy" target="_blank">
          privacy
        </TextLink>{" "}
        policy.
      </Paragraph>
    </Fieldset>
  );
}

export default function PromoPage() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <LoginPageLayout>
      <div className="flex w-full flex-col">
        {data.view === "signed_in" ? (
          <>
            <Header2 className="sm:text-2xl md:text-3xl lg:text-4xl" spacing>
              Promo codes are for new accounts
            </Header2>
            <Paragraph variant="base" spacing>
              You're already signed in. Promo credits can only be added to a brand-new account.
            </Paragraph>
            <LinkButton to="/" variant="secondary/medium">
              Go to dashboard
            </LinkButton>
          </>
        ) : (
          <>
            <Header2 className="sm:text-2xl md:text-3xl lg:text-4xl" spacing>
              {data.view === "valid"
                ? `Claim ${formatDollars(data.amountInCents)} credits`
                : "Create your account"}
            </Header2>
            {data.view === "valid" ? (
              <Paragraph variant="base" spacing>
                These are only available for new accounts on the Free plan.
                {formatExpiry(data.expiresAt)
                  ? ` The credits expire on ${formatExpiry(data.expiresAt)}.`
                  : ""}
              </Paragraph>
            ) : (
              <Callout variant="warning" className="mb-6 w-full">
                That promo code isn't valid. You can still sign up below but credits won't be added.
              </Callout>
            )}
            <SignInForm showGithubAuth={data.showGithubAuth} showGoogleAuth={data.showGoogleAuth} />
          </>
        )}
      </div>
    </LoginPageLayout>
  );
}
