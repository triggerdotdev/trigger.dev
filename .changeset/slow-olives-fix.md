---
"@trigger.dev/sdk": patch
---

You can add Alerts in the dashboard. One of these is a webhook, which this change greatly improves.

The main change is that there's now an SDK function to verify and parse them (similar to Stripe SDK).

```ts
const event = await webhooks.constructEvent(request, process.env.ALERT_WEBHOOK_SECRET!);
```

If the signature you provide matches the one from the dashboard when you create the webhook, you will get a nicely typed object back for these three types:
- "alert.run.failed"
- "alert.deployment.success"
- "alert.deployment.failed"
