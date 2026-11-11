import 'dotenv/config';
import { loadConfig } from '../src/config/env.js';
import { disconnectPrismaClient, getPrismaClient } from '../src/database/prisma.js';

const config = loadConfig();
const prisma = getPrismaClient(config.DATABASE_URL);

const sports = [
  { code: 'futsal', name: 'Futsal' },
  { code: 'football', name: 'Football' },
  { code: 'cricket', name: 'Cricket' },
  { code: 'padel', name: 'Padel' },
  { code: 'badminton', name: 'Badminton' },
  { code: 'basketball', name: 'Basketball' },
];

const amenities = ['Changing rooms', 'Washrooms', 'Floodlights', 'Seating', 'Cafe', 'Showers'];

async function main(): Promise<void> {
  for (const sport of sports) {
    await prisma.sport.upsert({
      where: { code: sport.code },
      update: { name: sport.name, isActive: true },
      create: sport,
    });
  }

  for (const name of amenities) {
    await prisma.amenity.upsert({ where: { name }, update: { isActive: true }, create: { name } });
  }

  console.info(`Seeded ${sports.length} sports and ${amenities.length} amenities.`);
}

main()
  .catch(error => {
    const message = error instanceof Error ? error.message : 'Unknown seed error';
    console.error(`Reference-data seed failed: ${message}`);
    process.exitCode = 1;
  })
  .finally(async () => disconnectPrismaClient());
