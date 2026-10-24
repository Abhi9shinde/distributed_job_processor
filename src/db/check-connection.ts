import { prisma } from "./prisma.js";

async function main() {
  await prisma.$connect();

  const result = await prisma.job.count();

  console.log("PostgreSQL connected successfully.");
  console.log(`Jobs currently in database: ${result}`);
}

main()
  .catch((error: unknown) => {
    console.error("Database connection failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
