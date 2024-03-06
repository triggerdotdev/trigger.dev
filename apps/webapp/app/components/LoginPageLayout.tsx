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

export function LoginPageLayout({ children }: { children: React.ReactNode }) {
  const [randomQuote, setRandomQuote] = useState<QuoteType | null>(null);
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * quotes.length);
    setRandomQuote(quotes[randomIndex]);
  }, []);

  return (
    <main className="grid h-full grid-cols-2">
      <div className="border-midnight-750 border-r bg-background-bright">
        <div className="flex h-full flex-col items-center justify-between p-6">
          <div className="flex w-full items-center justify-between">
            <a href="https://trigger.dev">
              <LogoType className="w-36" />
            </a>
            <LinkButton to="https://trigger.dev/docs" variant={"tertiary/small"} LeadingIcon="docs">
              Documentation
            </LinkButton>
          </div>
          <div className="flex h-full max-w-sm items-center justify-center">{children}</div>
          <Paragraph variant="extra-small" className="text-center">
            Having login issues? <TextLink href="https://@trigger.dev/contact">Email us</TextLink>{" "}
            or <TextLink href="https://trigger.dev/discord">ask us in Discord</TextLink>
          </Paragraph>
        </div>
      </div>
      <div className="">
        <div className="">
          <div className="px-4">
            <Header3 className="relative text-2xl font-normal leading-8 text-gray-600 transition before:relative before:right-1 before:top-0 before:text-4xl before:text-charcoal-600 before:opacity-20 before:content-['❝'] group-hover:text-charcoal-500 group-hover:before:opacity-30 lg-height:text-xl md-height:text-lg">
              {randomQuote?.quote}
            </Header3>
            <Paragraph
              variant="small"
              className="mt-4 text-gray-700 transition group-hover:text-charcoal-600"
            >
              {randomQuote?.person}
            </Paragraph>
          </div>
        </div>
      </div>
    </main>
  );
}
