---
area: webapp
type: feature
---

Gradually route a configurable percentage of free (then paid) organizations onto
the compute backing at trigger time, with a per-org exclusion and an admin kill
switch. Controlled by the `computeMigrationEnabled`, `computeMigrationFreePercentage`,
and `computeMigrationPaidPercentage` feature flags and the `COMPUTE_BACKING_MAP`
env var.
