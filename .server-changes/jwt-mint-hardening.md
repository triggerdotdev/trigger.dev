---
area: webapp
type: fix
---

Limit public access tokens created through the JWT endpoint to the API key's permissions and a maximum 24-hour lifetime. Rotated environment keys can no longer create tokens during their grace period.
