import { useEffect, useState } from "react";
import { LogoType } from "./LogoType";
import { Header3 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";
import { TextLink } from "./primitives/TextLink";
import { cn } from "~/utils/cn";

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
      "Trigger.dev's TypeScript support, simplicity and visual feedback let us focus on making AI excellent at UI creation instead of managing infrastructure.",
    person: "Junior Garcia, HeroUI",
  },
  {
    quote: "We run millions of workflows a month on Trigger.dev.",
    person: "Morgan Vernay, Cal.com",
  },
  {
    quote:
      "Trigger.dev lets us focus on AI logic, not infrastructure. We can now ship workflow orchestration the same way we ship backend features.",
    person: "Karl Kaiser, Pallet",
  },
  {
    quote:
      "With Trigger.dev, we’ve summarized over a million student interactions in just a couple of weeks.",
    person: "Ben Duggan, MagicSchool AI",
  },
  {
    quote: "We love Trigger.dev and it’s had a big impact in dev iteration velocity already.",
    person: "André Neves, ZBD",
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
  scrollable,
  singleColumn,
}: {
  children: React.ReactNode;
  /** Replaces the default testimonials panel on the right (e.g. a promo highlight). */
  rightContent?: React.ReactNode;
  /** Scrolls only the content between the logo and footer when it is taller than the viewport. */
  scrollable?: boolean;
  /** Drops the right-hand panel so the content column spans the full width. */
  singleColumn?: boolean;
}) {
  const [randomQuote, setRandomQuote] = useState<QuoteType | null>(null);
  useEffect(() => {
    const randomIndex = Math.floor(Math.random() * quotes.length);
    // oxlint-disable-next-line react/set-state-in-effect -- This effect intentionally synchronizes local state after an external or lifecycle change.
    setRandomQuote(quotes[randomIndex]);
  }, []);

  const footer = (
    <Paragraph variant="small" className="text-center">
      Having login issues? <TextLink href="https://trigger.dev/contact">Email us</TextLink> or{" "}
      <TextLink href="https://trigger.dev/discord">ask us in Discord</TextLink>
    </Paragraph>
  );

  return (
    <main className={cn("grid h-full grid-cols-1", !singleColumn && "lg:grid-cols-2")}>
      <div
        className={cn(
          "bg-background-dimmed lg:bg-background-bright",
          !singleColumn && "lg:border-r lg:border-grid-bright",
          scrollable && "h-full min-h-0 overflow-hidden"
        )}
      >
        <div
          className={cn(
            "flex h-full flex-col items-center justify-center p-6 lg:justify-between",
            scrollable && "pb-0"
          )}
        >
          <div className="hidden w-full items-center justify-between lg:flex">
            <a href="https://trigger.dev">
              <LogoType className="w-36" />
            </a>
          </div>
          {scrollable ? (
            <div className="min-h-0 w-full flex-1 overflow-y-auto">
              <div className="flex min-h-full w-full flex-col items-center">
                <div
                  className={cn(
                    "flex w-full flex-1 items-center justify-center",
                    singleColumn ? "max-w-2xl" : "max-w-xs"
                  )}
                >
                  <div className="w-full">{children}</div>
                </div>
                <div className="pb-6 pt-4">{footer}</div>
              </div>
            </div>
          ) : (
            <div className="flex h-full w-full max-w-xs items-center justify-center">
              <div className="w-full">{children}</div>
            </div>
          )}
          {!scrollable && footer}
        </div>
      </div>
      {!singleColumn && (
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
      )}
    </main>
  );
}
