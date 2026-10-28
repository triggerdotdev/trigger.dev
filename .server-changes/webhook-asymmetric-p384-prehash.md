---
area: webapp
type: feature
---

Hosted webhook endpoints can verify ECDSA P-384 (SHA-384) signatures, ECDSA signatures in raw `r||s` form, and RSA signatures made over a SHA-256 digest of the signing string (`prehash: "sha256"`).
