import { HeartIcon } from "@heroicons/react/20/solid";
import { BoltIcon, CloudIcon, CodeBracketIcon, ServerStackIcon } from "@heroicons/react/24/solid";
import type { LoaderFunctionArgs } from "@remix-run/node";
import { Form } from "@remix-run/react";
import { getMatchesData, metaV1 } from "@remix-run/v1-meta";
import { useEffect, useState } from "react";
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

interface QuoteType {
  quote: string;
  person: string;
}

const quotes: QuoteType[] = [
  {
    quote: "Trigger.dev is redefining background jobs for modern developers.",
    person: "Paul Copplestone, Supabase",
  },
  {
    quote:
      "Trigger.dev is a great way to automate email campaigns with Resend, and we've heard nothing but good things from our mutual customers.",
    person: "Zeno Rocha, Resend",
  },
  {
    quote: "We love Trigger.dev and it’s had a big impact in dev iteration velocity already.",
    person: "André Neves, ZBD",
  },
  {
    quote:
      "We’ve been looking for a product like Trigger.dev for a really long time - automation that's simple and developer-focused.",
    person: "Han Wang, Mintlify",
  },
];

const layout = "group grid place-items-center p-4 text-center overflow-hidden";
const gridCell = "hover:bg-midnight-850 rounded-lg transition bg-midnight-850/40";
const opacity = "opacity-10 group-hover:opacity-100 transition group-hover:scale-105";
const logos = "h-20 w-20 transition grayscale group-hover:grayscale-0";
const features = "h-32 w-32 text-gray-500 grayscale transition group-hover:grayscale-0";
const wide = "col-span-2";
const wider = "col-span-3 row-span-2";
const mediumSquare = "col-span-2 row-span-2";

export default function LoginPage() {
  const data = useTypedLoaderData<typeof loader>();

  const [randomQuote, setRandomQuote] = useState<QuoteType | null>(null);
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * quotes.length);
    setRandomQuote(quotes[randomIndex]);
  }, []);

  return (
    <main className="grid h-full w-full grid-cols-12">
      <div className="border-midnight-750 z-10 col-span-5 border-r bg-midnight-850">
        <LoginForm />
      </div>
      <div className="col-span-7 grid h-full w-full grid-flow-row grid-cols-5 grid-rows-6 gap-4 p-4">
        <div className={cn(layout, gridCell, mediumSquare)}>
          <ServerStackIcon className={cn(opacity, features, "group-hover:text-blue-500")} />
        </div>
        <LoginTooltip side="bottom" content={<SlackTooltipContent />}>
          <div className={cn(layout, gridCell)}>
            <Icon icon="slack" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<TriggerTooltipContent />}>
          <div className={cn(layout, gridCell, mediumSquare)}>
            <BoltIcon className={cn(opacity, features, "group-hover:text-yellow-500")} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="bottom" content={<StripeTooltipContent />} className="max-w-[15rem]">
          <div className={cn("", layout, gridCell)}>
            <Icon icon="stripe" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="top" content={<QuoteTooltipContent />}>
          <div className={cn(layout, gridCell, wider)}>
            <div className="p-4">
              <Header3 className="relative text-2xl font-normal leading-8 text-gray-600 transition before:absolute before:-top-8 before:left-0 before:text-7xl before:text-slate-600 before:opacity-20 before:content-['❝'] group-hover:text-slate-500 group-hover:before:opacity-30">
                {randomQuote?.quote}
              </Header3>
              <Paragraph
                variant="small"
                className="mt-4 text-gray-700 transition group-hover:text-slate-600"
              >
                {randomQuote?.person}
              </Paragraph>
            </div>
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<AirtableTooltipContent />} className="">
          <div className={cn("", layout, gridCell)}>
            <Icon icon="airtable" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<TypeformTooltipContent />} className="">
          <div className={cn("", layout, gridCell)}>
            <Icon icon="typeform" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell, mediumSquare)}>
          <Icon icon="webhook" className={cn(opacity, features, "group-hover:text-green-500")} />
        </div>
        <LoginTooltip side="right" content={<SupabaseTooltipContent />}>
          <div className={cn(layout, gridCell)}>
            <Icon icon="supabase" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell, mediumSquare)}>
          <CodeBracketIcon className={cn(opacity, features, "group-hover:text-rose-500")} />
        </div>
        <LoginTooltip side="right" content={<ResendTooltipContent />}>
          <div className={cn(layout, gridCell)}>
            <Icon icon="resend" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <div className={cn(layout, gridCell, wide)}>
          <CloudIcon className={cn(opacity, features, "h-20 w-20 group-hover:text-cyan-500")} />
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
      <Paragraph variant="base">Post messages to your team when your Job is triggered.</Paragraph>
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
      <Paragraph variant="base">Trigger payments, emails, subscription upgrades…</Paragraph>
    </>
  );
}

function SupabaseTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="supabase" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Supabase Integration
        </Paragraph>
      </div>
      <Paragraph variant="base">React to changes in your database.</Paragraph>
    </>
  );
}

function ResendTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="resend" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Resend Integration
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Create a drip campaign, trigger an onboarding sequence and more…
      </Paragraph>
    </>
  );
}

function AirtableTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="airtable" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Airtable Integration
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Update your Airtable records when you make a Stripe sale, recieve a new Typeform response
        and more…
      </Paragraph>
    </>
  );
}

function TypeformTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="typeform" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Typeform Integration
        </Paragraph>
      </div>
      <Paragraph variant="base">
        When you receive a new Typeform response, trigger a Slack message, send a Stripe invoice and
        more…
      </Paragraph>
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

function QuoteTooltipContent() {
  return (
    <>
      <div className="flex items-center gap-x-1.5">
        <HeartIcon className="h-5 w-5 text-rose-500" />
        <Paragraph variant="base/bright" className="font-semibold">
          Loved by developers
        </Paragraph>
      </div>
    </>
  );
}
