import { GitPullRequestIcon, GitCommitIcon, GitBranchIcon } from "lucide-react";
import { type GitMetaLinks } from "~/presenters/v3/BranchesPresenter.server";
import { LinkButton } from "./primitives/Buttons";
import { SimpleTooltip } from "./primitives/Tooltip";

export function GitMetadata({ git }: { git?: GitMetaLinks | null }) {
  if (!git) return null;
  return (
    <>
      {git.pullRequestUrl && git.pullRequestNumber && <GitMetadataPullRequest git={git} />}
      {git.branchUrl && <GitMetadataBranch git={git} />}
      {git.shortSha && <GitMetadataCommit git={git} />}
    </>
  );
}

function GitMetadataBranch({ git }: { git: Pick<GitMetaLinks, "branchUrl" | "branchName"> }) {
  return (
    <SimpleTooltip
      button={
        <LinkButton
          variant="minimal/small"
          LeadingIcon={<GitBranchIcon className="size-4" />}
          leadingIconClassName="group-hover/table-row:text-text-bright"
          iconSpacing="gap-x-1"
          to={git.branchUrl}
          className="pl-1 duration-0 [&_span]:duration-0 group-hover/table-row:[&_span]:text-text-bright"
        >
          <span className="inline-block max-w-40 truncate align-bottom">{git.branchName}</span>
        </LinkButton>
      }
      content={git.branchName}
    />
  );
}

function GitMetadataCommit({
  git,
}: {
  git: Pick<GitMetaLinks, "commitUrl" | "shortSha" | "commitMessage">;
}) {
  return (
    <SimpleTooltip
      button={
        <LinkButton
          variant="minimal/small"
          to={git.commitUrl}
          LeadingIcon={<GitCommitIcon className="size-4" />}
          leadingIconClassName="group-hover/table-row:text-text-bright"
          iconSpacing="gap-x-1"
          className="pl-1 duration-0 [&_span]:duration-0 group-hover/table-row:[&_span]:text-text-bright"
        >
          <span className="inline-block max-w-64 truncate align-bottom">{`${git.shortSha} / ${git.commitMessage}`}</span>
        </LinkButton>
      }
      content={git.commitMessage ?? git.shortSha}
    />
  );
}

function GitMetadataPullRequest({
  git,
}: {
  git: Pick<GitMetaLinks, "pullRequestUrl" | "pullRequestNumber" | "pullRequestTitle">;
}) {
  if (!git.pullRequestUrl || !git.pullRequestNumber) return null;

  return (
    <SimpleTooltip
      button={
        <LinkButton
          variant="minimal/small"
          to={git.pullRequestUrl}
          LeadingIcon={<GitPullRequestIcon className="size-4" />}
          leadingIconClassName="group-hover/table-row:text-text-bright"
          iconSpacing="gap-x-1"
          className="pl-1 duration-0 [&_span]:duration-0 group-hover/table-row:[&_span]:text-text-bright"
        >
          <span className="inline-block max-w-56 truncate align-bottom">
            #{git.pullRequestNumber} {git.pullRequestTitle}
          </span>
        </LinkButton>
      }
      content={`#${git.pullRequestNumber} ${git.pullRequestTitle ?? ""}`}
    />
  );
}
