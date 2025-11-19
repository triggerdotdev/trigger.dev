# @trigger.dev/build

## 4.1.1

### Patch Changes

- The `prismaExtension` has been completely redesigned to support multiple Prisma versions and deployment strategies. This update introduces **three distinct modes** to handle the evolving Prisma ecosystem, from legacy setups to the upcoming Prisma 7. ([#2689](https://github.com/triggerdotdev/trigger.dev/pull/2689))

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

  ***

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

  ***

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

  ***

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

  ***

  ## Version Compatibility Matrix

  | Prisma Version   | Recommended Mode      | Notes                                        |
  | ---------------- | --------------------- | -------------------------------------------- |
  | < 5.0            | Legacy                | Older Prisma versions                        |
  | 5.0 - 6.15       | Legacy                | Standard Prisma setup                        |
  | 6.7+             | Legacy                | Multi-file schema support                    |
  | 6.16+            | Engine-Only or Modern | Modern mode requires `engineType = "client"` |
  | 6.20+ (7.0 beta) | Modern                | Prisma 7 with new architecture               |

  ***

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

- Updated dependencies:
  - `@trigger.dev/core@4.1.1`

## 4.1.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.1.0`

## 4.0.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.7`

## 4.0.6

### Patch Changes

- Fix broken audiowaveform extension ([#2643](https://github.com/triggerdotdev/trigger.dev/pull/2643))
- Updated dependencies:
  - `@trigger.dev/core@4.0.6`

## 4.0.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.5`

## 4.0.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.4`

## 4.0.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.3`

## 4.0.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.2`

## 4.0.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.1`

## 4.0.0

### Major Changes

- Trigger.dev v4 release. Please see our upgrade to v4 docs to view the full changelog: https://trigger.dev/docs/upgrade-to-v4 ([#1869](https://github.com/triggerdotdev/trigger.dev/pull/1869))

### Patch Changes

- Run Engine 2.0 (alpha) ([#1575](https://github.com/triggerdotdev/trigger.dev/pull/1575))
- syncVercelEnvVars() fix for syncing the wrong preview branch env vars ([#2141](https://github.com/triggerdotdev/trigger.dev/pull/2141))
- Add Lightpanda extension ([#2192](https://github.com/triggerdotdev/trigger.dev/pull/2192))
- - Improve playwright non-headless chrome installation ([#2347](https://github.com/triggerdotdev/trigger.dev/pull/2347))
  - Prevent spinner message duplication in narrow terminals
- Add ffmpeg v7 support to existing extension: `ffmpeg({ version: "7" })` ([#1777](https://github.com/triggerdotdev/trigger.dev/pull/1777))
- Add playwright extension ([#1764](https://github.com/triggerdotdev/trigger.dev/pull/1764))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0`

## 4.0.0-v4-beta.28

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.28`

## 4.0.0-v4-beta.27

### Patch Changes

- - Improve playwright non-headless chrome installation ([#2347](https://github.com/triggerdotdev/trigger.dev/pull/2347))
  - Prevent spinner message duplication in narrow terminals
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.27`

## 4.0.0-v4-beta.26

### Patch Changes

- Add Lightpanda extension ([#2192](https://github.com/triggerdotdev/trigger.dev/pull/2192))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.26`

## 4.0.0-v4-beta.25

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.25`

## 4.0.0-v4-beta.24

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.24`

## 4.0.0-v4-beta.23

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.23`

## 4.0.0-v4-beta.22

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.22`

## 4.0.0-v4-beta.21

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.21`

## 4.0.0-v4-beta.20

### Patch Changes

- syncVercelEnvVars() fix for syncing the wrong preview branch env vars ([#2141](https://github.com/triggerdotdev/trigger.dev/pull/2141))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.20`

## 4.0.0-v4-beta.19

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.19`

## 4.0.0-v4-beta.18

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.18`

## 4.0.0-v4-beta.17

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.17`

## 4.0.0-v4-beta.16

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.16`

## 4.0.0-v4-beta.15

### Patch Changes

- Add ffmpeg v7 support to existing extension: `ffmpeg({ version: "7" })` ([#1777](https://github.com/triggerdotdev/trigger.dev/pull/1777))
- Add playwright extension ([#1764](https://github.com/triggerdotdev/trigger.dev/pull/1764))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.15`

## 4.0.0-v4-beta.14

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.14`

## 4.0.0-v4-beta.13

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.13`

## 4.0.0-v4-beta.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.12`

## 4.0.0-v4-beta.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.11`

## 4.0.0-v4-beta.10

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.10`

## 4.0.0-v4-beta.9

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.9`

## 4.0.0-v4-beta.8

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.8`

## 4.0.0-v4-beta.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.7`

## 4.0.0-v4-beta.6

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.6`

## 4.0.0-v4-beta.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.5`

## 4.0.0-v4-beta.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.4`

## 4.0.0-v4-beta.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.3`

## 4.0.0-v4-beta.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.2`

## 4.0.0-v4-beta.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.1`

## 4.0.0-v4-beta.0

### Major Changes

- Trigger.dev v4 release. Please see our upgrade to v4 docs to view the full changelog: https://trigger.dev/docs/upgrade-to-v4 ([#1869](https://github.com/triggerdotdev/trigger.dev/pull/1869))

### Patch Changes

- Run Engine 2.0 (alpha) ([#1575](https://github.com/triggerdotdev/trigger.dev/pull/1575))
- Updated dependencies:
  - `@trigger.dev/core@4.0.0-v4-beta.0`

## 3.3.17

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.17`

## 3.3.16

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.16`

## 3.3.15

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.15`

## 3.3.14

### Patch Changes

- Missing construction option in `AudioWaveformExtension` ([#1684](https://github.com/triggerdotdev/trigger.dev/pull/1684))
- Updated dependencies:
  - `@trigger.dev/core@3.3.14`

## 3.3.13

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.13`

## 3.3.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.12`

## 3.3.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.11`

## 3.3.10

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.10`

## 3.3.9

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.9`

## 3.3.8

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.8`

## 3.3.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.7`

## 3.3.6

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.6`

## 3.3.5

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.5`

## 3.3.4

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.4`

## 3.3.3

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.3`

## 3.3.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.2`

## 3.3.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.1`

## 3.3.0

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.3.0`

## 3.2.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.2.2`

## 3.2.1

### Patch Changes

- Upgrade zod to latest (3.23.8) ([#1484](https://github.com/triggerdotdev/trigger.dev/pull/1484))
- Realtime streams ([#1470](https://github.com/triggerdotdev/trigger.dev/pull/1470))
- Updated dependencies:
  - `@trigger.dev/core@3.2.1`

## 3.2.0

### Minor Changes

- Add teamId option to vercelSyncEnvVars ([#1463](https://github.com/triggerdotdev/trigger.dev/pull/1463))

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.2.0`

## 3.1.2

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.2`

## 3.1.1

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.1.1`

## 3.1.0

### Patch Changes

- Added a Vercel sync env vars extension. Given a Vercel projectId and access token it will sync Vercel env vars when deploying Trigger.dev tasks. ([#1425](https://github.com/triggerdotdev/trigger.dev/pull/1425))
- Updated dependencies:
  - `@trigger.dev/core@3.1.0`

## 3.0.13

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.13`

## 3.0.12

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.12`

## 3.0.11

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.11`

## 3.0.10

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.10`

## 3.0.9

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.9`

## 3.0.8

### Patch Changes

- Puppeteer extension: set the PUPPETEER_EXECUTABLE_PATH env var ([#1350](https://github.com/triggerdotdev/trigger.dev/pull/1350))
- Updated dependencies:
  - `@trigger.dev/core@3.0.8`

## 3.0.7

### Patch Changes

- Updated dependencies:
  - `@trigger.dev/core@3.0.7`

## 3.0.6

### Patch Changes

- b4be73655: prismaExtension fixes for #1325 and #1327
- c65d4822b: Feat: puppeteer build extension
- 1f5bcc73b: fix: audiowaveform extension
- Updated dependencies [4e0bc485a]
  - @trigger.dev/core@3.0.6

## 3.0.5

### Patch Changes

- @trigger.dev/core@3.0.5

## 3.0.4

### Patch Changes

- Updated dependencies [4adc773c7]
  - @trigger.dev/core@3.0.4

## 3.0.3

### Patch Changes

- 3d53d4c08: Strip out TRIGGER\_ keys when using syncEnvVars, to prevent deploy errors
- Updated dependencies [3d53d4c08]
  - @trigger.dev/core@3.0.3

## 3.0.2

### Patch Changes

- @trigger.dev/core@3.0.2

## 3.0.1

### Patch Changes

- 3aa581179: Fixing false-positive package version mismatches
- Updated dependencies [3aa581179]
  - @trigger.dev/core@3.0.1

## 3.0.0

### Major Changes

- cf13fbdf3: Release 3.0.0

### Patch Changes

- 8c690a960: Make sure BuildManifest is exported from @trigger.dev/build
- 8578c9b28: Fix issue with emitDecoratorMetadata and tsconfigs with extends
- cf13fbdf3: Add ffmpeg build extension
- 8578c9b28: Add support for prisma typed sql
- e30beb779: Added support for custom esbuild plugins
- cf13fbdf3: Add aptGet build extension to easily add system packages to install
- f9ec66c56: Added new @trigger.dev/build package that currently has all the build extensions
- Updated dependencies [ed2a26c86]
- Updated dependencies [c702d6a9c]
- Updated dependencies [9882d66f8]
- Updated dependencies [b66d5525e]
- Updated dependencies [e3db25739]
- Updated dependencies [9491a1649]
- Updated dependencies [1670c4c41]
- Updated dependencies [b271742dc]
- Updated dependencies [cf13fbdf3]
- Updated dependencies [dbda820a7]
- Updated dependencies [4986bfda2]
- Updated dependencies [eb6012628]
- Updated dependencies [f9ec66c56]
- Updated dependencies [f7d32b83b]
- Updated dependencies [09413a62a]
- Updated dependencies [3a1b0c486]
- Updated dependencies [203e00208]
- Updated dependencies [b4f9b70ae]
- Updated dependencies [1b90ffbb8]
- Updated dependencies [5cf90da72]
- Updated dependencies [9af2570da]
- Updated dependencies [7ea8532cc]
- Updated dependencies [1477a2e30]
- Updated dependencies [4f95c9de4]
- Updated dependencies [83dc87155]
- Updated dependencies [d490bc5cb]
- Updated dependencies [e3cf456c6]
- Updated dependencies [14c2bdf89]
- Updated dependencies [9491a1649]
- Updated dependencies [0ed93a748]
- Updated dependencies [8578c9b28]
- Updated dependencies [0e77e7ef7]
- Updated dependencies [e417aca87]
- Updated dependencies [568da0178]
- Updated dependencies [c738ef39c]
- Updated dependencies [ece6ca678]
- Updated dependencies [f854cb90e]
- Updated dependencies [0e919f56f]
- Updated dependencies [44e1b8754]
- Updated dependencies [55264657d]
- Updated dependencies [6d9dfbc75]
- Updated dependencies [e337b2165]
- Updated dependencies [719c0a0b9]
- Updated dependencies [4986bfda2]
- Updated dependencies [e30beb779]
- Updated dependencies [68d32429b]
- Updated dependencies [374edef02]
- Updated dependencies [e04d44866]
- Updated dependencies [26093896d]
- Updated dependencies [55d1f8c67]
- Updated dependencies [c405ae711]
- Updated dependencies [9e5382951]
- Updated dependencies [b68012f81]
- Updated dependencies [098932ea9]
- Updated dependencies [68d32429b]
- Updated dependencies [9835f4ec5]
- Updated dependencies [3f8b6d8fc]
- Updated dependencies [fde939a30]
- Updated dependencies [1281d40e4]
- Updated dependencies [ba71f959e]
- Updated dependencies [395abe1b9]
- Updated dependencies [03b104a3d]
- Updated dependencies [f93eae300]
- Updated dependencies [5ae3da6b4]
- Updated dependencies [c405ae711]
- Updated dependencies [34ca7667d]
- Updated dependencies [8ba998794]
- Updated dependencies [62c9a5b71]
- Updated dependencies [392453e8a]
- Updated dependencies [8578c9b28]
- Updated dependencies [6a379e4e9]
- Updated dependencies [f854cb90e]
- Updated dependencies [584c7da5d]
- Updated dependencies [4986bfda2]
- Updated dependencies [e69ffd314]
- Updated dependencies [b68012f81]
- Updated dependencies [39885a427]
- Updated dependencies [8578c9b28]
- Updated dependencies [e69ffd314]
- Updated dependencies [8578c9b28]
- Updated dependencies [f04041744]
- Updated dependencies [d934feb02]
  - @trigger.dev/core@3.0.0
