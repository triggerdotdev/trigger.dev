import { Link } from "@remix-run/react";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import {
  projectSetupAstroPath,
  projectSetupExpressPath,
  projectSetupFastifyPath,
  projectSetupNextjsPath,
  projectSetupNuxtPath,
  projectSetupRedwoodPath,
  projectSetupRemixPath,
  projectSetupSvelteKitPath,
} from "~/utils/pathBuilder";
import { PageGradient } from "../PageGradient";
import { Header1 } from "../primitives/Headers";
import { NextjsLogo } from "~/assets/logos/NextjsLogo";
import { NuxtLogo } from "~/assets/logos/NuxtLogo";
import { SvelteKitLogo } from "~/assets/logos/SveltekitLogo";
import { AstroLogo } from "~/assets/logos/AstroLogo";
import { ExpressLogo } from "~/assets/logos/ExpressLogo";
import { FastifyLogo } from "~/assets/logos/FastifyLogo";
import { RedwoodLogo } from "~/assets/logos/RedwoodLogo";
import { RemixLogo } from "~/assets/logos/RemixLogo";
import { cn } from "~/utils/cn";
import { Feedback } from "../Feedback";
import { Button } from "../primitives/Buttons";
import { ChatBubbleLeftRightIcon } from "@heroicons/react/20/solid";

export function FrameworkSelector() {
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between">
          <Header1 spacing>Choose a framework to get started…</Header1>
          <Feedback
            button={
              <Button variant="tertiary/small" LeadingIcon={ChatBubbleLeftRightIcon}>
                Request a framework
              </Button>
            }
            defaultValue="feature"
          />
        </div>

        <div className="grid grid-cols-3 place-items-center gap-2">
          <FrameworkLink to={projectSetupNextjsPath(organization, project)} supported>
            <NextjsLogo className="w-32" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupExpressPath(organization, project)}>
            <ExpressLogo className="w-36" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupRemixPath(organization, project)}>
            <RemixLogo className="w-32" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupRedwoodPath(organization, project)}>
            <RedwoodLogo className="w-44" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupAstroPath(organization, project)}>
            <AstroLogo className="w-32" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupNuxtPath(organization, project)}>
            <NuxtLogo className="w-32" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupSvelteKitPath(organization, project)}>
            <SvelteKitLogo className="w-44" />
          </FrameworkLink>
          <FrameworkLink to={projectSetupFastifyPath(organization, project)}>
            <FastifyLogo className="w-36" />
          </FrameworkLink>
        </div>
      </div>
    </PageGradient>
  );
}

type FrameworkLinkProps = {
  children: React.ReactNode;
  to: string;
  supported?: boolean;
};

function FrameworkLink({ children, to, supported }: FrameworkLinkProps) {
  return (
    <Link
      to={to}
      className={cn(
        "flex h-28 w-full items-center justify-center rounded-md border border-slate-750 px-8 py-4 transition hover:bg-slate-850",
        !supported &&
          "border-dashed opacity-50 grayscale transition hover:opacity-100 hover:grayscale-0"
      )}
    >
      {children}
    </Link>
  );
}
