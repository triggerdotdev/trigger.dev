# OSOP Workflow Example — Trigger.dev Background Job Pipeline

This directory contains a portable workflow definition for a **background job pipeline** pattern, written in [OSOP](https://github.com/osop-org/osop-spec) format.

## What is OSOP?

**OSOP** (Open Standard for Orchestration Protocols) is a YAML-based workflow standard that describes multi-step processes — including background jobs, event-driven pipelines, and AI agent workflows — in a portable, tool-agnostic format. Think of it as "OpenAPI for workflows."

- Any tool can read and render an `.osop` file
- Workflows become shareable, diffable, and version-controllable
- No vendor lock-in: the same workflow runs across different orchestration engines

## Files

| File | Description |
|------|-------------|
| `background-job-pipeline.osop` | Long-running background job: receive request, validate, AI processing with retry, store results, webhook callback, and cleanup |

## How to use

You can read the `.osop` file as plain YAML. To validate or visualize it:

```bash
# Validate the workflow
pip install osop
osop validate background-job-pipeline.osop

# Generate a visual report
npx osop-report background-job-pipeline.osop -o report.html
```

## Learn more

- [OSOP Spec](https://github.com/osop-org/osop-spec) — Full specification
- [OSOP Examples](https://github.com/osop-org/osop-examples) — 30+ workflow templates
- [Trigger.dev Documentation](https://trigger.dev/docs) — Trigger.dev platform docs
