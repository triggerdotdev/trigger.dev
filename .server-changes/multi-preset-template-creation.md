---
area: webapp
type: feature
---

Configure the set of machine presets to build boot snapshots for at deploy time via `COMPUTE_TEMPLATE_MACHINE_PRESETS` (CSV of preset names, default `small-1x`). Use `COMPUTE_TEMPLATE_MACHINE_PRESETS_REQUIRED` (CSV, default = full PRESETS list) to scope which preset failures fail a required-mode deploy. Optional preset failures are logged and don't block the deploy.
