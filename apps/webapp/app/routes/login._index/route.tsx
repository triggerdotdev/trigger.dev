import { EnvelopeIcon, LockClosedIcon } from "@heroicons/react/20/solid";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { GitHubLightIcon } from "@trigger.dev/companyicons";
import { motion, useReducedMotion } from "framer-motion";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { GoogleLogo } from "~/assets/logos/GoogleLogo";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { featuresForRequest } from "~/features.server";
import { isGithubAuthSupported, isGoogleAuthSupported } from "~/services/auth.server";
import { getLastAuthMethod } from "~/services/lastAuthMethod.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import { getUserSession } from "~/services/sessionStorage.server";
import { ssoController } from "~/services/sso.server";
import { flags as getGlobalFlags } from "~/v3/featureFlags.server";
import { requestUrl } from "~/utils/requestUrl.server";
import { SSO_SESSION_EXPIRED_REASON } from "~/utils/ssoSession";
import { cn } from "~/utils/cn";

function LastUsedBadge({ className }: { className?: string }) {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div
      className={cn(
        "absolute -right-5 top-1 z-10 -translate-y-1/2 shadow-md md:-right-[4.6rem] md:top-1/2",
        className
      )}
    >
      <motion.div
        className="relative rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-center text-xxs font-medium uppercase text-blue-500"
        initial={shouldReduceMotion ? undefined : { opacity: 0, x: 4 }}
        animate={shouldReduceMotion ? undefined : { opacity: 1, x: 0 }}
        transition={shouldReduceMotion ? undefined : { duration: 0.8, ease: "easeOut" }}
      >
        <span className="pointer-events-none absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="hidden h-2 w-2 rotate-45 border-b border-l border-charcoal-700 bg-charcoal-800 md:block" />
        </span>
        Last used
      </motion.div>
    </div>
  );
}

export const meta: MetaFunction = ({ matches }) => {
  const parentMeta = matches
    .flatMap((match) => match.meta ?? [])
    .filter((meta) => {
      if ("title" in meta) return false;
      if ("name" in meta && meta.name === "viewport") return false;
      return true;
    });

  return [
    ...parentMeta,
    { title: `Login to Trigger.dev` },
    {
      name: "viewport",
      content: "width=device-width,initial-scale=1",
    },
  ];
};

export type PromiseReturnType<T extends (...arguments_: any) => Promise<any>> = Awaited<
  ReturnType<T>
>;

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);
  if (userId) return redirect("/");

  const url = requestUrl(request);
  const redirectTo = url.searchParams.get("redirectTo");
  const lastAuthMethod = await getLastAuthMethod(request);

  const notice =
    url.searchParams.get("reason") === SSO_SESSION_EXPIRED_REASON
      ? "Your SSO session expired. Please sign in again."
      : null;

  const { isManagedCloud } = featuresForRequest(request);
  // /login is unauthenticated and high-traffic; don't pay the plugin
  // resolution + flag fetch on self-hosted where the result is unused.
  let showSsoAuth = false;
  if (isManagedCloud) {
    const [pluginActive, globalFlags] = await Promise.all([
      ssoController.isUsingPlugin(),
      getGlobalFlags(),
    ]);
    showSsoAuth = pluginActive && (globalFlags as Record<string, unknown>).hasSso === true;
  }

  if (redirectTo) {
    const session = await setRedirectTo(request, redirectTo);

    return typedjson(
      {
        redirectTo,
        showGithubAuth: isGithubAuthSupported,
        showGoogleAuth: isGoogleAuthSupported,
        showSsoAuth,
        lastAuthMethod,
        authError: null,
        notice,
        isVercelMarketplace: redirectTo.startsWith("/vercel/callback"),
      },
      {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      }
    );
  } else {
    const session = await getUserSession(request);
    const error = session.get("auth:error");

    let authError: string | undefined;
    if (error) {
      if ("message" in error) {
        authError = error.message;
      } else {
        authError = JSON.stringify(error, null, 2);
      }
    }

    return typedjson({
      redirectTo: null,
      showGithubAuth: isGithubAuthSupported,
      showGoogleAuth: isGoogleAuthSupported,
      showSsoAuth,
      lastAuthMethod,
      authError,
      notice,
      isVercelMarketplace: false,
    });
  }
}

export default function LoginPage() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <LoginPageLayout>
      <div className="flex w-full flex-col items-center">
        <Header1 className="pb-4 font-semibold sm:text-2xl md:text-3xl lg:text-4xl">
          Welcome
        </Header1>
        <Paragraph variant="base" className="mb-6">
          Create an account or login
        </Paragraph>
        {data.notice && (
          <Callout variant="info" className="mb-6 w-full">
            {data.notice}
          </Callout>
        )}
        <Fieldset className="w-full">
          <div className="flex flex-col items-center gap-y-3">
            {data.showGithubAuth && (
              <div className="relative w-full">
                {data.lastAuthMethod === "github" && <LastUsedBadge />}
                <Form
                  action={`/auth/github${data.redirectTo ? `?redirectTo=${encodeURIComponent(data.redirectTo)}` : ""}`}
                  method="post"
                  className="w-full"
                >
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
              </div>
            )}
            {data.showGoogleAuth && (
              <div className="relative w-full">
                {data.lastAuthMethod === "google" && <LastUsedBadge />}
                <Form
                  action={`/auth/google${data.redirectTo ? `?redirectTo=${encodeURIComponent(data.redirectTo)}` : ""}`}
                  method="post"
                  className="w-full"
                >
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
              </div>
            )}
            {!data.isVercelMarketplace && (
              <div className="relative w-full">
                {data.lastAuthMethod === "email" && <LastUsedBadge />}
                <LinkButton
                  to={data.redirectTo ? `/login/magic?redirectTo=${encodeURIComponent(data.redirectTo)}` : "/login/magic"}
                  variant="secondary/extra-large"
                  fullWidth
                  data-action="continue with email"
                  className="text-text-bright"
                >
                  <EnvelopeIcon className="mr-2 size-5 text-text-bright" />
                  Continue with Email
                </LinkButton>
              </div>
            )}
            {data.showSsoAuth && !data.isVercelMarketplace && (
              <div className="flex w-full flex-col items-center gap-y-2 pt-2">
                <div className="h-px w-full bg-charcoal-700" />
                <div className="relative inline-flex items-center">
                  {data.lastAuthMethod === "sso" && <LastUsedBadge className="translate-x-2" />}
                  <TextLink
                    to={
                      data.redirectTo
                        ? `/login/sso?redirectTo=${encodeURIComponent(data.redirectTo)}`
                        : "/login/sso"
                    }
                    className="inline-flex items-center text-sm"
                    data-action="continue with sso"
                  >
                    <LockClosedIcon className="mr-1.5 size-4" />
                    Sign in with SSO
                  </TextLink>
                </div>
              </div>
            )}
            {data.authError && <FormError>{data.authError}</FormError>}
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
      </div>
    </LoginPageLayout>
  );
}
