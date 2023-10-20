import { ArrowRightIcon } from "@heroicons/react/20/solid";
import { BoltIcon, CloudIcon, CodeBracketIcon, ServerStackIcon } from "@heroicons/react/24/solid";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { getMatchesData, metaV1 } from "@remix-run/v1-meta";
import {
  TypedMetaFunction,
  UseDataFunctionReturn,
  redirect,
  typedjson,
  useTypedLoaderData,
} from "remix-typedjson";
import { LogoType } from "~/components/LogoType";
import { Button, LinkButton } from "~/components/primitives/Buttons";
import { Fieldset } from "~/components/primitives/Fieldset";
import { Header1, Header3 } from "~/components/primitives/Headers";
import { Icon } from "~/components/primitives/Icon";
import { NamedIcon } from "~/components/primitives/NamedIcon";
import { Paragraph } from "~/components/primitives/Paragraph";
import { TextLink } from "~/components/primitives/TextLink";
import { LoginTooltip } from "~/components/primitives/Tooltip";
import type { LoaderType as RootLoader } from "~/root";
import { isGithubAuthSupported } from "~/services/auth.server";
import { commitSession, setRedirectTo } from "~/services/redirectTo.server";
import { getUserId } from "~/services/session.server";
import { appEnvTitleTag } from "~/utils";
import { cn } from "~/utils/cn";
import { requestUrl } from "~/utils/requestUrl.server";

export const meta: TypedMetaFunction<typeof loader> = (args) => {
  const matchesData = getMatchesData(args) as { root: UseDataFunctionReturn<RootLoader> };

  return metaV1(args, {
    title: `Login to Trigger.dev${appEnvTitleTag(matchesData.root.appEnv)}`,
  });
};

export type PromiseReturnType<T extends (...arguments_: any) => Promise<any>> = Awaited<
  ReturnType<T>
>;

export async function loader({ request }: LoaderFunctionArgs) {
  const userId = await getUserId(request);
  if (userId) return redirect("/");

  const url = requestUrl(request);
  const redirectTo = url.searchParams.get("redirectTo");

  if (redirectTo) {
    const session = await setRedirectTo(request, redirectTo);

    return typedjson(
      { redirectTo, showGithubAuth: isGithubAuthSupported },
      {
        headers: {
          "Set-Cookie": await commitSession(session),
        },
      }
    );
  } else {
    return typedjson({
      redirectTo: null,
      showGithubAuth: isGithubAuthSupported,
    });
  }
}

const layout =
  "group grid place-items-center p-4 text-center overflow-hidden hover:opacity-100 hover:grayscale-0 transition";
const gridCell = "hover:bg-midnight-850 rounded-lg transition bg-midnight-850/40";
const opacity = "opacity-20 group-hover:opacity-100 transition group-hover:scale-105";
const logos = "h-20 w-20 transition grayscale group-hover:grayscale-0";
const wide = "col-span-2";
const wider = "col-span-3 row-span-2";
const mediumSquare = "col-span-2 row-span-2";

export default function LoginPage() {
  const data = useTypedLoaderData<typeof loader>();

  return (
    <main className="grid h-full w-full grid-cols-12">
      <div className="border-midnight-750 z-10 col-span-5 border-r bg-midnight-850">
        <LoginForm />
      </div>
      <div className="col-span-7 grid h-full w-full grid-flow-row grid-cols-5 grid-rows-6 gap-4 p-4">
        <div className={cn(layout, gridCell, mediumSquare)}>
          <ServerStackIcon
            className={cn(
              opacity,
              "h-40 w-40 text-gray-500 grayscale transition group-hover:text-blue-500 group-hover:grayscale-0"
            )}
          />
        </div>
        <LoginTooltip side="bottom" content={<SlackTooltipContent />}>
          <div className={cn(layout, gridCell)}>
            <Icon icon="slack" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<TriggerTooltipContent />}>
          <div className={cn(layout, gridCell, mediumSquare)}>
            <BoltIcon
              className={cn(
                opacity,
                "h-40 w-40 text-gray-500 grayscale transition group-hover:text-yellow-500 group-hover:grayscale-0"
              )}
            />
          </div>
        </LoginTooltip>
        <LoginTooltip side="bottom" content={<StripeTooltipContent />} className="max-w-lg">
          <div className={cn("", layout, gridCell)}>
            <Icon icon="stripe" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="top" content="❤️ Loved by developers">
          <div className={cn(layout, gridCell, wider)}>
            <div className="p-4">
              <Header3 className="before:group-transition relative text-2xl font-normal leading-8 text-dimmed before:absolute before:-top-10 before:left-2 before:-z-10 before:text-8xl before:text-indigo-500 before:opacity-20 before:grayscale before:content-['❝'] group-hover:before:grayscale-0">
                Trigger.dev is redefining background jobs for modern developers.
              </Header3>
              <Paragraph variant="small" className="mt-4 text-slate-600">
                Paul Copplestone, Supabase
              </Paragraph>
            </div>
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell)}>
          <Icon icon="airtable" className={cn(logos, opacity)} />
        </div>
        <div className={cn(layout, gridCell)}>
          <Icon icon="typeform" className={cn(logos, opacity)} />
        </div>
        <div className={cn(layout, gridCell, mediumSquare)}>
          <Icon
            icon="webhook"
            className={cn(
              opacity,
              "h-40 w-40 text-gray-500 grayscale transition group-hover:text-green-500 group-hover:grayscale-0"
            )}
          />
        </div>
        <LoginTooltip
          side="right"
          content="Use our Supabase Integration in your Job to react to changes in your database."
        >
          <div className={cn(layout, gridCell)}>
            <Icon icon="supabase" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell, mediumSquare)}>
          <CodeBracketIcon
            className={cn(
              opacity,
              "h-40 w-40 text-gray-500 grayscale transition group-hover:text-rose-500 group-hover:grayscale-0"
            )}
          />
        </div>
        <div className={cn(layout, gridCell)}>
          <Icon icon="resend" className={cn(logos, opacity)} />
        </div>
        <div className={cn(layout, gridCell, wide)}>
          <CloudIcon
            className={cn(
              opacity,
              "h-20 w-20 text-gray-500 grayscale transition group-hover:text-cyan-500 group-hover:grayscale-0"
            )}
          />
        </div>
      </div>
    </main>
  );
}

function LoginForm() {
  const data = useTypedLoaderData<typeof loader>();
  return (
    <div className="h-full p-6">
      <div className="flex items-center justify-between">
        <a href="https://trigger.dev">
          <LogoType className="w-36" />
        </a>
        <LinkButton to="https://trigger.dev/docs" variant={"secondary/small"} LeadingIcon="docs">
          Documentation
        </LinkButton>
      </div>
      <div className="flex h-full items-center justify-center">
        <Form
          action={`/auth/github${data.redirectTo ? `?redirectTo=${data.redirectTo}` : ""}`}
          method="post"
        >
          <div className="flex flex-col items-center gap-y-6">
            <Header1 className="pb-4 font-normal lg:text-3xl">Welcome</Header1>
            <Paragraph variant="small" className="mb-6">
              Create an account or login
            </Paragraph>
            <Fieldset>
              <div className="flex flex-col gap-y-2">
                {data.showGithubAuth && (
                  <Button
                    type="submit"
                    variant="primary/extra-large"
                    fullWidth
                    data-action="continue with github"
                  >
                    <NamedIcon name={"github"} className={"mr-2 h-6 w-6"} />
                    Continue with GitHub
                  </Button>
                )}
                <LinkButton
                  to="/login/magic"
                  variant="secondary/extra-large"
                  fullWidth
                  data-action="continue with email"
                >
                  <NamedIcon
                    name={"envelope"}
                    className={"mr-1.5 h-4 w-4 text-dimmed transition group-hover:text-bright"}
                  />
                  Continue with Email
                </LinkButton>
              </div>
              <Paragraph variant="extra-small" className="mt-2 text-center">
                By signing up you agree to our{" "}
                <TextLink href="https://trigger.dev/legal" target="_blank">
                  terms
                </TextLink>
                {" "}and{" "}
                <TextLink href="https://trigger.dev/legal/privacy" target="_blank">
                  privacy
                </TextLink>
                {" "}policy.
              </Paragraph>
            </Fieldset>
          </div>
        </Form>
      </div>
    </div>
  );
}

function SlackTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="slack" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Slack Integration
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Use our Slack Integration to post messages to your team when your Job is triggered.
      </Paragraph>
    </>
  );
}

function StripeTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="stripe" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Stripe Integration
        </Paragraph>
      </div>
      <div className="mb-2 flex items-center gap-x-1.5">
        <ArrowRightIcon className="h-5 w-5 text-green-500" />
        <Paragraph variant="base">Trigger payments</Paragraph>
      </div>
      <div className="mb-2 flex items-center gap-x-1.5">
        <ArrowRightIcon className="h-5 w-5 text-green-500" />
        <Paragraph variant="base">Trigger emails when payments happen</Paragraph>
      </div>
      <div className="mb-2 flex items-center gap-x-1.5">
        <ArrowRightIcon className="h-5 w-5 text-green-500" />
        <Paragraph variant="base">Trigger subscription upgrades</Paragraph>
      </div>
      <div className="mb-2 flex items-center gap-x-1.5">
        <ArrowRightIcon className="h-5 w-5 text-green-500" />
        <Paragraph variant="base">And more…</Paragraph>
      </div>
    </>
  );
}

function TriggerTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <BoltIcon className="h-5 w-5 text-yellow-500" />
        <Paragraph variant="base/bright" className="font-semibold">
          Triggering your Job
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Trigger your Jobs with a wehook, on a recurring schedule or CRON or with your own custom
        event.
      </Paragraph>
    </>
  );
}
