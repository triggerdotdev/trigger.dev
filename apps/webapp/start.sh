set -ex
npx prisma migrate deploy --schema packages/database/prisma/schema.prisma
node ./server.js