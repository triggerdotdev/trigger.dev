const { PrismaClient } = require("@prisma/client");

async function main() {
  try {
    const prisma = new PrismaClient();
    console.log("Connected to Prisma 5.0.0");
    
    const user = await prisma.user.create({
      data: {
        email: "test@example.com",
        name: "Test User"
      }
    });
    
    console.log("Created user:", user);
    
    await prisma.$disconnect();
    console.log("Test completed successfully");
  } catch (error) {
    console.error("Test failed:", error);
    process.exit(1);
  }
}

main();
