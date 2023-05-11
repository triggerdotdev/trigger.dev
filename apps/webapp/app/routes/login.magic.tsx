import { InboxArrowDownIcon } from "@heroicons/react/24/outline";
import { ArrowLeftIcon } from "@heroicons/react/24/solid";
import type { ActionArgs, LoaderArgs, MetaFunction } from "@remix-run/node";
import { redirect } from "@remix-run/node";
import { Form, Link, useTransition } from "@remix-run/react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { LogoIcon } from "~/components/LogoIcon";
import { Button } from "~/components/primitives/Buttons";
import { Input } from "~/components/primitives/Input";
import { authenticator } from "~/services/auth.server";
import {
  commitSession,
  getUserSession,
} from "~/services/sessionStorage.server";

export async function loader({ request }: LoaderArgs) {
  await authenticator.isAuthenticated(request, {
    successRedirect: "/",
  });

  const session = await getUserSession(request);

  return typedjson({
    magicLinkSent: session.has("triggerdotdev:magiclink"),
  });
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
    session.unset("triggerdotdev:magiclink");

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
  const { magicLinkSent } = useTypedLoaderData<typeof loader>();
  const transition = useTransition();

  return (
    <div className="flex h-screen w-screen justify-between overflow-y-scroll bg-slate-900">
      <div className="bg-gradient-background flex h-full w-full grow items-center justify-center p-4">
        <div className="flex min-h-[430px] w-full max-w-xl flex-col justify-between rounded-lg bg-slate-850 shadow-md">
          <Form className="flex h-full flex-grow flex-col" method="post">
            <a
              href="https://trigger.dev"
              className="mt-12 flex w-full justify-center"
            >
              <LogoIcon className="h-10 lg:h-14" />
            </a>
            <div className="flex flex-grow flex-col items-center justify-between px-4 pt-8 pb-12 text-center">
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
                  <p className="text-base text-slate-200 lg:text-lg">
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
                      <Button
                        className="mt-2 flex w-full !max-w-full py-3"
                        name="action"
                        value="send"
                        type="submit"
                        text="Sending..."
                        size={"small"}
                        theme={"primary"}
                      />
                    ) : (
                      <Button
                        className="mt-2 flex w-full !max-w-full py-3"
                        name="action"
                        value="send"
                        type="submit"
                        text="Send a magic link"
                        size={"small"}
                        theme={"secondary"}
                      />
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
