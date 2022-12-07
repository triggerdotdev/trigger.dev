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
import { Logo } from "~/components/Logo";

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
    <div className="flex h-screen w-screen justify-between overflow-y-scroll">
      <LoginPromoPanel />
      <div className="flex grow items-center justify-center bg-gradient-background h-full w-full p-4">
        <div className="mt-[100px] flex w-full max-w-xl flex-col justify-between rounded-lg border bg-white shadow-md lg:mt-0 lg:min-h-[430px]">
          <Form className="flex h-full flex-grow flex-col" method="post">
            <div className="flex flex-grow flex-col items-center justify-between px-4 pt-6 pb-2 text-center lg:px-4">
              <a href="https://apihero.run">
                <Logo className="mb-4 h-10 w-auto lg:mb-6 lg:mt-8 lg:h-14" />
              </a>
              {magicLinkSent ? (
                <>
                  <InboxArrowDownIcon className="mt-0 h-12 w-12 text-blue-500" />
                  <h3 className="mb-2 text-xl">We've sent you a magic link!</h3>
                  <p className="max-w-sm text-base text-slate-500">
                    We sent you an email which contains a magic link that will
                    log you in to your account.
                  </p>
                  <div className="mt-10 flex w-full justify-between">
                    <button
                      type="submit"
                      name="action"
                      value="reset"
                      className="flex items-center justify-center gap-1 text-sm text-slate-500 transition hover:text-slate-800"
                    >
                      <ArrowLeftIcon className="h-3 w-3" />
                      Re-enter email
                    </button>

                    <Link
                      className="flex items-center justify-center gap-1 text-sm text-slate-500 transition hover:text-slate-800"
                      to="/login"
                    >
                      Log in using another option
                    </Link>
                  </div>
                </>
              ) : (
                <>
                  <h2 className="mb-2 text-2xl font-bold tracking-tight text-slate-700 lg:text-4xl">
                    Welcome to Trigger.dev
                  </h2>
                  <p className="mb-5 text-base lg:text-lg text-slate-600">
                    Enter your email address to get started.
                  </p>
                  <div className="flex w-full max-w-sm flex-col">
                    <input
                      className="w-full rounded-lg border border-slate-300 bg-slate-50 px-4 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none"
                      type="email"
                      name="email"
                      placeholder="Email Address"
                      required
                    />

                    {transition.state === "submitting" &&
                    transition.type === "actionSubmission" &&
                    transition.submission.formData.get("action") === "send" ? (
                      <button
                        className="mt-2 mb-6 flex w-full items-center justify-center rounded-lg border border-transparent bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                        name="action"
                        value="send"
                        type="submit"
                      >
                        Sending...
                      </button>
                    ) : (
                      <button
                        className="mt-2 mb-6 flex w-full items-center justify-center rounded-lg border border-transparent bg-blue-500 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2"
                        name="action"
                        value="send"
                        type="submit"
                      >
                        Send a magic link
                      </button>
                    )}

                    <Link
                      className="flex items-center justify-center gap-1 text-sm text-slate-500 transition hover:text-slate-800"
                      to="/login"
                    >
                      <ArrowLeftIcon className="h-3 w-3" />
                      All login options
                    </Link>
                  </div>
                </>
              )}
            </div>
          </Form>
          <div className="w-full rounded-b-lg border-t bg-slate-50 px-8 py-4">
            <p className="text-center text-xs text-slate-500">
              By logging in with your email you agree to our{" "}
              <Link
                className="underline transition hover:text-blue-500"
                to="/legal/terms"
              >
                terms
              </Link>{" "}
              and{" "}
              <Link
                className="underline transition hover:text-blue-500"
                to="/legal/privacy"
              >
                privacy
              </Link>{" "}
              policies.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
