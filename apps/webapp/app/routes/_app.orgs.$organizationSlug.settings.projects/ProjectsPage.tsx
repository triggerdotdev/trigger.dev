import { RuntimeIcon } from "~/components/RuntimeIcon";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SettingsBlock,
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsRowTitle,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { v3DeploymentPath, v3ProjectPath } from "~/utils/pathBuilder";

/** A project and its current Production deployment, or `null` when it has never been deployed. */
export type ProjectRuntimeRow = {
  name: string;
  ref: string;
  slug: string;
  environmentSlug: string;
  deployment: {
    runtime: string | null;
    runtimeVersion: string | null;
    deployedAt: Date | null;
    shortCode: string;
  } | null;
};

export function ProjectsPage({
  organizationSlug,
  projects,
}: {
  organizationSlug: string;
  projects: ProjectRuntimeRow[];
}) {
  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Projects" />
      </NavBar>
      <PageBody scrollable>
        <SettingsContainer>
          <SettingsSection>
            <SettingsHeader title="All projects" />
            {projects.length === 0 ? (
              <SettingsBlock>
                <Paragraph variant="small">This organization has no projects yet.</Paragraph>
              </SettingsBlock>
            ) : (
              projects.map((project) => (
                <ProjectRow
                  key={project.ref}
                  organizationSlug={organizationSlug}
                  project={project}
                />
              ))
            )}
          </SettingsSection>
        </SettingsContainer>
      </PageBody>
    </PageContainer>
  );
}

function ProjectRow({
  organizationSlug,
  project,
}: {
  organizationSlug: string;
  project: ProjectRuntimeRow;
}) {
  const { deployment } = project;

  return (
    <SettingsRow
      action={
        deployment ? (
          <LinkButton
            to={v3DeploymentPath(
              { slug: organizationSlug },
              { slug: project.slug },
              { slug: project.environmentSlug },
              { shortCode: deployment.shortCode },
              0
            )}
            variant="secondary/small"
            aria-label={`View deployment for ${project.name}`}
          >
            View deployment
          </LinkButton>
        ) : (
          <LinkButton
            to={v3ProjectPath({ slug: organizationSlug }, { slug: project.slug })}
            variant="secondary/small"
            aria-label={`View project ${project.name}`}
          >
            View project
          </LinkButton>
        )
      }
    >
      <div className="flex-1 space-y-0.5">
        <SettingsRowTitle>{project.name}</SettingsRowTitle>
        <p className="font-mono text-sm text-text-dimmed">{project.ref}</p>
        <div className="flex items-center gap-1.5 text-xs font-medium text-text-dimmed">
          {deployment ? (
            <>
              <RuntimeIcon
                runtime={deployment.runtime}
                runtimeVersion={deployment.runtimeVersion}
                className="size-3.5"
                withLabel
              />
              {deployment.deployedAt ? (
                <>
                  <span aria-hidden>·</span>
                  <span>
                    Production deployed <DateTime date={deployment.deployedAt} includeSeconds />
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <span>No Production deployment</span>
          )}
        </div>
      </div>
    </SettingsRow>
  );
}
