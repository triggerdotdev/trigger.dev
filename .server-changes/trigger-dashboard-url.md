---
area: webapp
type: improvement
---

Runs now get a `TRIGGER_DASHBOARD_URL` environment variable with the dashboard's address, so a task can link to its run (`${TRIGGER_DASHBOARD_URL}/runs/${ctx.run.id}`) on any Trigger.dev instance. A `TRIGGER_DASHBOARD_URL` you set on the project still wins.
