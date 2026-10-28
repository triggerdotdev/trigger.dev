---
"@trigger.dev/core": patch
---

Asymmetric webhook sources can now verify ECDSA P-384 signatures (`algorithm: "ecdsa-p384"`, SHA-384) and providers that sign a SHA-256 digest of the signing string (`prehash: "sha256"`). ECDSA signatures are accepted in DER or raw `r||s` form.
