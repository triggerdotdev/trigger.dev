# Prisma Extension Update - Changelog

## Overview

The `prismaExtension` has been completely redesigned to support multiple Prisma versions and deployment strategies. This update introduces **three distinct modes** to handle the evolving Prisma ecosystem, from legacy setups to the upcoming Prisma 7.

## Breaking Changes

⚠️ **MIGRATION REQUIRED**: The `prismaExtension` now requires an explicit `mode` parameter. Existing configurations without a `mode` will need to be updated.

### Before (Old API)

```ts
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

extensions: [
  prismaExtension({
    schema: "prisma/schema.prisma",
    migrate: true,
    typedSql: true,
    directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
  }),
];
```

### After (New API)

```ts
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

extensions: [
  prismaExtension({
    mode: "legacy", // ← MODE IS NOW REQUIRED
    schema: "prisma/schema.prisma",
    migrate: true,
    typedSql: true,
    directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
  }),
];
```

## New Features

### 1. Legacy Mode

**Use when:** You're using Prisma 6.x or earlier with the `prisma-client-js` provider.

**Features:**

- Automatic `prisma generate` during deployment
- Supports single-file schemas (`prisma/schema.prisma`)
- Supports multi-file schemas (Prisma 6.7+, directory-based schemas)
- Migration support with `migrate: true`
- TypedSQL support with `typedSql: true`
- Custom generator selection
- Handles Prisma client versioning automatically

**Schema Configuration:**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["typedSql"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```

**Extension Configuration:**

```ts
// Single-file schema
prismaExtension({
  mode: "legacy",
  schema: "prisma/schema.prisma",
  migrate: true,
  typedSql: true,
  directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
});

// Multi-file schema (Prisma 6.7+)
prismaExtension({
  mode: "legacy",
  schema: "./prisma", // ← Point to directory
  migrate: true,
  typedSql: true,
  directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
});
```

**Tested Versions:**

- Prisma 6.14.0 ✅
- Prisma 6.7.0+ (multi-file schema support) ✅
- Prisma 5.x ✅

---

### 2. Engine-Only Mode

**Use when:** You have a custom Prisma client output path and want to manage `prisma generate` yourself.

**Features:**

- Only installs Prisma engine binaries (no client generation)
- Automatic version detection from `@prisma/client`
- Manual override of version and binary target
- Minimal overhead - just ensures engines are available
- You control when and how `prisma generate` runs

**Schema Configuration:**

```prisma
generator client {
  provider      = "prisma-client-js"
  output        = "../src/generated/prisma"
  binaryTargets = ["native", "linux-arm64-openssl-3.0.x"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```

**Extension Configuration:**

```ts
// Auto-detect version
prismaExtension({
  mode: "engine-only",
});

// Explicit version (recommended for reproducible builds)
prismaExtension({
  mode: "engine-only",
  version: "6.19.0",
  binaryTarget: "linux-arm64-openssl-3.0.x", // Default: "debian-openssl-3.0.x"
});
```

**Important Notes:**

- You **must** run `prisma generate` yourself (typically in a prebuild script)
- Your schema **must** include the correct `binaryTargets` for deployment
- The extension sets `PRISMA_QUERY_ENGINE_LIBRARY` and `PRISMA_QUERY_ENGINE_SCHEMA_ENGINE` environment variables

**package.json Example:**

```json
{
  "scripts": {
    "prebuild": "prisma generate",
    "dev": "trigger dev",
    "deploy": "trigger deploy"
  }
}
```

**Tested Versions:**

- Prisma 6.19.0 ✅
- Prisma 6.16.0+ ✅

---

### 3. Modern Mode

**Use when:** You're using Prisma 6.16+ with the new `prisma-client` provider (with `engineType = "client"`) or preparing for Prisma 7.

**Features:**

- Designed for the new Prisma architecture
- Zero configuration required
- Automatically marks `@prisma/client` as external
- Works with Prisma 7 beta releases
- You manage client generation (like engine-only mode)

**Schema Configuration (Prisma 6.16+ with engineType):**

```prisma
generator client {
  provider        = "prisma-client"
  output          = "../src/generated/prisma"
  engineType      = "client"
  previewFeatures = ["views"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```

**Schema Configuration (Prisma 7):**

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

**Extension Configuration:**

```ts
prismaExtension({
  mode: "modern",
});
```

**Prisma Config (Prisma 7):**

```ts
// prisma.config.ts
import { defineConfig, env } from "prisma/config";
import "dotenv/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

**Important Notes:**

- You **must** run `prisma generate` yourself
- Requires Prisma 6.16.0+ or Prisma 7 beta
- The new `prisma-client` provider generates plain TypeScript (no Rust binaries in some configurations)
- Requires database adapters (e.g., `@prisma/adapter-pg` for PostgreSQL)

**Tested Versions:**

- Prisma 6.16.0 with `engineType = "client"` ✅
- Prisma 6.20.0-integration-next.8 (Prisma 7 beta) ✅

---

## Migration Guide

### From Old prismaExtension to Legacy Mode

If you were using the previous `prismaExtension`, migrate to **Legacy Mode**:

```ts
// Old
prismaExtension({
  schema: "prisma/schema.prisma",
  migrate: true,
});

// New
prismaExtension({
  mode: "legacy", // ← Add this
  schema: "prisma/schema.prisma",
  migrate: true,
});
```

### From Managing Your Own Prisma Setup

If you previously handled Prisma generation yourself and just needed engine binaries, use **Engine-Only Mode**:

```ts
prismaExtension({
  mode: "engine-only",
  version: "6.19.0", // Match your @prisma/client version
});
```

### Preparing for Prisma 7

If you want to adopt the new Prisma architecture, use **Modern Mode**:

1. Update your schema to use `prisma-client` provider
2. Add database adapters to your dependencies
3. Configure the extension:

```ts
prismaExtension({
  mode: "modern",
});
```

---

## Version Compatibility Matrix

| Prisma Version   | Recommended Mode      | Notes                                        |
| ---------------- | --------------------- | -------------------------------------------- |
| < 5.0            | Legacy                | Older Prisma versions                        |
| 5.0 - 6.15       | Legacy                | Standard Prisma setup                        |
| 6.7+             | Legacy                | Multi-file schema support                    |
| 6.16+            | Engine-Only or Modern | Modern mode requires `engineType = "client"` |
| 6.20+ (7.0 beta) | Modern                | Prisma 7 with new architecture               |

---

## Multi-File Schema Support (Prisma 6.7+)

Prisma 6.7 introduced support for splitting your schema across multiple files in a directory structure.

**Example Structure:**

```
prisma/
├── schema.prisma (main file with generator/datasource)
├── models/
│   ├── users.prisma
│   └── posts.prisma
└── sql/
    └── getUserByEmail.sql
```

**Configuration:**

```ts
prismaExtension({
  mode: "legacy",
  schema: "./prisma", // ← Point to directory instead of file
  migrate: true,
  typedSql: true,
});
```

**package.json:**

```json
{
  "prisma": {
    "schema": "./prisma"
  }
}
```

---

## TypedSQL Support

TypedSQL is available in **Legacy Mode** for Prisma 5.19.0+ with the `typedSql` preview feature.

**Schema Configuration:**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["typedSql"]
}
```

**Extension Configuration:**

```ts
prismaExtension({
  mode: "legacy",
  schema: "prisma/schema.prisma",
  typedSql: true, // ← Enable TypedSQL
});
```

**Usage in Tasks:**

```ts
import { db, sql } from "./db";

const users = await db.$queryRawTyped(sql.getUserByEmail("user@example.com"));
```

---

## Database Migration Support

Migrations are supported in **Legacy Mode** only.

**Extension Configuration:**

```ts
prismaExtension({
  mode: "legacy",
  schema: "prisma/schema.prisma",
  migrate: true, // ← Run migrations on deployment
  directUrlEnvVarName: "DATABASE_URL_UNPOOLED", // For connection pooling
});
```

**What This Does:**

1. Copies `prisma/migrations/` to the build output
2. Runs `prisma migrate deploy` before generating the client
3. Uses the `directUrlEnvVarName` for unpooled connections (required for migrations)

---

## Binary Targets and Deployment

### Trigger.dev Cloud

The default binary target is `linux-arm64-openssl-3.0.x` for Trigger.dev Cloud deployments.

**Legacy Mode:** Handled automatically ✅

**Engine-Only Mode:** Specify in schema

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-arm64-openssl-3.0.x"]
}
```

**Modern Mode:** Handled by database adapters ✅

### Self-Hosted / Local Deployment

For local deployments (e.g., Docker on macOS), you may need a different binary target:

```ts
prismaExtension({
  mode: "engine-only",
  version: "6.19.0",
  binaryTarget: "darwin-arm64", // For macOS ARM64
});
```

---

## Environment Variables

### Required Variables

All modes:

- `DATABASE_URL`: Your database connection string

Legacy mode with migrations:

- `DATABASE_URL_UNPOOLED` (or your custom `directUrlEnvVarName`): Direct database connection for migrations

### Auto-Set Variables

Engine-Only mode sets:

- `PRISMA_QUERY_ENGINE_LIBRARY`: Path to the query engine
- `PRISMA_QUERY_ENGINE_SCHEMA_ENGINE`: Path to the schema engine

---

## Troubleshooting

### "Could not find Prisma schema"

**Legacy Mode:** Ensure the `schema` path is correct relative to your working directory.

```ts
// If your project structure is:
// project/
//   trigger.config.ts
//   prisma/
//     schema.prisma

prismaExtension({
  mode: "legacy",
  schema: "./prisma/schema.prisma", // Correct
  // schema: "prisma/schema.prisma", // Also works
});
```

### "Could not determine @prisma/client version"

**Legacy Mode:** Ensure `@prisma/client` is in your dependencies and used in your code.

**Engine-Only Mode:** Specify the version explicitly:

```ts
prismaExtension({
  mode: "engine-only",
  version: "6.19.0", // ← Add explicit version
});
```

### "Binary target not found"

**Engine-Only Mode:** Make sure your schema includes the deployment binary target:

```prisma
generator client {
  provider      = "prisma-client-js"
  binaryTargets = ["native", "linux-arm64-openssl-3.0.x"]
}
```

### "Module not found: @prisma/client/sql"

**Legacy Mode:** Make sure `typedSql: true` is set and you have Prisma 5.19.0+:

```ts
prismaExtension({
  mode: "legacy",
  schema: "prisma/schema.prisma",
  typedSql: true, // ← Required for TypedSQL
});
```

---

## Complete Examples

### Example 1: Standard Prisma 6 Setup (Legacy Mode)

**prisma/schema.prisma:**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["typedSql"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```

**trigger.config.ts:**

```ts
import { defineConfig } from "@trigger.dev/sdk";
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF!,
  build: {
    extensions: [
      prismaExtension({
        mode: "legacy",
        schema: "prisma/schema.prisma",
        migrate: true,
        typedSql: true,
        directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
      }),
    ],
  },
});
```

---

### Example 2: Multi-File Schema (Legacy Mode)

**prisma/schema.prisma:**

```prisma
generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["typedSql"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```

**prisma/models/users.prisma:**

```prisma
model User {
  id        String  @id @default(cuid())
  email     String  @unique
  name      String?
  posts     Post[]
}
```

**prisma/models/posts.prisma:**

```prisma
model Post {
  id        String   @id @default(cuid())
  title     String
  content   String
  authorId  String
  author    User     @relation(fields: [authorId], references: [id])
}
```

**package.json:**

```json
{
  "prisma": {
    "schema": "./prisma"
  }
}
```

**trigger.config.ts:**

```ts
prismaExtension({
  mode: "legacy",
  schema: "./prisma", // ← Directory, not file
  migrate: true,
  typedSql: true,
  directUrlEnvVarName: "DATABASE_URL_UNPOOLED",
});
```

---

### Example 3: Custom Output Path (Engine-Only Mode)

**prisma/schema.prisma:**

```prisma
generator client {
  provider      = "prisma-client-js"
  output        = "../src/generated/prisma"
  binaryTargets = ["native", "linux-arm64-openssl-3.0.x"]
}

datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DATABASE_URL_UNPOOLED")
}
```

**package.json:**

```json
{
  "scripts": {
    "generate": "prisma generate",
    "dev": "pnpm generate && trigger dev",
    "deploy": "trigger deploy"
  }
}
```

**trigger.config.ts:**

```ts
prismaExtension({
  mode: "engine-only",
  version: "6.19.0",
  binaryTarget: "linux-arm64-openssl-3.0.x",
});
```

**src/db.ts:**

```ts
import { PrismaClient } from "./generated/prisma/client.js";

export const db = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
});
```

---

### Example 4: Prisma 7 Beta (Modern Mode)

**prisma/schema.prisma:**

```prisma
generator client {
  provider = "prisma-client"
  output   = "../src/generated/prisma"
}

datasource db {
  provider = "postgresql"
}
```

**prisma.config.ts:**

```ts
import { defineConfig, env } from "prisma/config";
import "dotenv/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});
```

**package.json:**

```json
{
  "dependencies": {
    "@prisma/client": "6.20.0-integration-next.8",
    "@prisma/adapter-pg": "6.20.0-integration-next.8"
  },
  "scripts": {
    "generate": "prisma generate",
    "dev": "pnpm generate && trigger dev",
    "deploy": "trigger deploy"
  }
}
```

**trigger.config.ts:**

```ts
prismaExtension({
  mode: "modern",
});
```

**src/db.ts:**

```ts
import { PrismaClient } from "./generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL!,
});

export const db = new PrismaClient({ adapter });
```

---

## Additional Options

### Legacy Mode Options

```ts
type PrismaLegacyModeExtensionOptions = {
  mode: "legacy";
  schema: string; // Path to schema file or directory
  migrate?: boolean; // Run migrations during build
  version?: string; // Override detected version
  typedSql?: boolean; // Enable TypedSQL support
  clientGenerator?: string; // Specific generator name
  directUrlEnvVarName?: string; // Custom direct URL env var name
};
```

### Engine-Only Mode Options

```ts
type PrismaEngineOnlyModeExtensionOptions = {
  mode: "engine-only";
  version?: string; // Prisma version (auto-detected if omitted)
  binaryTarget?: string; // Binary target (default: "debian-openssl-3.0.x")
  silent?: boolean; // Suppress progress messages
};
```

### Modern Mode Options

```ts
type PrismaEngineModernModeExtensionOptions = {
  mode: "modern";
  // No additional options
};
```

---

## Resources

- [Prisma Documentation](https://www.prisma.io/docs)
- [Multi-File Schema (Prisma 6.7+)](https://www.prisma.io/docs/orm/prisma-schema/overview/location#multi-file-prisma-schema)
- [TypedSQL (Prisma 5.19+)](https://www.prisma.io/docs/orm/prisma-client/using-raw-sql/typedsql)
- [Prisma 7 Beta Documentation](https://www.prisma.io/docs)
- [Trigger.dev Prisma Guide](https://trigger.dev/docs/guides/frameworks/prisma)

---

## Summary

The new `prismaExtension` provides three modes to support the full spectrum of Prisma usage:

1. **Legacy Mode** - Full-featured mode for Prisma 6 and earlier
2. **Engine-Only Mode** - Minimal mode for custom setups
3. **Modern Mode** - Future-ready mode for Prisma 6.16+ and Prisma 7

Choose the mode that best fits your Prisma setup and deployment requirements.
