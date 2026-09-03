import { useEffect, useState } from "react";
import { LogoType } from "./LogoType";
import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { TextLink } from "./primitives/TextLink";

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
    quote: "We love Trigger.dev and it’s had a big impact in dev iteration velocity already.",
    person: "André Neves, ZBD",
  },
  {
    quote: "We run millions of workflows a month on Trigger.dev.",
    person: "Morgan Vernay, Cal.com",
  },
  {
    quote:
      "With Trigger.dev, we’ve summarized over a million student interactions in just a couple of weeks.",
    person: "Ben Duggan, MagicSchool AI",
  },
  {
    quote:
      "Trigger.dev's TypeScript support, simplicity and visual feedback let us focus on making AI excellent at UI creation instead of managing infrastructure.",
    person: "Junior Garcia, HeroUI",
  },
  {
    quote:
      "The default tracing and observability make viewing and debugging agentic sessions incredibly easy.",
    person: "Graham Tremper, Arena",
  },
  {
    quote:
      "Trigger.dev lets us focus on AI logic, not infrastructure. We can now ship workflow orchestration the same way we ship backend features.",
    person: "Karl Kaiser, Pallet",
  },
  {
    quote:
      "Teams routinely find 200% more opportunities and increase proposal output by 70% using GovSignals. We build on Trigger.dev to make that level of scale practical.",
    person: "Conner Aldrich, GovSignals",
  },
];

export function LoginPageLayout({
  children,
  rightContent,
}: {
  children: React.ReactNode;
  /** Replaces the default testimonials panel on the right (e.g. a promo highlight). */
  rightContent?: React.ReactNode;
}) {
  const [randomQuote, setRandomQuote] = useState<QuoteType | null>(null);
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * quotes.length);
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setRandomQuote(quotes[randomIndex]);
  }, []);

  return (
    <main className="grid h-full grid-cols-1 lg:grid-cols-2">
      <div className="bg-background-dimmed lg:border-r lg:border-grid-bright lg:bg-background-bright">
        <div className="flex h-full flex-col items-center justify-center p-6 lg:justify-between">
          <div className="hidden w-full items-center justify-between lg:flex">
            <a href="https://trigger.dev">
              <LogoType className="w-36" />
            </a>
          </div>
          <div className="flex h-full w-full max-w-xs items-center justify-center">
            <div className="w-full">{children}</div>
          </div>
          <Paragraph variant="small" className="text-center">
            Having login issues? <TextLink href="https://trigger.dev/contact">Email us</TextLink> or{" "}
            <TextLink href="https://trigger.dev/discord">ask us in Discord</TextLink>
          </Paragraph>
        </div>
      </div>
      <div className="hidden p-6 lg:grid">
        {rightContent ?? (
          <div className="flex h-full flex-col items-center justify-center px-16">
            <Header3 className="relative text-center text-2xl font-normal leading-8 text-text-dimmed transition before:relative before:right-1 before:top-0 before:text-6xl before:text-grid-bright before:content-['❝'] dark:before:text-charcoal-750 lg-height:text-xl md-height:text-lg">
              {randomQuote?.quote}
            </Header3>
            <Paragraph className="mt-4 text-text-dimmed/60">{randomQuote?.person}</Paragraph>
          </div>
        )}
      </div>
    </main>
  );
}
