import { MoveToTopIcon } from "~/assets/icons/MoveToTopIcon";
import { MoveUpIcon } from "~/assets/icons/MoveUpIcon";
import { LinkButton } from "~/components/primitives/Buttons";
import { Paragraph } from "~/components/primitives/Paragraph";
import { ShortcutKey } from "~/components/primitives/ShortcutKey";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { v3RunSpanPath } from "~/utils/pathBuilder";

type RunLink = { friendlyId: string; spanId: string };

/** The run page's tree header: links to the root and parent runs, or "This is the root task". */
export function RunRelationshipsHeader({
  rootRun,
  parentRun,
}: {
  rootRun: RunLink | null;
  parentRun: RunLink | null;
}) {
  if (!rootRun && !parentRun) {
    return (
      <Paragraph variant="extra-small" className="flex-1 pl-3 text-text-faint">
        This is the root task
      </Paragraph>
    );
  }

  return (
    <ShowParentOrRootLinks
      relationships={{
        root: rootRun
          ? {
              friendlyId: rootRun.friendlyId,
              spanId: rootRun.spanId,
              isParent: parentRun ? rootRun.friendlyId === parentRun.friendlyId : true,
            }
          : undefined,
        parent:
          parentRun && rootRun?.friendlyId !== parentRun.friendlyId
            ? {
                friendlyId: parentRun.friendlyId,
                spanId: "",
              }
            : undefined,
      }}
    />
  );
}

function ShowParentOrRootLinks({
  relationships,
}: {
  relationships: {
    root?: {
      friendlyId: string;
      spanId: string;
      isParent?: boolean;
    };
    parent?: {
      friendlyId: string;
      spanId: string;
    };
  };
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Case 1: Root is also the parent
  if (relationships.root?.isParent === true) {
    return (
      <LinkButton
        variant="minimal/small"
        to={v3RunSpanPath(
          organization,
          project,
          environment,
          { friendlyId: relationships.root.friendlyId },
          { spanId: relationships.root.spanId }
        )}
        LeadingIcon={MoveToTopIcon}
        leadingIconClassName="gap-x-2"
        shortcut={{ key: "p" }}
        hideShortcutKey
        tooltip={
          <div className="-mr-1 flex items-center gap-1">
            <Paragraph variant="extra-small">Jump to root and parent run</Paragraph>
            <ShortcutKey shortcut={{ key: "p" }} variant="small" />
          </div>
        }
        className="text-xs"
      >
        Root/parent
      </LinkButton>
    );
  }

  // Case 2: Root and Parent are different runs
  return (
    <div className="flex items-center">
      {relationships.root && (
        <LinkButton
          variant="minimal/small"
          to={v3RunSpanPath(
            organization,
            project,
            environment,
            { friendlyId: relationships.root.friendlyId },
            { spanId: relationships.root.spanId }
          )}
          LeadingIcon={MoveToTopIcon}
          leadingIconClassName="gap-x-2"
          shortcut={{ key: "t" }}
          hideShortcutKey
          tooltip={
            <div className="-mr-1 flex items-center gap-1">
              <Paragraph variant="extra-small">Jump to root run</Paragraph>
              <ShortcutKey shortcut={{ key: "t" }} variant="small" />
            </div>
          }
          className="text-xs"
        >
          Root
        </LinkButton>
      )}
      {relationships.parent && (
        <LinkButton
          variant="minimal/small"
          to={v3RunSpanPath(
            organization,
            project,
            environment,
            { friendlyId: relationships.parent.friendlyId },
            { spanId: relationships.parent.spanId }
          )}
          LeadingIcon={MoveUpIcon}
          leadingIconClassName="gap-x-2"
          shortcut={{ key: "p" }}
          hideShortcutKey
          tooltip={
            <div className="-mr-1 flex items-center gap-1">
              <Paragraph variant="extra-small">Jump to parent run</Paragraph>
              <ShortcutKey shortcut={{ key: "p" }} variant="small" />
            </div>
          }
          className="text-xs"
        >
          Parent
        </LinkButton>
      )}
    </div>
  );
}
