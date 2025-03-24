import { DateTime, DateTimeAccurate } from "~/components/primitives/DateTime";
import * as Property from "~/components/primitives/PropertyTable";
import { type WaitpointDetail } from "~/presenters/v3/WaitpointPresenter.server";
import { ForceTimeout } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.waitpoints.$waitpointFriendlyId.complete/route";
import { PacketDisplay } from "./PacketDisplay";
import { WaitpointStatusCombo } from "./WaitpointStatus";
import { Paragraph } from "~/components/primitives/Paragraph";

export function WaitpointDetailTable({ waitpoint }: { waitpoint: WaitpointDetail }) {
  const hasExpired =
    waitpoint.idempotencyKeyExpiresAt && waitpoint.idempotencyKeyExpiresAt < new Date();

  return (
    <Property.Table>
      <Property.Item>
        <Property.Label>Status</Property.Label>
        <Property.Value>
          <WaitpointStatusCombo
            status={waitpoint.status}
            outputIsError={waitpoint.outputIsError}
            className="text-sm"
          />
        </Property.Value>
      </Property.Item>
      <Property.Item>
        <Property.Label>ID</Property.Label>
        <Property.Value className="whitespace-pre-wrap">{waitpoint.friendlyId}</Property.Value>
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
                  {waitpoint.status === "PENDING" && <ForceTimeout waitpoint={waitpoint} />}
                </div>
                <Paragraph variant="extra-small" className="text-text-dimmed/70">
                  {waitpoint.isTimeout
                    ? "The waitpoint timed out"
                    : waitpoint.status === "COMPLETED"
                    ? "The waitpoint completed before this timeout was reached"
                    : "The waitpoint is still waiting"}
                </Paragraph>
              </div>
            </Property.Value>
          </Property.Item>
        </>
      )}
      {waitpoint.status === "PENDING" ? null : waitpoint.isTimeout ? (
        <></>
      ) : waitpoint.output ? (
        <PacketDisplay title="Output" data={waitpoint.output} dataType={waitpoint.outputType} />
      ) : waitpoint.completedAfter ? (
        <Property.Item>
          <Property.Label>Completed at</Property.Label>
          <Property.Value>
            <DateTimeAccurate date={waitpoint.completedAfter} />
          </Property.Value>
        </Property.Item>
      ) : (
        "Completed with no output"
      )}
    </Property.Table>
  );
}
