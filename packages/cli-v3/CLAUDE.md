# CLI Package

The `trigger.dev` CLI package, published as `trigger.dev` on npm. Executable: `trigger`.

## Dev vs Deploy

### Dev Mode (`src/dev/`)
Runs tasks locally in the user's Node.js process. No containers involved. Uses `src/dev/` for the dev command, connects to the local webapp for coordination.

### Deploy Mode (`src/deploy/`)
Bundles task code and builds Docker images for production:
1. **Bundle**: `src/build/` bundles worker code using the build system
2. **Archive**: `src/deploy/archiveContext.ts` packages files for deployment
3. **Build image**: `src/deploy/buildImage.ts` creates Docker images (local Docker/Depot or remote builds)
4. **Push**: Pushes image to registry, registers with webapp API

## Customer Task Images

Code in `src/entryPoints/` runs **inside customer containers** - this is a different runtime environment from the CLI itself. Changes here affect deployed task execution directly.

The build system (`src/build/`) uses the config from `trigger.config.ts` in user projects to determine what to bundle, which build extensions to apply, and how to structure the output.

## Commands

CLI command definitions live in `src/commands/`. Key commands:
- `dev.ts` - Local development mode
- `deploy.ts` - Production deployment
- `init.ts` - Project initialization
- `login.ts` - Authentication
- `promote.ts` - Deployment promotion

## MCP Server

`src/mcp/` provides an MCP server for AI-assisted task development.

## SDK Documentation Rules

The `rules/` directory at the repo root contains versioned SDK documentation that gets installed alongside customer projects. Update both `rules/` and `.claude/skills/trigger-dev-tasks/` when SDK features change.
