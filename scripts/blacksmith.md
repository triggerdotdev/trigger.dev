# Blacksmith Testboxes

Use Testboxes to validate changes in CI-like runners instead of running tests locally.

Always run `blacksmith testbox` commands from the repository root:

```bash
cd "$(git rev-parse --show-toplevel)"
```

## PR checks Testbox

The Linux PR Testbox covers the normal Linux PR checks: format, lint, typecheck, exports, unit test shards, webapp e2e, Linux CLI e2e, and SDK compatibility checks.

Warm it up:

```bash
blacksmith testbox warmup pr-testbox.yml --idle-timeout 60
```

Run the PR checks against your current working tree:

```bash
blacksmith testbox run --id <linux-testbox-id> "scripts/test-pr-check.sh"
```

The script prints a ✅/❌ line after each section and a final summary with durations. It fails fast by default. To keep going and collect all failures before exiting non-zero, run:

```bash
blacksmith testbox run --id <linux-testbox-id> "TEST_PR_CHECK_CONTINUE_ON_ERROR=1 scripts/test-pr-check.sh"
```

## Windows PR checks Testbox

The Windows PR Testbox covers the Windows CLI v3 e2e matrix row.

Warm it up:

```bash
blacksmith testbox warmup pr-testbox-windows.yml --idle-timeout 60
```

Run the Windows checks against your current working tree:

```bash
blacksmith testbox run --id <windows-testbox-id> "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/test-pr-check-windows.ps1"
```

## Running both

```bash
linux_id=<linux-testbox-id>
windows_id=<windows-testbox-id>

blacksmith testbox run --id "$linux_id" "scripts/test-pr-check.sh"
blacksmith testbox run --id "$windows_id" "pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/test-pr-check-windows.ps1"
```

## Notes

- The workflow files must be merged before GitHub can dispatch them via `workflow_dispatch`.
- `blacksmith testbox run` syncs your local tracked and unignored files before running the command.
- If you change dependency manifests, the scripts run `pnpm install` again inside the Testbox.
- The Linux Testbox intentionally does not cover the Windows CLI row; use the Windows Testbox for that.
- Stop Testboxes when you are finished:

```bash
blacksmith testbox stop --id <testbox-id>
```
