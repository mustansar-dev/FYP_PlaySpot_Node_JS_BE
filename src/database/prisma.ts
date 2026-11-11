import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

let prisma: PrismaClient | undefined;

/** One Prisma pool per process; initialize after validating the environment. */
export function getPrismaClient(connectionString: string): PrismaClient {
  if (!prisma) {
    const adapter = new PrismaPg({ connectionString, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 10_000 });
    prisma = new PrismaClient({ adapter });
  }
  return prisma;
}

export async function disconnectPrismaClient(): Promise<void> {
  if (!prisma) return;
  await prisma.$disconnect();
  prisma = undefined;
}
