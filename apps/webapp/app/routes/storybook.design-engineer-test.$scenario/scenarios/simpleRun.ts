import {
  attempt,
  buildRunPageScenario,
  hook,
  httpRequest,
  log,
  run,
  runFunction,
  span,
  waitFor,
} from "../mockTrace";

// One task run with a single attempt that succeeds. Its run() has about a page of the span types
// a typical task produces: logs, traces, auto-instrumented database and HTTP calls, a short wait
// and the global lifecycle hooks.

const teamId = "team_8f2kq1";

export const simpleRun = buildRunPageScenario({
  seed: 1,
  triggeredAt: new Date("2026-10-06T09:14:03.218Z"),
  run: run("generate-weekly-report", {
    queuedFor: 184,
    payload: {
      teamId,
      weekStarting: "2026-09-28",
      format: "pdf",
      recipients: ["finance@acme.dev", "ops@acme.dev"],
    },
    output: {
      reportId: "rpt_4QzT9a",
      pages: 6,
      url: `https://reports.acme.dev/weekly/${teamId}/2026-09-28.pdf`,
      recipients: 14,
    },
    tags: [teamId, "weekly-report"],
    metadata: { status: "sent", progress: 1, pages: 6 },
    attempts: [
      attempt("cold", [
        hook("onStart", 9),
        runFunction(
          [
            log.info("Generating weekly report", { teamId, weekStarting: "2026-09-28" }),
            span("fetch-orders", { properties: { teamId, from: "2026-09-28", to: "2026-10-04" } }, [
              span("prisma:client:operation", {
                icon: undefined,
                duration: 184,
                properties: { model: "Order", method: "findMany", name: "Order.findMany" },
              }),
              log.info("Loaded 1,284 orders", { count: 1284 }, { gap: 2 }),
            ]),
            httpRequest("GET", "https://api.stripe.com/v1/balance_transactions?limit=100", {
              duration: 342,
              gap: 3,
            }),
            span("calculate-metrics", {}, [
              log.info(
                "Revenue up 12.4% week over week",
                { revenue: 48210.55, previousRevenue: 42892.1, change: 0.124 },
                { at: 212 }
              ),
            ]),
            log.warn("3 orders are missing a currency, defaulting to USD", {
              orderIds: ["ord_7Hq2", "ord_9Kd4", "ord_1Lm8"],
            }),
            span("render-pdf", { properties: { template: "weekly-report", locale: "en-GB" } }, [
              log.info("Rendered 6 pages", { pages: 6 }, { at: 1180 }),
            ]),
            waitFor(5, { gap: 2 }),
            span("upload-pdf", {}, [
              httpRequest(
                "PUT",
                `https://acme-reports.s3.eu-central-1.amazonaws.com/weekly/${teamId}/2026-09-28.pdf`,
                { at: 3, duration: 288 }
              ),
            ]),
            span("send-email", { properties: { recipients: 14 } }, [
              httpRequest("POST", "https://api.resend.com/emails/batch", { at: 2, duration: 412 }),
            ]),
            log.info("Report sent to 14 recipients", { reportId: "rpt_4QzT9a", recipients: 14 }),
          ],
          { gap: 2 }
        ),
        hook("onSuccess", 6),
      ]),
    ],
  }),
});
