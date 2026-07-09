import { ArrowLeftIcon } from "@heroicons/react/20/solid";
import { InboxArrowDownIcon } from "@heroicons/react/24/solid";
import {
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
  type MetaFunction,
} from "@remix-run/node";
import { Form } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LoginPageLayout } from "~/components/LoginPageLayout";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { FormButtons } from "~/components/primitives/FormButtons";
import { FormError } from "~/components/primitives/FormError";
import { Header1 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import { authenticator } from "~/services/auth.server";
import { commitSession, getUserSession } from "~/services/sessionStorage.server";
import {
  setRedirectTo,
  getRedirectTo,
  commitSession as commitRedirectSession,
} from "~/services/redirectTo.server";
import { sanitizeRedirectPath } from "~/utils";
import {
  checkMagicLinkEmailRateLimit,
  checkMagicLinkEmailDailyRateLimit,
  MagicLinkRateLimitError,
  checkMagicLinkIpRateLimit,
} from "~/services/magicLinkRateLimiter.server";
import { ssoRedirectForEmail } from "~/services/ssoAutoDiscovery.server";
import { logger, tryCatch } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { extractClientIp } from "~/utils/extractClientIp.server";

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

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticator.isAuthenticated(request, {
    successRedirect: "/",
  });

  const session = await getUserSession(request);

  // The email form now lives inline on /login; this route is only the
  // "magic link sent" confirmation. A visit without a pending magic link
  // forwards to /login — keeping the inlined form the single source of truth,
  // avoiding an orphaned duplicate page, and letting /login surface any flashed
  // auth:error. The guard
  // runs before reading auth:error so that error isn't consumed here before
  // /login can show it. An expired/invalid link click (routes/magic.tsx) is
  // different: the email-link strategy only clears the magic-link key on a
  // successful verify, so the key is still set and the request lands here — the
  // confirmation renders the flashed error as magicLinkError below.
  const url = new URL(request.url);
  const sanitized = sanitizeRedirectPath(url.searchParams.get("redirectTo"));
  // The email-link strategy stores the submitted address in the session
  // (`auth:email`) alongside the magic-link key, so read it from there to name
  // the confirmation — no address in the URL, and no separate cookie to leak
  // into the client bundle. Validate before echoing it back.
  const emailValue = session.get("auth:email");
  const email =
    typeof emailValue === "string" && z.string().email().safeParse(emailValue).success
      ? emailValue
      : null;
  if (!session.has("triggerdotdev:magiclink")) {
    // Throw (not return) so the redirect doesn't widen the loader's return
    // type — otherwise useTypedLoaderData sees TypedResponse<never> in the
    // union and the component can't read magicLinkError/email.
    throw redirect(
      sanitized === "/" ? "/login" : `/login?redirectTo=${encodeURIComponent(sanitized)}`
    );
  }

  const error = session.get("auth:error");

  const redirectTo = sanitized === "/" ? null : sanitized;
  const headers = new Headers();

  if (redirectTo) {
    const redirectSession = await setRedirectTo(request, redirectTo);
    headers.append("Set-Cookie", await commitRedirectSession(redirectSession));
  }

  let magicLinkError: string | undefined;
  if (error) {
    if ("message" in error) {
      magicLinkError = error.message;
    } else {
      magicLinkError = JSON.stringify(error, null, 2);
    }
  }

  headers.append("Set-Cookie", await commitSession(session));

  return typedjson(
    {
      magicLinkError,
      email,
    },
    {
      headers,
    }
  );
}

export async function action({ request }: ActionFunctionArgs) {
  const clonedRequest = request.clone();

  const payload = Object.fromEntries(await clonedRequest.formData());

  const result = z
    .discriminatedUnion("action", [
      z.object({
        action: z.literal("send"),
        email: z.string().trim().toLowerCase().email(),
      }),
      z.object({
        action: z.literal("reset"),
      }),
    ])
    .safeParse(payload);

  if (!result.success) {
    const session = await getUserSession(request);
    session.set("auth:error", {
      message: "Please enter a valid email address.",
    });

    return redirect("/login", {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    });
  }

  const data = result.data;

  switch (data.action) {
    case "send": {
      const { email } = data;

      if (env.LOGIN_RATE_LIMITS_ENABLED) {
        const xff = request.headers.get("x-forwarded-for");
        const clientIp = extractClientIp(xff);

        const [error] = await tryCatch(
          Promise.all([
            clientIp ? checkMagicLinkIpRateLimit(clientIp) : Promise.resolve(),
            checkMagicLinkEmailRateLimit(email),
            checkMagicLinkEmailDailyRateLimit(email),
          ])
        );

        if (error) {
          if (error instanceof MagicLinkRateLimitError) {
            logger.warn("Login magic link rate limit exceeded", {
              clientIp,
              email,
              error,
            });
          } else {
            logger.error("Failed sending login magic link", {
              clientIp,
              email,
              error,
            });
          }

          const errorMessage =
            error instanceof MagicLinkRateLimitError
              ? "Too many magic link requests. Please try again shortly."
              : "Failed sending magic link. Please try again shortly.";

          const session = await getUserSession(request);
          session.set("auth:error", {
            message: errorMessage,
          });

          return redirect("/login", {
            headers: {
              "Set-Cookie": await commitSession(session),
            },
          });
        }
      }

      // SSO auto-discovery AFTER rate limiting: this is a DB lookup on
      // attacker-controlled input, and the redirect-vs-send response is
      // a domain-enumeration oracle — both need the limiter in front.
      // Carry the user's original destination (stored in the redirect
      // cookie by the loader) through the SSO handoff so they land where
      // they meant to after authenticating, not on `/`.
      const redirectTo = await getRedirectTo(request);
      const ssoRedirect = await ssoRedirectForEmail(email, "domain_policy", redirectTo);
      if (ssoRedirect) {
        return redirect(ssoRedirect);
      }

      // The email-link strategy stores the address in the session (`auth:email`)
      // and throws its own redirect Response (with the committed session cookie),
      // so return it directly — the confirmation reads the email from the session.
      return await authenticator.authenticate("email-link", request, {
        successRedirect: "/login/magic",
        failureRedirect: "/login",
      });
    }
    case "reset":
    default: {
      data.action satisfies "reset";

      const session = await getUserSession(request);
      session.unset("triggerdotdev:magiclink");

      // The email form now lives on /login, so send "Re-enter email" straight
      // there rather than bouncing through this route's loader redirect.
      return redirect("/login", {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      });
    }
  }
}

export default function LoginMagicLinkPage() {
  const { magicLinkError, email } = useTypedLoaderData<typeof loader>();

  return (
    <LoginPageLayout>
      <Form method="post">
        <div className="flex flex-col items-center justify-center">
          <Header1 className="pb-6 text-center text-xl font-normal leading-7 md:text-xl lg:text-2xl">
            We've sent you a magic link!
          </Header1>
          <Fieldset className="flex w-full flex-col items-center gap-y-2">
            <InboxArrowDownIcon className="mb-4 h-12 w-12 text-indigo-500" />
            <Paragraph className="mb-6 text-center">
              {email ? (
                <>
                  We emailed a magic link to <span className="text-text-bright">{email}</span> to
                  log you in to your account.
                </>
              ) : (
                "We emailed you a magic link to log you in to your account."
              )}
            </Paragraph>
            {magicLinkError && <FormError>{magicLinkError}</FormError>}
            <FormButtons
              cancelButton={
                <Button
                  type="submit"
                  name="action"
                  value="reset"
                  variant="minimal/small"
                  LeadingIcon={ArrowLeftIcon}
                  leadingIconClassName="text-text-dimmed group-hover:text-text-bright transition"
                  data-action="re-enter email"
                >
                  Re-enter email
                </Button>
              }
              confirmButton={
                <LinkButton
                  to="/login"
                  variant="minimal/small"
                  data-action="log in using another option"
                >
                  Log in using another option
                </LinkButton>
              }
            />
          </Fieldset>
        </div>
      </Form>
    </LoginPageLayout>
  );
}
