import { NODE_RUNTIME_UPDATE_MAJOR } from "@trigger.dev/core/v3";
import { RuntimeIcon } from "~/components/RuntimeIcon";
import { CodeBlock } from "~/components/code/CodeBlock";
import { InlineCode } from "~/components/code/InlineCode";
import { PageBody, PageContainer } from "~/components/layout/AppLayout";
import { LinkButton } from "~/components/primitives/Buttons";
import { ClipboardField } from "~/components/primitives/ClipboardField";
import { CopyAgentPromptButton } from "~/components/primitives/CopyButton";
import { DateTime } from "~/components/primitives/DateTime";
import { NavBar, PageTitle } from "~/components/primitives/PageHeader";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  SettingsBlock,
  SettingsContainer,
  SettingsHeader,
  SettingsRow,
  SettingsRowDescription,
  SettingsRowTitle,
  SettingsSection,
} from "~/components/primitives/SettingsLayout";
import { v3DeploymentPath, v3ProjectPath } from "~/utils/pathBuilder";

// The source major has a constant in packages/core; the target it moves projects to does not.
const NODE_RUNTIME_TARGET_MAJOR = 24;

const CONFIG_SNIPPET = `export default defineConfig({
  project: "<your-project-ref>",
  runtime: "node-${NODE_RUNTIME_TARGET_MAJOR}",
});`;

const CLI_COMMAND = "npx trigger.dev@latest projects list --needs-update";

function buildRuntimeUpdatePrompt({
  projects,
  targetMajor,
}: {
  projects: ProjectRuntimeRow[];
  targetMajor: number;
}) {
  const projectList = projects.map((project) => `- ${project.name} (${project.ref})`).join("\n");

  return `Update these Trigger.dev projects to Node.js ${targetMajor}.

They still deploy on Node.js ${NODE_RUNTIME_UPDATE_MAJOR} in production. Moving to Node.js ${targetMajor} is a one-field change in each project's trigger.config.ts.

Projects to update:
${projectList}

How to do it:
1. Find the trigger.config.ts for each project above — the reference in parentheses is its "project" field.
2. In defineConfig, set runtime: "node-${targetMajor}", adding the field if it isn't there. Reference: https://trigger.dev/docs/config/config-file#runtime
3. Deploy each project so the new runtime takes effect.
4. Check that nothing is left by running: ${CLI_COMMAND}`;
}

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
  needsUpdate,
  otherProjects,
}: {
  organizationSlug: string;
  needsUpdate: ProjectRuntimeRow[];
  otherProjects: ProjectRuntimeRow[];
}) {
  const count = needsUpdate.length;
  // "All projects" lists every project — both the ones needing an update and the rest — sorted by name.
  const allProjects = [...needsUpdate, ...otherProjects].sort((a, b) =>
    a.name.localeCompare(b.name)
  );

  return (
    <PageContainer>
      <NavBar>
        <PageTitle title="Projects" />
      </NavBar>
      <PageBody scrollable>
        <SettingsContainer>
          {count > 0 ? (
            <>
              <SettingsSection>
                <SettingsHeader
                  title={
                    <span className="flex items-center gap-x-2">
                      <span aria-hidden className="size-2 shrink-0 rounded-full bg-warning" />
                      Runtime update available
                    </span>
                  }
                  description={`${count} ${
                    count === 1 ? "project is" : "projects are"
                  } still running Node.js ${NODE_RUNTIME_UPDATE_MAJOR} in production. Update each one to Node.js ${NODE_RUNTIME_TARGET_MAJOR} and deploy a new version.`}
                />

                <SettingsRow
                  align="start"
                  title="Update your config"
                  description={
                    <>
                      Set the runtime in{" "}
                      <InlineCode variant="extra-extra-small" className="whitespace-nowrap">
                        trigger.config.ts
                      </InlineCode>
                      , then deploy. <InlineCode variant="extra-extra-small">node-22</InlineCode>{" "}
                      and <InlineCode variant="extra-extra-small">node-26</InlineCode> are also
                      supported.
                    </>
                  }
                  action={
                    <CodeBlock
                      code={CONFIG_SNIPPET}
                      showLineNumbers={false}
                      showOpenInModal={false}
                      className="w-fit"
                    />
                  }
                />

                <SettingsRow
                  title="Or check from the CLI"
                  description="Find every project that needs an update."
                  action={
                    <ClipboardField
                      value={CLI_COMMAND}
                      variant="secondary/small"
                      iconButton
                      className="w-64"
                    />
                  }
                />

                <SettingsRow
                  title="Or let your AI agent do it"
                  description="Copy a ready-to-paste prompt for Claude Code, Cursor, or any coding agent. It includes every project that needs updating."
                  action={
                    <CopyAgentPromptButton
                      prompt={buildRuntimeUpdatePrompt({
                        projects: needsUpdate,
                        targetMajor: NODE_RUNTIME_TARGET_MAJOR,
                      })}
                      label="Copy AI agent prompt"
                      tooltip="Copies an update prompt to paste into Claude Code, Cursor, or any coding agent"
                      variant="primary/small"
                    />
                  }
                />
              </SettingsSection>

              <SettingsSection>
                <SettingsHeader
                  title={
                    <span className="text-warning">
                      {count} {count === 1 ? "project" : "projects"} to update
                    </span>
                  }
                />
                {needsUpdate.map((project) => (
                  <ProjectRow
                    key={project.ref}
                    organizationSlug={organizationSlug}
                    project={project}
                  />
                ))}
              </SettingsSection>
            </>
          ) : null}

          <SettingsSection>
            <SettingsHeader title="All projects" />
            {allProjects.length === 0 ? (
              <SettingsBlock>
                <Paragraph variant="small">This organization has no projects yet.</Paragraph>
              </SettingsBlock>
            ) : (
              <>
                {count === 0 ? (
                  <SettingsBlock>
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-x-2">
                        <span aria-hidden className="size-2 shrink-0 rounded-full bg-success" />
                        <SettingsRowTitle>All projects are up to date</SettingsRowTitle>
                      </div>
                      <SettingsRowDescription>
                        Every project is running the latest Node.js version in production.
                      </SettingsRowDescription>
                    </div>
                  </SettingsBlock>
                ) : null}
                {allProjects.map((project) => (
                  <ProjectRow
                    key={project.ref}
                    organizationSlug={organizationSlug}
                    project={project}
                  />
                ))}
              </>
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
