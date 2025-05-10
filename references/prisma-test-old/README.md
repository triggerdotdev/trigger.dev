# Prisma 5.x Compatibility Test

This reference project tests the compatibility of the Trigger.dev build system with Prisma 5.x.

## Structure

- Uses Prisma 5.0.0
- Schema folder structure (`prisma/schema/schema.prisma`)
- No output path specified (uses default node_modules location)

## Testing

1. Install dependencies:
   ```
   npm install
   ```

2. Generate Prisma client:
   ```
   npm run generate:prisma
   ```

3. Run the test:
   ```
   npm test
   ```

This test verifies that the `--schema` flag works correctly with Prisma 5.x when using schema folders.
