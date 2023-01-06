import type { ActionArgs, LoaderArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link, useLoaderData, useTransition } from "@remix-run/react";
import {
  commitSession,
  getUserSession,
} from "~/services/sessionStorage.server";
import { authenticator } from "~/services/auth.server";
import { ArrowLeftIcon } from "@heroicons/react/24/solid";
import { InboxArrowDownIcon } from "@heroicons/react/24/outline";
import { z } from "zod";
import { LoginPromoPanel } from "~/components/LoginPromoPanel";
import { Logo, LogoSvg } from "~/components/Logo";
import { Input } from "~/components/primitives/Input";
import { PrimaryButton } from "~/components/primitives/Buttons";

export async function loader({ request }: LoaderArgs) {
  await authenticator.isAuthenticated(request, {
    successRedirect: "/",
  });

  const session = await getUserSession(request);

  return { magicLinkSent: session.has("apihero:magiclink") };
}

export async function action({ request }: ActionArgs) {
  const clonedRequest = request.clone();

  const payload = Object.fromEntries(await clonedRequest.formData());

  const { action } = z
    .object({
      action: z.enum(["send", "reset"]),
    })
    .parse(payload);

  if (action === "send") {
    await authenticator.authenticate("email-link", request, {
      successRedirect: "/login/magic",
      failureRedirect: "/login/magic",
    });
  } else {
    const session = await getUserSession(request);
    session.unset("apihero:magiclink");

    return redirect("/login/magic", {
      headers: {
        "Set-Cookie": await commitSession(session),
      },
    });
  }
}

export const meta: MetaFunction = () => {
  return {
    title: "Login",
  };
};

export default function LoginMagicLinkPage() {
  const { magicLinkSent } = useLoaderData<typeof loader>();
  const transition = useTransition();

  return (
    <div className="flex h-screen w-screen justify-between overflow-y-scroll bg-slate-900">
      <LoginPromoPanel />
      <div className="flex grow items-center justify-center bg-gradient-background h-full w-full p-4">
        <div className="mt-[100px] flex w-full max-w-xl flex-col justify-between rounded-lg bg-slate-850 shadow-md lg:mt-0 lg:min-h-[430px]">
          <Form className="flex h-full flex-grow flex-col" method="post">
            <a
              href="https://trigger.dev"
              className="flex w-full justify-center mt-12"
            >
              <LogoSvg className="h-10 lg:h-14" />
            </a>
            <div className="flex flex-grow flex-col items-center justify-between px-4 pt-8 pb-12 text-center lg:px-4">
              {magicLinkSent ? (
                <>
                  <InboxArrowDownIcon className="mt-0 h-12 w-12 text-blue-500" />
                  <h3 className="mb-2 text-xl">We've sent you a magic link!</h3>
                  <p className="max-w-sm text-base text-slate-500">
                    We sent you an email which contains a magic link that will
                    log you in to your account.
                  </p>
                  <div className="mt-10 flex w-full max-w-sm justify-between">
                    <button
                      type="submit"
                      name="action"
                      value="reset"
                      className="flex items-center justify-center gap-1 text-sm text-slate-400 transition hover:text-slate-300"
                    >
                      <ArrowLeftIcon className="h-3 w-3" />
                      Re-enter email
                    </button>

                    <Link
                      className="flex items-center justify-center gap-1 text-sm text-slate-400 transition hover:text-slate-300"
                      to="/login"
                    >
                      Log in using another option
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-base lg:text-lg text-slate-200">
                    Enter your email address to get started.
                  </p>
                  <div className="flex w-full max-w-sm flex-col">
                    <Input
                      className="py-3"
                      type="email"
                      name="email"
                      placeholder="Email Address"
                      required
                      autoFocus
                    />

                    {transition.state === "submitting" &&
                    transition.type === "actionSubmission" &&
                    transition.submission.formData.get("action") === "send" ? (
                      <PrimaryButton
                        className="flex mt-2 py-3 w-full"
                        name="action"
                        value="send"
                        type="submit"
                      >
                        Sending...
                      </PrimaryButton>
                    ) : (
                      <PrimaryButton
                        className="flex mt-2 py-3 w-full"
                        name="action"
                        value="send"
                        type="submit"
                      >
                        Send a magic link
                      </PrimaryButton>
                    )}
                  </div>
                  <Link
                    className="flex items-center justify-center gap-1 text-sm text-slate-400 transition hover:text-slate-300"
                    to="/login"
                  >
                    <ArrowLeftIcon className="h-3 w-3" />
                    All login options
                  </Link>
                </>
              )}
            </div>
          </Form>
          <div className="w-full rounded-b-lg border-t border-slate-850 bg-slate-800 px-8 py-4">
            <p className="text-center text-xs text-slate-500">
              By logging in with your email you agree to our{" "}
              <a
                className="underline transition hover:text-indigo-500"
                href="https://trigger.dev/legal/terms"
              >
                terms
              </a>{" "}
              and{" "}
              <a
                className="underline transition hover:text-indigo-500"
                href="https://trigger.dev/legal/privacy"
              >
                privacy
              </a>{" "}
              policies.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
