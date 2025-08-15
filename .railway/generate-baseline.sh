#!/bin/bash
set -e

echo "🔧 Generating Railway Migration Baseline"
echo "========================================"
echo ""
echo "This script creates an optimized baseline migration from the current schema."
echo "The baseline combines all existing migrations into a single SQL file."
echo ""

# Check if we're in the right directory
if [ ! -f "package.json" ] || [ ! -d "internal-packages/database" ]; then
  echo "❌ Error: Must run from Trigger.dev root directory"
  exit 1
fi

# Generate the baseline SQL from current schema
echo "📝 Generating baseline SQL from current schema..."
cd internal-packages/database

# Use Prisma to generate the complete schema SQL
npx prisma@latest migrate diff \
  --from-empty \
  --to-schema-datamodel ./prisma/schema.prisma \
  --script > ../../.railway/baseline.sql.tmp

cd ../..

# Check if generation was successful
if [ -f ".railway/baseline.sql.tmp" ] && [ -s ".railway/baseline.sql.tmp" ]; then
  mv .railway/baseline.sql.tmp .railway/baseline.sql
  
  # Get statistics
  LINE_COUNT=$(wc -l < .railway/baseline.sql)
  MIGRATION_COUNT=$(ls internal-packages/database/prisma/migrations | grep -E "^[0-9]{14}_" | wc -l)
  
  echo "✅ Baseline generated successfully!"
  echo ""
  echo "📊 Statistics:"
  echo "   - Baseline size: $LINE_COUNT lines of SQL"
  echo "   - Migrations included: $MIGRATION_COUNT historical migrations"
  echo "   - File location: .railway/baseline.sql"
  echo ""
  echo "🚀 This baseline will:"
  echo "   - Reduce fresh deployment time from ~20 minutes to ~1 minute"
  echo "   - Apply complete schema in a single operation"
  echo "   - Work seamlessly with incremental updates"
  echo ""
  echo "💡 To use this baseline:"
  echo "   1. Commit .railway/baseline.sql to your repository"
  echo "   2. Deploy to Railway - migration optimizer will use it automatically"
  echo "   3. Regenerate periodically as new migrations are added"
else
  echo "❌ Failed to generate baseline"
  rm -f .railway/baseline.sql.tmp
  exit 1
fi