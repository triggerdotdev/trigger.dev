import { useRevalidator } from "@remix-run/react";
import type { LoaderArgs } from "@remix-run/server-runtime";
import { useEffect } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { useEventSource } from "remix-utils";
import { z } from "zod";
import { List } from "~/components/layout/List";
import { Panel } from "~/components/layout/Panel";
import { Spinner } from "~/components/primitives/Spinner";
import { Body } from "~/components/primitives/text/Body";
import { Header1 } from "~/components/primitives/text/Headers";
import { SubTitle } from "~/components/primitives/text/SubTitle";
import { DeploymentPresenter } from "~/features/ee/projects/presenters/deploymentPresenter.server";
import { deploymentStatusTitle } from "../../../components/deploymentStatus";

export async function loader({ request, params }: LoaderArgs) {
  const { projectP, organizationSlug, deployId } = z
    .object({
      projectP: z.string(),
      organizationSlug: z.string(),
      deployId: z.string(),
    })
    .parse(params);

  const presenter = new DeploymentPresenter();

  return typedjson(await presenter.data(organizationSlug, projectP, deployId));
}

export default function DeploymentPage() {
  const { deployment, logs } = useTypedLoaderData<typeof loader>();

  const events = useEventSource(`/resources/deploys/${deployment.id}/stream`, {
    event: "update",
  });

  const revalidator = useRevalidator();

  useEffect(() => {
    if (events !== null) {
      revalidator.revalidate();
    }
    // WARNING Don't put the revalidator in the useEffect deps array or bad things will happen
  }, [events]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <Header1 className="mb-6">Deployment</Header1>
      <SubTitle className="">Deploy Summary</SubTitle>
      <List className="mb-6 px-4">
        <li className={deploySummaryGridStyles}>
          <Body size="extra-small" className={deploySummaryLabelStyles}>
            Status
          </Body>
          <div className="flex items-center gap-2">
            {deployment.status === "DEPLOYING" ||
            deployment.status === "PENDING" ||
            deployment.status === "BUILDING" ? (
              <Spinner />
            ) : (
              <></>
            )}
            <Body className={deploySummaryValueStyles}>
              {deploymentStatusTitle(deployment.status)}
            </Body>
          </div>
        </li>
        <li className={deploySummaryGridStyles}>
          <Body size="extra-small" className={deploySummaryLabelStyles}>
            Started
          </Body>
          <Body className={deploySummaryValueStyles}>
            {/* {deployment.buildStartedAt} */}
            Add date here
          </Body>
        </li>
        <li className={deploySummaryGridStyles}>
          <Body size="extra-small" className={deploySummaryLabelStyles}>
            Version
          </Body>
          <Body className={deploySummaryValueStyles}>{deployment.version}</Body>
        </li>
        <li className={deploySummaryGridStyles}>
          <Body size="extra-small" className={deploySummaryLabelStyles}>
            Commit
          </Body>
          <Body className={deploySummaryValueStyles}>
            {deployment.commitHash}
          </Body>
        </li>
        <li className={deploySummaryGridStyles}>
          <Body size="extra-small" className={deploySummaryLabelStyles}>
            Message
          </Body>
          <Body className={deploySummaryValueStyles}>
            {deployment.commitMessage} by {deployment.committer}
          </Body>
        </li>
      </List>
      <div className="mb-2 flex items-center justify-between">
        <SubTitle className="mb-0">Deploy logs</SubTitle>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <Spinner className="h-4 w-4" />
            <Body size="small" className="text-slate-400">
              Loading new logs…
            </Body>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500"></span>
            <Body size="small" className="text-slate-400">
              Live reloading
            </Body>
          </div>
        </div>
      </div>
      <div className="rounded bg-slate-950 p-4">
        <pre className="text-slate-300">
          {logs.map((log) => `${log.level} ${log.log}`).join("\n")}
        </pre>
      </div>
    </>
  );
}

const deploySummaryGridStyles = "grid grid-cols-[6rem_1fr] py-3 items-center";
const deploySummaryLabelStyles = "uppercase text-slate-400 tracking-wide";
const deploySummaryValueStyles = "text-slate-300";
