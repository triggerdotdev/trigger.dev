# Core Package

`@trigger.dev/core` - shared types, schemas, and utilities used across the SDK, CLI, and webapp.

## Critical Import Rule

**NEVER import the root** (`@trigger.dev/core`). Always use subpath imports:

```typescript
import { ... } from "@trigger.dev/core/v3";
import { ... } from "@trigger.dev/core/v3/utils";
import { ... } from "@trigger.dev/core/logger";
import { ... } from "@trigger.dev/core/schemas";
```

## Cross-Cutting Impact

Changes here affect both the customer-facing SDK and the server-side webapp. Exercise caution - breaking changes can affect deployed user tasks and the platform simultaneously.

## Contents

- Protocol definitions and message types
- API schemas (Zod validation)
- Shared constants and enums
- Utility functions used across packages
