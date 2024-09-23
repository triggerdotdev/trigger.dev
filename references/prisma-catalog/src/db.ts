import { PrismaClient } from "@prisma/client";
import { getUsersWithPosts } from "@prisma/client/sql";

export const prisma = new PrismaClient();

export { getUsersWithPosts };
