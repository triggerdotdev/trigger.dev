import { useEffect, useState } from "react";
import { AppsmithLogo } from "~/assets/logos/AppsmithLogo";
import { CalComLogo } from "~/assets/logos/CalComLogo";
import { LyftLogo } from "~/assets/logos/LyftLogo";
import { MiddayLogo } from "~/assets/logos/MiddayLogo";
import { TldrawLogo } from "~/assets/logos/TldrawLogo";
import { UnkeyLogo } from "~/assets/logos/UnkeyLogo";
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
      <div className="hidden grid-rows-[1fr_auto] pb-6 lg:grid">
        {rightContent ?? (
          <>
            <div className="flex h-full flex-col items-center justify-center px-16">
              <Header3 className="relative text-center text-2xl font-normal leading-8 text-text-dimmed transition before:relative before:right-1 before:top-0 before:text-6xl before:text-charcoal-750 before:content-['❝'] lg-height:text-xl md-height:text-lg">
                {randomQuote?.quote}
              </Header3>
              <Paragraph className="mt-4 text-text-dimmed/60">{randomQuote?.person}</Paragraph>
            </div>
            <div className="flex flex-col items-center gap-4 px-8">
              <Paragraph>Trusted by developers at</Paragraph>
              <div className="flex w-full flex-wrap items-center justify-center gap-x-6 gap-y-3 text-text-faint xl:justify-between xl:gap-0">
                <LyftLogo className="w-11" />
                <UnkeyLogo />
                <MiddayLogo />
                <AppsmithLogo />
                <CalComLogo />
                <TldrawLogo />
              </div>
            </div>
          </>
        )}
      </div>
    </main>
  );
}
