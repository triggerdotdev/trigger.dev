import { EnvelopeIcon } from "@heroicons/react/20/solid";
import type { LoaderFunctionArgs, MetaFunction } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { GitHubLightIcon } from "@trigger.dev/companyicons";
import { motion, useReducedMotion } from "framer-motion";
import { redirect, typedjson, useTypedLoaderData } from "remix-typedjson";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { isGithubAuthSupported, isGoogleAuthSupported } from "~/services/auth.server";
import { getLastAuthMethod } from "~/services/lastAuthMethod.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import { getUserSession } from "~/services/sessionStorage.server";
import { requestUrl } from "~/utils/requestUrl.server";

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  );
}

function LastUsedBadge() {
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="absolute -right-[4.6rem] top-1/2 z-10 -translate-y-1/2 shadow-md">
      <motion.div
        className="relative inline-flex flex-col items-center rounded border border-charcoal-700 bg-charcoal-800 px-2 py-1 text-center text-[10px] font-medium uppercase text-blue-500"
        initial={shouldReduceMotion ? undefined : { opacity: 0, x: 4 }}
        animate={shouldReduceMotion ? undefined : { opacity: 1, x: 0 }}
        transition={shouldReduceMotion ? undefined : { duration: 0.8, ease: "easeOut" }}
      >
        <span className="pointer-events-none absolute left-0 top-1/2 -translate-x-1/2 -translate-y-1/2">
          <span className="block h-2 w-2 rotate-45 border-b border-l border-charcoal-700 bg-charcoal-800" />
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

  if (redirectTo) {
    const session = await setRedirectTo(request, redirectTo);

    return typedjson(
      {
        redirectTo,
        showGithubAuth: isGithubAuthSupported,
        showGoogleAuth: isGoogleAuthSupported,
        lastAuthMethod,
        authError: null,
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
      lastAuthMethod,
      authError,
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
        <Fieldset className="w-full">
          <div className="flex flex-col items-center gap-y-3">
            {data.showGithubAuth && (
              <div className="relative w-full">
                {data.lastAuthMethod === "github" && <LastUsedBadge />}
                <Form
                  action={`/auth/github${data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""}`}
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
                  action={`/auth/google${data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""}`}
                  method="post"
                  className="w-full"
                >
                  <Button
                    type="submit"
                    variant="secondary/extra-large"
                    fullWidth
                    data-action="continue with google"
                  >
                    <GoogleIcon className="mr-2 size-5" />
                    <span className="text-text-bright">Continue with Google</span>
                  </Button>
                </Form>
              </div>
            )}
            <div className="relative w-full">
              {data.lastAuthMethod === "email" && <LastUsedBadge />}
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
