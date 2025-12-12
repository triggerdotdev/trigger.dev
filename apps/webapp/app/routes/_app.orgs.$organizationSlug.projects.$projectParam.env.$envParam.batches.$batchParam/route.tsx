import { ArrowRightIcon, ExclamationTriangleIcon } from "@heroicons/react/20/solid";
import { type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { tryCatch } from "@trigger.dev/core";
import { motion } from "framer-motion";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { ExitIcon } from "~/assets/icons/ExitIcon";
import { RunsIcon } from "~/assets/icons/RunsIcon";
import { LinkButton } from "~/components/primitives/Buttons";
import { CopyableText } from "~/components/primitives/CopyableText";
import { DateTime } from "~/components/primitives/DateTime";
import { Header2, Header3 } from "~/components/primitives/Headers";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import {
  BatchStatusCombo,
  descriptionForBatchStatus,
} from "~/components/runs/v3/BatchStatus";
import { useAutoRevalidate } from "~/hooks/useAutoRevalidate";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { findProjectBySlug } from "~/models/project.server";
import { findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { BatchPresenter, type BatchPresenterData } from "~/presenters/v3/BatchPresenter.server";
import { requireUserId } from "~/services/session.server";
import { cn } from "~/utils/cn";
import { formatNumber } from "~/utils/numberFormatter";
import { EnvironmentParamSchema, v3BatchesPath, v3BatchRunsPath } from "~/utils/pathBuilder";

const BatchParamSchema = EnvironmentParamSchema.extend({
  batchParam: z.string(),
});

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const userId = await requireUserId(request);

  const { organizationSlug, projectParam, envParam, batchParam } =
    BatchParamSchema.parse(params);

  const project = await findProjectBySlug(organizationSlug, projectParam, userId);
  if (!project) {
    throw new Response("Not Found", { status: 404 });
  }

  const environment = await findEnvironmentBySlug(project.id, envParam, userId);
  if (!environment) {
    throw new Response("Not Found", { status: 404 });
  }

  try {
    const presenter = new BatchPresenter();
    const [error, data] = await tryCatch(
      presenter.call({
        environmentId: environment.id,
        batchId: batchParam,
        userId,
      })
    );

    if (error) {
      throw new Error(error.message);
    }

    return typedjson({ batch: data });
  } catch (error) {
    console.error(error);
    throw new Response(undefined, {
      status: 400,
      statusText: "Something went wrong, if this problem persists please contact support.",
    });
  }
};

export default function Page() {
  const { batch } = useTypedLoaderData<typeof loader>();
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  // Auto-reload when batch is still in progress
  useAutoRevalidate({
    interval: 1000,
    onFocus: true,
    disabled: batch.hasFinished,
  });

  const showProgressMeter = batch.isV2 && (batch.status === "PROCESSING" || batch.status === "PARTIAL_FAILED");

  return (
    <div className="grid h-full max-h-full grid-rows-[2.5rem_2.5rem_1fr_3.25rem] overflow-hidden bg-background-bright">
      {/* Header */}
      <div className="mx-3 flex items-center justify-between gap-2 overflow-x-hidden border-b border-grid-dimmed">
        <Header2 className={cn("truncate whitespace-nowrap")}>{batch.friendlyId}</Header2>
        <LinkButton
          to={v3BatchesPath(organization, project, environment)}
          variant="minimal/small"
          TrailingIcon={ExitIcon}
          shortcut={{ key: "esc" }}
          shortcutPosition="before-trailing-icon"
          className="pl-1"
        />
      </div>

      {/* Status bar */}
      <div className="flex items-center justify-between gap-2 border-b border-grid-dimmed px-3 text-sm">
        <BatchStatusCombo status={batch.status} />
        <Paragraph variant="extra-small" className="text-text-dimmed">
          {descriptionForBatchStatus(batch.status)}
        </Paragraph>
      </div>

      {/* Scrollable content */}
      <div className="overflow-y-scroll scrollbar-thin scrollbar-track-transparent scrollbar-thumb-charcoal-600">
        <div className="space-y-3">
          {/* Progress meter for v2 batches */}
          {showProgressMeter && (
            <div className="px-3 pt-3">
              <BatchProgressMeter
                successCount={batch.successfulRunCount}
                failureCount={batch.failedRunCount}
                totalCount={batch.runCount}
              />
            </div>
          )}

          {/* Properties */}
          <div className="px-3 py-3">
            <Property.Table>
              <Property.Item>
                <Property.Label>ID</Property.Label>
                <Property.Value>
                  <CopyableText value={batch.friendlyId} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Status</Property.Label>
                <Property.Value>
                  <BatchStatusCombo status={batch.status} />
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Version</Property.Label>
                <Property.Value>
                  {batch.isV2 ? "v2 (Run Engine)" : "v1 (Legacy)"}
                </Property.Value>
              </Property.Item>
              <Property.Item>
                <Property.Label>Total runs</Property.Label>
                <Property.Value>{formatNumber(batch.runCount)}</Property.Value>
              </Property.Item>
              {batch.isV2 && (
                <>
                  <Property.Item>
                    <Property.Label>Successfully created</Property.Label>
                    <Property.Value className="text-success">
                      {formatNumber(batch.successfulRunCount)}
                    </Property.Value>
                  </Property.Item>
                  {batch.failedRunCount > 0 && (
                    <Property.Item>
                      <Property.Label>Failed to create</Property.Label>
                      <Property.Value className="text-error">
                        {formatNumber(batch.failedRunCount)}
                      </Property.Value>
                    </Property.Item>
                  )}
                </>
              )}
              {batch.idempotencyKey && (
                <Property.Item>
                  <Property.Label>Idempotency key</Property.Label>
                  <Property.Value>
                    <CopyableText value={batch.idempotencyKey} className="font-mono text-xs" />
                  </Property.Value>
                </Property.Item>
              )}
              <Property.Item>
                <Property.Label>Created</Property.Label>
                <Property.Value>
                  <DateTime date={batch.createdAt} />
                </Property.Value>
              </Property.Item>
              {batch.processingStartedAt && (
                <Property.Item>
                  <Property.Label>Processing started</Property.Label>
                  <Property.Value>
                    <DateTime date={batch.processingStartedAt} />
                  </Property.Value>
                </Property.Item>
              )}
              {batch.processingCompletedAt && (
                <Property.Item>
                  <Property.Label>Processing completed</Property.Label>
                  <Property.Value>
                    <DateTime date={batch.processingCompletedAt} />
                  </Property.Value>
                </Property.Item>
              )}
              <Property.Item>
                <Property.Label>Finished</Property.Label>
                <Property.Value>
                  {batch.finishedAt ? <DateTime date={batch.finishedAt} /> : "–"}
                </Property.Value>
              </Property.Item>
            </Property.Table>
          </div>

          {/* Errors section */}
          {batch.errors.length > 0 && (
            <div className="px-3 pb-3">
              <Header3 className="mb-2 flex items-center gap-1.5 text-warning">
                <ExclamationTriangleIcon className="size-4" />
                Run creation errors ({batch.errors.length})
              </Header3>
              <div className="divide-y divide-grid-dimmed rounded-md border border-grid-dimmed bg-charcoal-900">
                {batch.errors.map((error) => (
                  <div key={error.id} className="px-3 py-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-xs text-text-dimmed">
                          Item #{error.index}
                        </span>
                        <span className="text-sm text-text-bright">{error.taskIdentifier}</span>
                      </div>
                      {error.errorCode && (
                        <span className="rounded bg-charcoal-750 px-1.5 py-0.5 font-mono text-xs text-text-dimmed">
                          {error.errorCode}
                        </span>
                      )}
                    </div>
                    <Paragraph variant="small" className="mt-1 text-error">
                      {error.error}
                    </Paragraph>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end gap-2 border-t border-grid-dimmed px-2">
        <LinkButton
          variant="tertiary/medium"
          to={v3BatchRunsPath(organization, project, environment, batch)}
          LeadingIcon={RunsIcon}
          leadingIconClassName="text-indigo-500"
          TrailingIcon={ArrowRightIcon}
        >
          View runs
        </LinkButton>
      </div>
    </div>
  );
}

type BatchProgressMeterProps = {
  successCount: number;
  failureCount: number;
  totalCount: number;
};

function BatchProgressMeter({ successCount, failureCount, totalCount }: BatchProgressMeterProps) {
  const processedCount = successCount + failureCount;
  const successPercentage = totalCount === 0 ? 0 : (successCount / totalCount) * 100;
  const failurePercentage = totalCount === 0 ? 0 : (failureCount / totalCount) * 100;

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between">
        <Paragraph variant="small/bright">Run creation progress</Paragraph>
        <Paragraph variant="extra-small">
          {formatNumber(processedCount)}/{formatNumber(totalCount)}
        </Paragraph>
      </div>
      <div className="relative h-4 w-full overflow-hidden rounded-sm bg-charcoal-900">
        <motion.div
          className="absolute left-0 top-0 h-full bg-success"
          initial={{ width: `${successPercentage}%` }}
          animate={{ width: `${successPercentage}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
        <motion.div
          className="absolute top-0 h-full bg-error"
          initial={{ width: `${failurePercentage}%`, left: `${successPercentage}%` }}
          animate={{ width: `${failurePercentage}%`, left: `${successPercentage}%` }}
          transition={{ duration: 0.3, ease: "easeOut" }}
        />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex items-center gap-1">
          <div className="h-2 w-2 rounded-[1px] bg-success" />
          <Paragraph variant="extra-small">{formatNumber(successCount)} created</Paragraph>
        </div>
        {failureCount > 0 && (
          <div className="flex items-center gap-1">
            <div className="h-2 w-2 rounded-[1px] bg-error" />
            <Paragraph variant="extra-small">{formatNumber(failureCount)} failed</Paragraph>
          </div>
        )}
      </div>
    </div>
  );
}

