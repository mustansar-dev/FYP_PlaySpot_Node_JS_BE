import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { loadConfig } from '../src/config/env.ts';
import { disconnectPrismaClient, getPrismaClient } from '../src/database/prisma.ts';

const config = loadConfig();
if (config.NODE_ENV === 'production') throw new Error('The demo marketplace seed is disabled in production.');
const prisma = getPrismaClient(config.MIGRATOR_DATABASE_URL ?? config.DATABASE_URL);
const DEMO_PASSWORD = 'PlaySpotDemo2026!';
const DAY = 86_400_000;

const vendorSeeds = [
  {
    name: 'Ahsan Malik', email: 'ahsan.malik@demo.playspot.invalid', phone: '+92-300-000-1001',
    businessName: 'Gulberg Sports Arena', city: 'Lahore', address: 'Main Boulevard Gulberg, Lahore',
    venueName: 'Gulberg Sports Arena', locationNote: 'Gulberg III', latitude: 31.5127, longitude: 74.3524,
    sport: 'Futsal', courtName: 'Futsal Court A', price: 6500, equipment: 'Futsal ball', equipmentPrice: 500,
    demoAccount: 'DEMO-ONLY-0001',
  },
  {
    name: 'Sana Iqbal', email: 'sana.iqbal@demo.playspot.invalid', phone: '+92-300-000-1002',
    businessName: 'Margalla Padel Club', city: 'Islamabad', address: 'F-7 Markaz, Islamabad',
    venueName: 'Margalla Padel Club', locationNote: 'F-7', latitude: 33.7215, longitude: 73.0572,
    sport: 'Padel', courtName: 'Padel Court 1', price: 8500, equipment: 'Padel racket', equipmentPrice: 800,
    demoAccount: 'DEMO-ONLY-0002',
  },
  {
    name: 'Bilal Ahmed', email: 'bilal.ahmed@demo.playspot.invalid', phone: '+92-300-000-1003',
    businessName: 'Clifton Cricket Nets', city: 'Karachi', address: 'Khayaban-e-Shahbaz, Karachi',
    venueName: 'Clifton Cricket Nets', locationNote: 'DHA Phase 6', latitude: 24.8138, longitude: 67.0611,
    sport: 'Cricket', courtName: 'Cricket Net 1', price: 5000, equipment: 'Cricket bat', equipmentPrice: 700,
    demoAccount: 'DEMO-ONLY-0003',
  },
];

const playerSeeds = [
  { name: 'Zoya Shah', email: 'zoya.shah@demo.playspot.invalid', sports: ['Futsal', 'Badminton'] },
  { name: 'Hamza Qureshi', email: 'hamza.qureshi@demo.playspot.invalid', sports: ['Futsal', 'Cricket'] },
  { name: 'Maryam Javed', email: 'maryam.javed@demo.playspot.invalid', sports: ['Padel', 'Badminton'] },
  { name: 'Usman Tariq', email: 'usman.tariq@demo.playspot.invalid', sports: ['Padel', 'Cricket'] },
  { name: 'Areeba Hassan', email: 'areeba.hassan@demo.playspot.invalid', sports: ['Cricket', 'Futsal'] },
  { name: 'Daniyal Raza', email: 'daniyal.raza@demo.playspot.invalid', sports: ['Badminton', 'Padel'] },
];

function pakistanDate(daysFromToday, hour = 16) {
  const shifted = new Date(Date.now() + daysFromToday * DAY + 5 * 60 * 60 * 1000);
  shifted.setUTCHours(hour, 0, 0, 0);
  return new Date(shifted.getTime() - 5 * 60 * 60 * 1000);
}

async function upsertPlayer(seed, passwordHash, sportsByName) {
  const user = await prisma.user.upsert({
    where: { email: seed.email },
    create: { role: 'PLAYER', name: seed.name, email: seed.email, passwordHash },
    update: { role: 'PLAYER', name: seed.name, status: 'ACTIVE', passwordHash },
    select: { id: true, name: true },
  });
  await prisma.userSport.deleteMany({ where: { userId: user.id } });
  await prisma.userSport.createMany({
    data: seed.sports.map(name => ({ userId: user.id, sportId: sportsByName.get(name).id })),
    skipDuplicates: true,
  });
  return user;
}

async function upsertVendor(seed, passwordHash, sportsByName) {
  const user = await prisma.user.upsert({
    where: { email: seed.email },
    create: { role: 'VENDOR', name: seed.name, email: seed.email, phone: seed.phone, passwordHash },
    update: { role: 'VENDOR', name: seed.name, phone: seed.phone, status: 'ACTIVE', passwordHash },
    select: { id: true, name: true },
  });
  const profile = await prisma.vendorProfile.upsert({
    where: { ownerUserId: user.id },
    create: { ownerUserId: user.id, businessName: seed.businessName, contactPhone: seed.phone, verificationStatus: 'APPROVED' },
    update: { businessName: seed.businessName, contactPhone: seed.phone, verificationStatus: 'APPROVED' },
  });
  let venue = await prisma.venue.findFirst({ where: { vendorProfileId: profile.id, name: seed.venueName } });
  const venueData = {
    vendorProfileId: profile.id, name: seed.venueName,
    description: `Demo listing for ${seed.venueName}. This is fictional PlaySpot sample data.`,
    address: seed.address, city: seed.city, locationNote: seed.locationNote,
    latitude: seed.latitude, longitude: seed.longitude, timeZone: 'Asia/Karachi',
    parkingAvailable: true, parkingSpaces: 20, published: true,
  };
  venue = venue
    ? await prisma.venue.update({ where: { id: venue.id }, data: venueData })
    : await prisma.venue.create({ data: venueData });
  await prisma.venueSport.createMany({ data: [{ venueId: venue.id, sportId: sportsByName.get(seed.sport).id }], skipDuplicates: true });

  let court = await prisma.court.findFirst({ where: { venueId: venue.id, name: seed.courtName } });
  const courtData = {
    venueId: venue.id, sportId: sportsByName.get(seed.sport).id, name: seed.courtName,
    widthMeters: 30, lengthMeters: 50, indoorOutdoor: 'OUTDOOR',
    surface: seed.sport === 'Cricket' ? 'Artificial turf' : 'Synthetic court',
    conditionRating: 5, hourlyPricePaisa: seed.price * 100, slotDurationMinutes: 60,
    openingTime: '09:00', closingTime: '22:00', availableDays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], isActive: true,
  };
  court = court
    ? await prisma.court.update({ where: { id: court.id }, data: courtData })
    : await prisma.court.create({ data: courtData });

  let equipment = await prisma.equipmentItem.findFirst({ where: { venueId: venue.id, name: seed.equipment } });
  const equipmentData = {
    venueId: venue.id, sportId: sportsByName.get(seed.sport).id,
    name: seed.equipment, priceMode: 'RENTAL', unitPricePaisa: seed.equipmentPrice * 100,
    quantityAvailable: 12, active: true,
  };
  if (equipment) await prisma.equipmentItem.update({ where: { id: equipment.id }, data: equipmentData });
  else await prisma.equipmentItem.create({ data: equipmentData });
  await prisma.vendorPaymentInstructions.upsert({
    where: { vendorProfileId: profile.id },
    create: {
      vendorProfileId: profile.id, accountTitle: `${seed.businessName} Demo Account`,
      bankName: 'PlaySpot Demo Bank (fictional)', accountNumber: seed.demoAccount,
      instructions: 'DEMO ONLY — do not transfer real money. This is fictional test information.', active: true,
    },
    update: {
      accountTitle: `${seed.businessName} Demo Account`, bankName: 'PlaySpot Demo Bank (fictional)',
      accountNumber: seed.demoAccount,
      instructions: 'DEMO ONLY — do not transfer real money. This is fictional test information.', active: true,
    },
  });
  return { user, profile, venue, court, sport: sportsByName.get(seed.sport) };
}

async function upsertTournament({ vendor, venue, court, sport, seed, players, title, daysAhead, pointsOffset }) {
  const startsAt = pakistanDate(daysAhead, 16);
  const endsAt = new Date(startsAt.getTime() + 2 * 60 * 60 * 1000);
  const entryFeePerPlayerPaisa = daysAhead < 0 ? 0 : 150_000;
  let tournament = await prisma.tournament.findFirst({ where: { organizerUserId: vendor.id, title } });
  const data = {
    organizerUserId: vendor.id, venueId: venue.id, sportId: sport.id, title,
    startsAt, endsAt, timeZone: 'Asia/Karachi', maxTeams: 8, teamSize: 2,
    entryFeePerPlayerPaisa, prizePaisa: 100_000,
    status: daysAhead < 0 ? 'COMPLETED' : 'UPCOMING', registrationOpen: daysAhead >= 0,
    ...(daysAhead < 0 ? { winnerTeamName: 'Demo Champions' } : {}),
  };
  tournament = tournament
    ? await prisma.tournament.update({ where: { id: tournament.id }, data })
    : await prisma.tournament.create({ data });

  let conversation = await prisma.conversation.findUnique({ where: { tournamentId: tournament.id }, select: { id: true } });
  if (!conversation) conversation = await prisma.conversation.create({
    data: { tournamentId: tournament.id, kind: 'TOURNAMENT', title: `${title} chat`, members: { create: [{ userId: vendor.id }] } },
    select: { id: true },
  });
  await prisma.conversationMember.upsert({ where: { conversationId_userId: { conversationId: conversation.id, userId: vendor.id } }, create: { conversationId: conversation.id, userId: vendor.id }, update: {} });

  const eligiblePlayers = players.filter(player => player.sports.includes(sport.name)).slice(0, 4);
  for (const [index, player] of eligiblePlayers.entries()) {
    const participantKey = { tournamentId: tournament.id, userId: player.id };
    const previous = await prisma.tournamentParticipant.findUnique({
      where: { tournamentId_userId: participantKey },
      select: { paymentStatus: true, payments: { select: { status: true } } },
    });
    const paymentInProgressOrSettled = previous?.payments.some(payment =>
      ['PENDING', 'PROCESSING', 'DUE_AT_VENUE', 'AWAITING_TRANSFER', 'PROOF_SUBMITTED', 'SUCCEEDED', 'REFUND_PENDING'].includes(payment.status),
    );
    const paymentStatus = paymentInProgressOrSettled ? previous.paymentStatus : entryFeePerPlayerPaisa ? 'UNPAID' : 'PAID';
    const participant = await prisma.tournamentParticipant.upsert({
      where: { tournamentId_userId: participantKey },
      create: {
        tournamentId: tournament.id, userId: player.id, teamName: `${player.name.split(' ')[0]} ${sport.name} Club`,
        teamMemberNames: [`${player.name.split(' ')[0]} teammate`], entryFeePerPlayerPaisa,
        totalEntryFeePaisa: entryFeePerPlayerPaisa * 2, status: 'REGISTERED', paymentStatus,
        wins: daysAhead < 0 ? Math.max(0, pointsOffset - index) : 0,
        points: daysAhead < 0 ? Math.max(0, (pointsOffset - index) * 3) : 0,
      },
      update: {
        entryFeePerPlayerPaisa, totalEntryFeePaisa: entryFeePerPlayerPaisa * 2,
        status: 'REGISTERED', paymentStatus,
        wins: daysAhead < 0 ? Math.max(0, pointsOffset - index) : 0,
        points: daysAhead < 0 ? Math.max(0, (pointsOffset - index) * 3) : 0,
      },
    });
    await prisma.conversationMember.upsert({
      where: { conversationId_userId: { conversationId: conversation.id, userId: player.id } },
      create: { conversationId: conversation.id, userId: player.id }, update: {},
    });
    if (index === 0) {
      const notice = await prisma.notification.findFirst({
        where: { userId: player.id, type: 'TOURNAMENT', payload: { path: ['demoTournamentId'], equals: tournament.id } },
        select: { id: true },
      });
      if (!notice) await prisma.notification.create({ data: {
        userId: player.id, type: 'TOURNAMENT', title: 'Demo team registered',
        body: `${participant.teamName} is registered for ${title}.`,
        payload: { demoTournamentId: tournament.id, tournamentId: tournament.id },
      } });
    }
  }

  const bookingDate = pakistanDate(daysAhead + 1, 10);
  const bookingEnd = new Date(bookingDate.getTime() + 60 * 60 * 1000);
  const customer = eligiblePlayers[0];
  if (customer) {
    const idempotencyKey = `demo-marketplace-booking:${seed.email}`;
    const bookingData = {
      venueId: venue.id, courtId: court.id, customerUserId: customer.id, createdByUserId: customer.id,
      source: 'APP', status: 'CONFIRMED', paymentMode: 'PAY_AT_VENUE', paymentStatus: 'DUE_AT_VENUE',
      startsAt: bookingDate, endsAt: bookingEnd, timeZone: 'Asia/Karachi',
      groundFeePaisa: court.hourlyPricePaisa, addOnsTotalPaisa: 0, totalPaisa: court.hourlyPricePaisa,
      currency: 'PKR', holdExpiresAt: null, idempotencyKey,
    };
    const existingBooking = await prisma.booking.findUnique({ where: { idempotencyKey }, select: { id: true } });
    if (existingBooking) await prisma.booking.update({ where: { id: existingBooking.id }, data: bookingData });
    else await prisma.booking.create({ data: bookingData });
  }
  return { id: tournament.id, status: tournament.status, playerCount: eligiblePlayers.length };
}

async function main() {
  const sports = await prisma.sport.findMany({ where: { isActive: true }, select: { id: true, name: true, code: true } });
  const sportsByName = new Map(sports.map(sport => [sport.name, sport]));
  for (const seed of vendorSeeds) if (!sportsByName.has(seed.sport)) throw new Error(`Required sport ${seed.sport} is not in the active sports catalog. Run npm run prisma:seed first.`);
  for (const seed of playerSeeds) for (const name of seed.sports) if (!sportsByName.has(name)) throw new Error(`Required sport ${name} is not in the active sports catalog. Run npm run prisma:seed first.`);

  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 12);
  const players = [];
  for (const seed of playerSeeds) players.push({ ...(await upsertPlayer(seed, passwordHash, sportsByName)), sports: seed.sports });
  const vendors = [];
  for (const seed of vendorSeeds) vendors.push({ ...(await upsertVendor(seed, passwordHash, sportsByName)), seed });

  const tournaments = [];
  for (const [index, vendor] of vendors.entries()) {
    tournaments.push(await upsertTournament({
      vendor: vendor.user, venue: vendor.venue, court: vendor.court, sport: vendor.sport, seed: vendor.seed,
      players, title: `${vendor.seed.city} ${vendor.seed.sport} Demo Cup`, daysAhead: index < 2 ? -28 + index * 7 : 14,
      pointsOffset: 5 + index,
    }));
  }

  console.info(`Seeded ${vendors.length} demo vendors, ${players.length} demo players, ${vendors.length} public venues, ${tournaments.filter(item => item.status === 'UPCOMING').length} upcoming tournaments, ${tournaments.filter(item => item.status === 'COMPLETED').length} completed demo tournaments, ${tournaments.reduce((sum, item) => sum + item.playerCount, 0)} team entries and vendor bookings.`);
  console.info(`Demo password for all seeded users: ${DEMO_PASSWORD}`);
  console.info('Demo vendors:');
  vendors.forEach(item => console.info(`  ${item.seed.email} · ${item.seed.name} · ${item.seed.businessName}`));
  console.info('Demo players:');
  playerSeeds.forEach(item => console.info(`  ${item.email} · ${item.name}`));
}

main()
  .catch(error => {
    console.error(`Demo marketplace seed failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(async () => disconnectPrismaClient());
