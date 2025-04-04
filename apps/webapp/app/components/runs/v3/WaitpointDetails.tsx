import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import { Paragraph } from "~/components/primitives/Paragraph";
import * as Property from "~/components/primitives/PropertyTable";
import { TextLink } from "~/components/primitives/TextLink";
import { useEnvironment } from "~/hooks/useEnvironment";
import { useOrganization } from "~/hooks/useOrganizations";
import { useProject } from "~/hooks/useProject";
import { type WaitpointDetail } from "~/presenters/v3/WaitpointPresenter.server";
import { ForceTimeout } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";
import { v3WaitpointTokenPath, v3WaitpointTokensPath } from "~/utils/pathBuilder";
import { PacketDisplay } from "./PacketDisplay";
import { WaitpointStatusCombo } from "./WaitpointStatus";
import { RunTag } from "./RunTag";

export function WaitpointDetailTable({
  waitpoint,
  linkToList = false,
}: {
  waitpoint: WaitpointDetail;
  linkToList?: boolean;
}) {
  const organization = useOrganization();
  const project = useProject();
  const environment = useEnvironment();

  const hasExpired =
    waitpoint.idempotencyKeyExpiresAt && waitpoint.idempotencyKeyExpiresAt < new Date();

  return (
    <Property.Table>
      <Property.Item>
        <Property.Label>Status</Property.Label>
        <Property.Value>
          <WaitpointStatusCombo status={waitpoint.status} className="text-sm" />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>ID</Property.Label>
        <Property.Value className="whitespace-pre-wrap">
          {linkToList ? (
            <TextLink
              to={v3WaitpointTokenPath(organization, project, environment, waitpoint, {
                id: waitpoint.id,
              })}
            >
              {waitpoint.id}
            </TextLink>
          ) : (
            waitpoint.id
          )}
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>Idempotency key</Property.Label>
        <Property.Value>
          <div>
            <div>
              {waitpoint.userProvidedIdempotencyKey
                ? waitpoint.inactiveIdempotencyKey ?? waitpoint.idempotencyKey
                : "–"}
            </div>
            <div>
              {waitpoint.idempotencyKeyExpiresAt ? (
                <>
                  {hasExpired ? "Expired" : "Expires at"}:{" "}
                  <DateTime date={waitpoint.idempotencyKeyExpiresAt} />
                </>
              ) : null}
            </div>
          </div>
        </Property.Value>
      </Property.Item>
      {waitpoint.type === "MANUAL" && (
        <>
          <Property.Item>
            <Property.Label>Timeout</Property.Label>
            <Property.Value>
              <div>
                <div className="flex w-full flex-wrap items-center justify-between gap-1">
                  {waitpoint.completedAfter ? (
                    <>
                      <DateTimeAccurate date={waitpoint.completedAfter} />
                    </>
                  ) : (
                    "–"
                  )}
                  {waitpoint.status === "WAITING" && <ForceTimeout waitpoint={waitpoint} />}
                </div>
                <Paragraph variant="extra-small" className="text-text-dimmed/70">
                  {waitpoint.status === "TIMED_OUT"
                    ? "The waitpoint timed out"
                    : waitpoint.status === "COMPLETED"
                    ? "The waitpoint completed before this timeout was reached"
                    : "The waitpoint is still waiting"}
                </Paragraph>
              </div>
            </Property.Value>
          </Property.Item>
          <Property.Item>
            <Property.Label>Tags</Property.Label>
            <Property.Value>
              <div className="flex flex-wrap gap-1 pt-1 text-xs">
                {waitpoint.tags.map((tag) => (
                  <RunTag
                    key={tag}
                    tag={tag}
                    to={v3WaitpointTokensPath(organization, project, environment, { tags: [tag] })}
                  />
                ))}
              </div>
            </Property.Value>
          </Property.Item>
        </>
      )}
      <Property.Item>
        <Property.Label>Completed</Property.Label>
        <Property.Value>
          {waitpoint.completedAt ? <DateTimeAccurate date={waitpoint.completedAt} /> : "–"}
        </Property.Value>
      </Property.Item>
      {waitpoint.status === "WAITING" ? null : waitpoint.status === "TIMED_OUT" ? (
        <></>
      ) : waitpoint.output ? (
        <PacketDisplay title="Output" data={waitpoint.output} dataType={waitpoint.outputType} />
      ) : waitpoint.completedAfter ? null : (
        "Completed with no output"
      )}
    </Property.Table>
  );
}
