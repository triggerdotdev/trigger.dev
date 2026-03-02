# Documentation

Mintlify-based documentation site for Trigger.dev.

## Configuration

- Main config: `docs.json` - defines navigation, theme, metadata
- Navigation structure: `docs.json` -> `navigation.dropdowns` -> groups -> pages

## Writing Docs

Pages are MDX files. Frontmatter format:

```yaml
---
title: "Page Title"
description: "Brief description for SEO and previews"
sidebarTitle: "Short Title"  # Optional, shown in sidebar if different from title
---
```

## Adding a New Page

1. Create the MDX file in the appropriate directory
2. Add the page path to `docs.json` navigation (under the correct group)

## Mintlify Components

Use these components for structured content:

- `<Note>` - General notes
- `<Warning>` - Important warnings
- `<Info>` - Informational callouts
- `<Tip>` - Helpful tips
- `<CodeGroup>` - Multi-language/multi-file code examples
- `<Expandable>` - Collapsible content sections
- `<Steps>` / `<Step>` - Step-by-step instructions
- `<Card>` / `<CardGroup>` - Card layouts for navigation

## Code Examples

- Always import from `@trigger.dev/sdk` (never `@trigger.dev/sdk/v3`)
- Make code examples complete and runnable where possible
- Use language tags in code fences: `typescript`, `bash`, `json`

## Directory Structure

- `documentation/` - Core conceptual docs
- `guides/` - How-to guides
- `config/` - Configuration reference
- `deployment/` - Deployment guides
- `tasks/` - Task documentation
- `realtime/` - Real-time features
- `runs/` - Run management
- `images/` - Image assets
