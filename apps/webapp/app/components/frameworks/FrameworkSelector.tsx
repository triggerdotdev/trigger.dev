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
import { Paragraph } from "../primitives/Paragraph";
import { NextjsLogo } from "~/assets/logos/NextjsLogo";
import { NuxtLogo } from "~/assets/logos/NuxtLogo";
import { SvelteKitLogo } from "~/assets/logos/SveltekitLogo";
import { AstroLogo } from "~/assets/logos/AstroLogo";
import { ExpressLogo } from "~/assets/logos/ExpressLogo";
import { FastifyLogo } from "~/assets/logos/FastifyLogo";
import { RedwoodLogo } from "~/assets/logos/RedwoodLogo";
import { RemixLogo } from "~/assets/logos/RemixLogo";

export function FrameworkSelector() {
  const organization = useOrganization();
  const project = useProject();
  const variant =
    "flex items-center justify-center rounded-md border border-slate-850 px-8 py-4 h-24 transition w-full hover:bg-slate-850";

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <Header1 className="">Create your first Job in minutes</Header1>
        <Paragraph spacing>Choose a framework to get started</Paragraph>
        <div className="grid grid-cols-3 place-items-center gap-2">
          <Link to={projectSetupNextjsPath(organization, project)} className={variant}>
            <NextjsLogo className="w-32" />
          </Link>
          <Link to={projectSetupRemixPath(organization, project)} className={variant}>
            <RemixLogo className="w-32" />
          </Link>
          <Link to={projectSetupExpressPath(organization, project)} className={variant}>
            <ExpressLogo className="w-32" />
          </Link>
          <Link to={projectSetupRedwoodPath(organization, project)} className={variant}>
            <RedwoodLogo className="w-32" />
          </Link>
          <Link to={projectSetupAstroPath(organization, project)} className={variant}>
            <AstroLogo className="w-32" />
          </Link>
          <Link to={projectSetupNuxtPath(organization, project)} className={variant}>
            <NuxtLogo className="w-32" />
          </Link>
          <Link to={projectSetupSvelteKitPath(organization, project)} className={variant}>
            <SvelteKitLogo className="w-32" />
          </Link>
          <Link to={projectSetupFastifyPath(organization, project)} className={variant}>
            <FastifyLogo className="w-32" />
          </Link>
        </div>
      </div>
    </PageGradient>
  );
}
