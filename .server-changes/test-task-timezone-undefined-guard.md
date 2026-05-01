---
area: webapp
type: fix
---

Guard against `parsePacket` returning `undefined` in the test page's
schedule-payload helper. When a recent SCHEDULED run had an empty payload,
`parsePacket` returned `undefined` and the subsequent `!packet.timezone`
check threw `Cannot read properties of undefined (reading 'timezone')`,
breaking the test page (Sentry TRIGGER-CLOUD-1AG).
