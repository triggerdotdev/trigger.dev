import { Link } from "@remix-run/react";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { projectSetupNextjsPath } from "~/utils/pathBuilder";
import { PageGradient } from "./PageGradient";
import { Header1 } from "./primitives/Headers";
import { Paragraph } from "./primitives/Paragraph";

export default function FrameworkSelector() {
  const organization = useOrganization();
  const project = useProject();

  return (
    <PageGradient>
      <div className="mx-auto max-w-3xl">
        <Header1 className="">Create your first Job in 5 minutes</Header1>
        <Paragraph>Choose a framework to get started</Paragraph>
        <Link to={projectSetupNextjsPath(organization, project)}>Next.js</Link>
      </div>
    </PageGradient>
  );
}
