'use strict';

/**
 * CLI wrapper dla src/services/contractor-v2-backfill.js.
 *
 * Uruchomienie lokalne z prod DB:
 *   DATABASE_URL=postgresql://...  node scripts/backfill-contractor-v2-fields.js
 *   DATABASE_URL=postgresql://...  node scripts/backfill-contractor-v2-fields.js --apply
 *
 * Wlasciwie nie trzeba juz uzywac tego scriptu — backfill jest tez
 * dostepny przez POST /api/admin/backfill/contractor-v2 (in-process
 * na Railway). Skrypt zostaje na wypadek gdyby trzeba bylo odpalic
 * z innej maszyny / przed deployem.
 */

const prisma = require('../src/db');
const { runBackfill } = require('../src/services/contractor-v2-backfill');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

(async () => {
  try {
    const result = await runBackfill(prisma, {
      apply: APPLY, verbose: VERBOSE,
      log: (msg) => console.log(msg),
    });
    console.log('---');
    console.log(`scanned:          ${result.scanned}`);
    console.log(`touched:          ${result.touched}`);
    console.log(`aliases set:      ${result.setAliases}`);
    console.log(`externalIds set:  ${result.setExternalIds}`);
    console.log(`primaryEmail set: ${result.setPrimaryEmail}`);
    if (!APPLY) console.log('(dry-run — rerun z --apply zeby zapisac)');
  } catch (e) {
    console.error(e);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
})();
