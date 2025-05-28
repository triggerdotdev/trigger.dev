import { ExclamationCircleIcon } from "@heroicons/react/20/solid";
import { useLocation } from "@remix-run/react";
import { AnimatePresence, motion } from "framer-motion";
import { useEnvironment, useOptionalEnvironment } from "~/hooks/useEnvironment";
import { useOptionalOrganization, useOrganization } from "~/hooks/useOrganizations";
import { useOptionalProject, useProject } from "~/hooks/useProject";
import { v3QueuesPath } from "~/utils/pathBuilder";
import { environmentFullTitle } from "../environments/EnvironmentLabel";
import { LinkButton } from "../primitives/Buttons";
import { Icon } from "../primitives/Icon";
import { Paragraph } from "../primitives/Paragraph";

export function EnvironmentBanner() {
  const organization = useOptionalOrganization();
  const project = useOptionalProject();
  const environment = useOptionalEnvironment();

  const isPaused = organization && project && environment && environment.paused;
  const isArchived = organization && project && environment && environment.archivedAt;

  return (
    <AnimatePresence initial={false}>
      {isArchived ? <ArchivedBranchBanner /> : isPaused ? <PausedBanner /> : null}
    </AnimatePresence>
  );
}

function PausedBanner() {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const location = useLocation();
  const hideButton = location.pathname.endsWith("/queues");

  return (
    <motion.div
      className="flex h-10 items-center justify-between overflow-hidden border-y border-amber-400/20 bg-warning/20 py-0 pl-3 pr-2"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "2.5rem" }}
      exit={{ opacity: 0, height: 0 }}
    >
      <div className="flex items-center gap-2">
        <Icon icon={ExclamationCircleIcon} className="h-5 w-5 text-amber-400" />
        <Paragraph variant="small" className="text-amber-200">
          {environmentFullTitle(environment)} environment paused. No new runs will be dequeued and
          executed.
        </Paragraph>
      </div>
      {hideButton ? null : (
        <div>
          <LinkButton
            variant="tertiary/small"
            to={v3QueuesPath(organization, project, environment)}
          >
            Manage
          </LinkButton>
        </div>
      )}
    </motion.div>
  );
}

function ArchivedBranchBanner() {
  const environment = useEnvironment();

  return (
    <motion.div
      className="flex h-10 items-center justify-between overflow-hidden border-y border-amber-400/20 bg-warning/20 py-0 pl-3 pr-2"
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: "2.5rem" }}
      exit={{ opacity: 0, height: 0 }}
    >
      <div className="flex items-center gap-2">
        <Icon icon={ExclamationCircleIcon} className="h-5 w-5 text-amber-400" />
        <Paragraph variant="small" className="text-amber-200">
          "{environment.branchName}" branch is archived and is read-only. No new runs will be
          dequeued and executed.
        </Paragraph>
      </div>
    </motion.div>
  );
}
