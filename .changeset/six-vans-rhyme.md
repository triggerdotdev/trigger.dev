---
"@trigger.dev/build": patch
---

The `prismaExtension` has been completely redesigned to support multiple Prisma versions and deployment strategies. This update introduces **three distinct modes** to handle the evolving Prisma ecosystem, from legacy setups to the upcoming Prisma 7.

**Highlights:**

- 🎯 Three modes: Legacy, Engine-Only, and Modern
- 🎉 **NEW:** Support for `prisma.config.ts` files (Legacy Mode)
- 🔍 **NEW:** Enhanced version detection with filesystem fallback

## Breaking Changes

⚠️ **MIGRATION REQUIRED**: The `prismaExtension` now requires an explicit `mode` parameter. Existing configurations without a `mode` will need to be updated.

**Note:** All other existing options remain backward compatible. The new `configFile` option is optional and doesn't affect existing setups using the `schema` option.

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
- **NEW:** Supports Prisma config files (`prisma.config.ts`) via `@prisma/config` package
- Migration support with `migrate: true`
- TypedSQL support with `typedSql: true`
- Custom generator selection
- Handles Prisma client versioning automatically (with filesystem fallback detection)
- Automatic extraction of schema and migrations paths from config files

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
  // Ensure the "debian-openssl-3.0.x" binary target is included for deployment to the trigger.dev cloud
  binaryTargets = ["native", "debian-openssl-3.0.x"]
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
});
```

**Important Notes:**

- You **must** run `prisma generate` yourself (typically in a prebuild script)
- Your schema **must** include the correct `binaryTargets` for deployment to the trigger.dev cloud. The binary target is `debian-openssl-3.0.x`.
- The extension sets `PRISMA_QUERY_ENGINE_LIBRARY` and `PRISMA_QUERY_ENGINE_SCHEMA_ENGINE` environment variables to the correct paths for the binary targets.

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
- Works with Prisma 7 beta releases & Prisma 7 when released
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
- The new `prisma-client` provider generates plain TypeScript (no Rust binaries)
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

## Prisma Config File Support (Prisma 6+)

**NEW:** Legacy Mode now supports loading configuration from a `prisma.config.ts` file using the official `@prisma/config` package.

**Use when:** You want to use Prisma's new config file format (Prisma 6+) to centralize your Prisma configuration.

**Benefits:**

- Single source of truth for Prisma configuration
- Automatic extraction of schema location and migrations path
- Type-safe configuration with TypeScript
- Works seamlessly with Prisma 7's config-first approach

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
    directUrl: env("DATABASE_URL_UNPOOLED"),
  },
});
```

**trigger.config.ts:**

```ts
import { prismaExtension } from "@trigger.dev/build/extensions/prisma";

prismaExtension({
  mode: "legacy",
  configFile: "./prisma.config.ts", // ← Use config file instead of schema
  migrate: true,
  directUrlEnvVarName: "DATABASE_URL_UNPOOLED", // For migrations
});
```

**What gets extracted:**

- `schema` - The schema file or directory path
- `migrations.path` - The migrations directory path (if specified)

**Note:** Either `schema` or `configFile` must be specified, but not both.

**When to use which:**

| Use `schema` option          | Use `configFile` option           |
| ---------------------------- | --------------------------------- |
| Standard Prisma setup        | Using Prisma 6+ with config files |
| Single or multi-file schemas | Preparing for Prisma 7            |
| No `prisma.config.ts` file   | Centralized configuration needed  |
| Simple setup                 | Want migrations path in config    |

