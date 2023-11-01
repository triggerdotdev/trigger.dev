import {
  BoltIcon,
  CloudIcon,
  CodeBracketIcon,
  CodeBracketSquareIcon,
  HeartIcon,
  ServerStackIcon,
} from "@heroicons/react/24/solid";
import { useEffect, useState } from "react";
import { cn } from "~/utils/cn";
import { LogoType } from "./LogoType";
import { LinkButton } from "./primitives/Buttons";
import { Header3 } from "./primitives/Headers";
import { Icon } from "./primitives/Icon";
import { Paragraph } from "./primitives/Paragraph";
import { TextLink } from "./primitives/TextLink";
import { LoginTooltip } from "./primitives/Tooltip";

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

const layout = "group grid place-items-center text-center overflow-hidden";
const gridCell = "hover:bg-midnight-850 rounded-lg transition bg-midnight-850/40";
const opacity = "opacity-10 group-hover:opacity-100 transition group-hover:scale-105";
const logos = "h-20 w-20 transition grayscale group-hover:grayscale-0";
const features = "h-32 w-32 text-gray-500 grayscale transition group-hover:grayscale-0";
const wide = "col-span-2";
const wider = "col-span-3 row-span-2";
const mediumSquare = "col-span-2 row-span-2";
const hidden = "hidden xl:grid";

export function LoginPageLayout({ children }: { children: React.ReactNode }) {
  const [randomQuote, setRandomQuote] = useState<QuoteType | null>(null);
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * quotes.length);
    setRandomQuote(quotes[randomIndex]);
  }, []);

  return (
    <main className="grid h-full w-full grid-cols-12">
      <div className="border-midnight-750 z-10 col-span-12 border-r bg-midnight-850 md:col-span-6 lg:col-span-5">
        <div className="flex h-full flex-col items-center justify-between p-6">
          <div className="flex w-full items-center justify-between">
            <a href="https://trigger.dev">
              <LogoType className="w-36" />
            </a>
            <LinkButton
              to="https://trigger.dev/docs"
              variant={"secondary/small"}
              LeadingIcon="docs"
            >
              Documentation
            </LinkButton>
          </div>
          <div className="flex h-full max-w-sm items-center justify-center">{children}</div>
          <Paragraph variant="extra-small" className="text-center">
            Having login issues? <TextLink href="mailto:help@trigger.dev">Email us</TextLink> or{" "}
            <TextLink href="https://trigger.dev/discord">ask us in Discord</TextLink>
          </Paragraph>
        </div>
      </div>
      <div className="hidden h-full w-full grid-cols-3 grid-rows-6 gap-4 p-4 md:col-span-6 md:grid lg:col-span-7 xl:grid-cols-5">
        <LoginTooltip side="bottom" content={<ServerlessTooltipContent />}>
          <div className={cn(layout, gridCell, mediumSquare)}>
            <ServerStackIcon className={cn(opacity, features, "group-hover:text-green-500")} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="bottom" content={<SlackTooltipContent />}>
          <div className={cn(layout, gridCell)}>
            <Icon icon="slack" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<TriggerTooltipContent />}>
          <div className={cn(layout, gridCell, mediumSquare, hidden)}>
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
            <div className="px-4">
              <Header3 className="relative text-2xl font-normal leading-8 text-gray-600 transition before:relative before:right-1 before:top-0 before:text-4xl before:text-slate-600 before:opacity-20 before:content-['❝'] group-hover:text-slate-500 group-hover:before:opacity-30 lg-height:text-xl md-height:text-lg">
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
        <LoginTooltip side="left" content={<OpenaiTooltipContent />}>
          <div className={cn("", layout, gridCell, hidden)}>
            <Icon icon="openai" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<SendgridTooltipContent />}>
          <div className={cn(layout, gridCell, hidden)}>
            <Icon icon="sendgrid" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<ReactHooksTooltipContent />}>
          <div className={cn(layout, gridCell, mediumSquare, hidden)}>
            <Icon icon="react" className={cn(opacity, features, "group-hover:text-green-500")} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="right" content={<AirtableTooltipContent />}>
          <div className={cn("", layout, gridCell)}>
            <Icon icon="airtable" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="top" content={<InYourCodebaseTooltipContent />}>
          <div className={cn(layout, gridCell, mediumSquare)}>
            <CodeBracketSquareIcon className={cn(opacity, features, "group-hover:text-rose-500")} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="right" content={<SupabaseTooltipContent />}>
          <div className={cn(layout, gridCell)}>
            <Icon icon="supabase" className={cn(logos, opacity)} />
          </div>
        </LoginTooltip>
        <LoginTooltip side="left" content={<CloudTooltipContent />}>
          <div className={cn(layout, gridCell, wide, hidden)}>
            <CloudIcon className={cn(opacity, features, "h-20 w-20 group-hover:text-blue-600")} />
          </div>
        </LoginTooltip>
      </div>
    </main>
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

function SendgridTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="sendgrid" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          SendGrid Integration
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

function OpenaiTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="openai" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          OpenAI Integration
        </Paragraph>
      </div>
      <Paragraph variant="base">Generate text, images, code and more with OpenAI's API.</Paragraph>
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

function InYourCodebaseTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <CodeBracketSquareIcon className="h-5 w-5 text-rose-500" />
        <Paragraph variant="base/bright" className="font-semibold">
          In your codebase
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Create background jobs where they belong: in your codebase.
      </Paragraph>
    </>
  );
}

function CloudTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <CloudIcon className="h-5 w-5 text-blue-600" />
        <Paragraph variant="base/bright" className="font-semibold">
          Zero infrastructure
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Use our SDK to write Jobs in your codebase and deploy as you normally do.
      </Paragraph>
    </>
  );
}

function ServerlessTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <ServerStackIcon className="h-5 w-5 text-green-500" />
        <Paragraph variant="base/bright" className="font-semibold">
          Full serverless support
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Run long-running background jobs without worrying about timeouts.
      </Paragraph>
    </>
  );
}

function ReactHooksTooltipContent() {
  return (
    <>
      <div className="mb-2 flex items-center gap-x-1.5">
        <Icon icon="react" className="h-5 w-5" />
        <Paragraph variant="base/bright" className="font-semibold">
          Show Job progress in your UI
        </Paragraph>
      </div>
      <Paragraph variant="base">
        Use our React hooks to display a real-time status to your users.
      </Paragraph>
    </>
  );
}
