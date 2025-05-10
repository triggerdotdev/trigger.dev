# Prisma 6.6+ Compatibility Test

This reference project tests the compatibility of the Trigger.dev build system with Prisma 6.6+.

## Structure

- Uses Prisma 6.6.0
- Schema folder structure (`prisma/schema/schema.prisma`)
- Custom output path specified (`output = "../generated/client"`)

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

This test verifies that the `--schema` flag works correctly with Prisma 6.6+ when using schema folders and custom output paths.
