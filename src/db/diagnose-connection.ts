import { prisma } from "./prisma.js";

async function main() {
  for (let i = 1; i <= 10; i++) {
    const start = performance.now();

    await prisma.$queryRaw`SELECT 1`;

    const duration = performance.now() - start;

    console.log(`Query ${i}: ${duration.toFixed(2)} ms`);
  }
}

main()
  .catch(console.error)
  .finally(async () => {
    await prisma.$disconnect();
  });
