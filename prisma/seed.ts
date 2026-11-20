import 'dotenv/config';
import { loadConfig } from '../src/config/env.js';
import { disconnectPrismaClient, getPrismaClient } from '../src/database/prisma.js';
import { AMENITIES_CATALOG, SPORTS_CATALOG } from '../src/config/referenceData.js';

const config = loadConfig();
// Reference catalog writes use the DDL-capable migration role. API traffic must
// continue to use the restricted DATABASE_URL runtime role.
const prisma = getPrismaClient(config.MIGRATOR_DATABASE_URL ?? config.DATABASE_URL);

async function main(): Promise<void> {
  for (const sport of SPORTS_CATALOG) {
    await prisma.sport.upsert({
      where: { code: sport.code },
      update: { name: sport.name, isActive: true },
      create: sport,
    });
  }

  for (const name of AMENITIES_CATALOG) {
    await prisma.amenity.upsert({ where: { name }, update: { isActive: true }, create: { name } });
  }

  console.info(`Seeded ${SPORTS_CATALOG.length} sports and ${AMENITIES_CATALOG.length} amenities.`);
}

main()
  .catch(error => {
    const message = error instanceof Error ? error.message : 'Unknown seed error';
    console.error(`Reference-data seed failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => disconnectPrismaClient());
