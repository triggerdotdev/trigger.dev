---
"trigger.dev": patch
---

Deployed task processes now start with the environment variables that Node, OpenSSL, libuv or the dynamic loader read only at startup (such as `LD_PRELOAD`, `OPENSSL_CONF`, `NODE_ICU_DATA`, `TZ` and `UV_*`), and the run's logs warn, by name only, about other startup-only variables (such as `NODE_OPTIONS`, `MALLOC_*` or `GLIBC_TUNABLES`) that arrive too late to take effect.
