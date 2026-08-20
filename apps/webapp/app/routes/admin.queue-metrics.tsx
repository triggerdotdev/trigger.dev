import { useFetcher, useRevalidator } from "@remix-run/react";
import { json } from "@remix-run/server-runtime";
import { useEffect, useRef, useState } from "react";
import { typedjson, useTypedLoaderData } from "remix-typedjson";
import { z } from "zod";
import { Button } from "~/components/primitives/Buttons";
import { Callout } from "~/components/primitives/Callout";
import { Header1, Header2 } from "~/components/primitives/Headers";
import { Input } from "~/components/primitives/Input";
import { Paragraph } from "~/components/primitives/Paragraph";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableHeaderCell,
  TableRow,
} from "~/components/primitives/Table";
import { dashboardAction, dashboardLoader } from "~/services/routeBuilders/dashboardBuilder";
import {
  probeQueueMetricsStreams,
  readQueueMetricsControls,
  writeQueueMetricsControls,
} from "~/v3/queueMetrics.server";

export const loader = dashboardLoader({ authorization: { requireSuper: true } }, async () => {
  const [controls, streams] = await Promise.all([
    readQueueMetricsControls(),
    probeQueueMetricsStreams(),
  ]);
  return typedjson({ controls, streams });
});

const BodySchema = z.object({
  enabled: z.boolean().optional(),
  sampleRate: z.number().min(0).max(1).optional(),
});

export const action = dashboardAction(
  { authorization: { requireSuper: true } },
  async ({ request }) => {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return json({ error: "Invalid JSON body" }, { status: 400 });
    }
    const parsed = BodySchema.safeParse(body);
    if (!parsed.success) {
      return json({ error: "Invalid payload" }, { status: 400 });
    }
    await writeQueueMetricsControls(parsed.data);
    return json({ success: true });
  }
);

export default function AdminQueueMetricsRoute() {
  const { controls, streams } = useTypedLoaderData<typeof loader>();
  const saveFetcher = useFetcher<{ success?: boolean; error?: string }>();
  const { revalidate, state: revalidatorState } = useRevalidator();

  const [enabled, setEnabled] = useState(controls.enabled);
  const [sampleRate, setSampleRate] = useState(String(controls.sampleRate));
  const [error, setError] = useState<string | null>(null);
  const handledSaveDataRef = useRef(saveFetcher.data);

  useEffect(() => {
    // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes route state after an external or lifecycle change.
    setEnabled(controls.enabled);
    setSampleRate(String(controls.sampleRate));
  }, [controls.enabled, controls.sampleRate]);

  useEffect(() => {
    if (!saveFetcher.data || handledSaveDataRef.current === saveFetcher.data) {
      return;
    }
    handledSaveDataRef.current = saveFetcher.data;

    if (saveFetcher.data.success) {
      // oxlint-disable-next-line react/react-compiler -- This effect intentionally synchronizes route state after an external or lifecycle change.
      setError(null);
      revalidate();
    } else if (saveFetcher.data.error) {
      setError(saveFetcher.data.error);
    }
  }, [saveFetcher.data, revalidate]);

  const isSaving = saveFetcher.state === "submitting";

  const handleSave = () => {
    const rate = Number(sampleRate);
    if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
      setError("Sample rate must be a number between 0 and 1");
      return;
    }
    saveFetcher.submit(JSON.stringify({ enabled, sampleRate: rate }), {
      method: "POST",
      encType: "application/json",
    });
  };

  const totalLag = streams.reduce((sum, s) => sum + (s.lag ?? 0), 0);
  const lagUnknownCount = streams.filter((s) => s.lag === null).length;

  return (
    <main className="flex h-full min-w-0 flex-1 flex-col overflow-y-auto px-4 pb-4 lg:order-last">
      <div className="max-w-2xl space-y-4 py-4">
        <Header1>Queue metrics ingest</Header1>
        <Callout variant="warning">
          Live controls for the queue-metrics ingest pipeline on the run-queue Redis. Changes take
          effect within ~10s across all instances (no redeploy). Watch EngineCPU on the run-queue
          Redis when enabling or raising the sample rate.
        </Callout>

        <div className="space-y-3 rounded-md border border-grid-bright p-4">
          <Header2>Controls</Header2>
          <label className="flex items-center gap-2 text-sm text-text-bright">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Emission enabled <span className="text-text-dimmed">(queue_metrics:enabled)</span>
          </label>
          <div className="flex flex-col gap-1">
            <label className="text-sm text-text-dimmed">
              Gauge sample rate 0–1 (queue_metrics:gauge_sample_rate); default{" "}
              {controls.sampleRateDefault}
            </label>
            <Input
              type="number"
              min={0}
              max={1}
              step={0.05}
              value={sampleRate}
              onChange={(e) => setSampleRate(e.target.value)}
              className="w-32"
            />
          </div>
          {error && <Callout variant="error">{error}</Callout>}
          <div className="flex justify-end">
            <Button variant="primary/small" onClick={handleSave} disabled={isSaving}>
              {isSaving ? "Saving..." : "Save controls"}
            </Button>
          </div>
        </div>

        <div className="space-y-3 rounded-md border border-grid-bright p-4">
          <div className="flex items-center justify-between">
            <Header2>Stream health{totalLag > 0 ? ` (lag ${totalLag})` : ""}</Header2>
            <Button
              variant="tertiary/small"
              onClick={revalidate}
              disabled={revalidatorState === "loading"}
            >
              Refresh
            </Button>
          </div>
          <Paragraph variant="extra-small">
            Depth = entries buffered in the shard stream; Lag = entries not yet delivered to the
            consumer group (rising = consumer falling behind; "unknown" = entries were trimmed past
            the group, i.e. data was lost); Pending = unacked entries. Gauges and counters share one
            stream family on the metrics Redis.
          </Paragraph>
          {lagUnknownCount > 0 && (
            <Callout variant="error">
              Lag is unknown on {lagUnknownCount} shard{lagUnknownCount === 1 ? "" : "s"}: entries
              were trimmed past the consumer group's read position, so stream data was lost. Check
              consumer health.
            </Callout>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHeaderCell>Stream</TableHeaderCell>
                <TableHeaderCell>Shard</TableHeaderCell>
                <TableHeaderCell alignment="right">Depth</TableHeaderCell>
                <TableHeaderCell alignment="right">Lag</TableHeaderCell>
                <TableHeaderCell alignment="right">Pending</TableHeaderCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {streams.map((s) => (
                <TableRow key={`${s.stream}-${s.shard}`}>
                  <TableCell>{s.stream}</TableCell>
                  <TableCell>{s.shard}</TableCell>
                  <TableCell alignment="right">{s.depth}</TableCell>
                  <TableCell alignment="right">{s.lag ?? "unknown"}</TableCell>
                  <TableCell alignment="right">{s.pending}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>
    </main>
  );
}
