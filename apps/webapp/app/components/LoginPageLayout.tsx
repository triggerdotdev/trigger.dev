import { LogoType } from "./LogoType";
import { LinkButton } from "./primitives/Buttons";
import { Paragraph } from "./primitives/Paragraph";
import { TextLink } from "./primitives/TextLink";
import { BookOpenIcon } from "@heroicons/react/20/solid";

export function LoginPageLayout({ children }: { children: React.ReactNode }) {
  return (
    <main className="grid h-full grid-cols-1 md:grid-cols-2">
      <div className="border-r border-grid-bright bg-background-bright">
        <div className="flex h-full flex-col items-center justify-between p-6">
          <div className="flex w-full items-center justify-between">
            <a href="/">
              <LogoType className="w-36" />
            </a>
            <LinkButton
              to="/docs"
              variant={"tertiary/small"}
              LeadingIcon={BookOpenIcon}
            >
              Documentation
            </LinkButton>
          </div>
          <div className="flex h-full max-w-sm items-center justify-center">{children}</div>
          <Paragraph variant="small" className="text-center">
            Having login issues?{" "}
            <TextLink href="mailto:support@airtrigger.dev">Email us</TextLink>
          </Paragraph>
        </div>
      </div>
      <div className="hidden grid-rows-[1fr_auto] pb-6 md:grid">
        <div className="flex h-full flex-col items-center justify-center px-16">
          <div className="flex flex-col items-center gap-4">
            <h2 className="text-center text-2xl font-semibold text-text-bright">
              Background jobs, simplified.
            </h2>
            <p className="max-w-md text-center text-text-dimmed">
              Run reliable background tasks with zero infrastructure overhead. Build, deploy, and
              monitor your workflows from one place.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
