---
area: webapp
type: feature
---

Add an inbound webhook (`POST /webhooks/v1/betterstack-incidents`) that receives
status-page incident updates and proactively notifies customers over Slack
(channels matching a configurable name prefix), email (org admins, via the
alerts email transport), and Discord (an incoming webhook). Delivery runs on the
alerts redis-worker with per-surface jobs and is deduped on the incident update
id. Gated by `INCIDENT_NOTIFY_ENABLED` plus a shared-secret token in the webhook
URL; each surface no-ops unless its own config is present.
