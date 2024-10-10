set -ex
npx prisma migrate deploy --schema internal-packages/database/prisma/schema.prisma
node ./server.js