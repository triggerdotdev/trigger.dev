---
area: webapp
type: fix
---

CORS + preflight parity on the public session API so browser-side chat transports can hit the session endpoints without being blocked:

- `POST /api/v1/sessions` (session upsert) gains `allowJWT: true` + `corsStrategy: "all"` so PATs minted by `chat.createTriggerAction` (and other browser-side session flows) pass the route's auth + respond to CORS preflight. Previously this route only accepted secret-key auth, which broke any browser-originated `sessions.create(...)` call — including the transport's direct `accessToken` fallback path.
- `POST /realtime/v1/sessions/:session/:io/append` now exports both `{ action, loader }`. The route builder installs the OPTIONS preflight handler on the `loader` even for write-only routes; without the loader export, the CORS preflight was returning 400 ("No loader for route") and Chrome treated the follow-up `POST` as `net::ERR_FAILED`.

Validated by an end-to-end UI smoke against the `references/ai-chat` app: brand-new chat → send → streamed assistant reply in ~4s → follow-up turn on the same session → `lastEventId` advances from 10 → 21.
