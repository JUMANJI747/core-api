'use strict';

/**
 * Etap 1 backfill: extras + flat fields → znormalizowane pola Contractor v2.
 *
 *   extras.aliases (array of string) → aliases[]
 *   extras.ifirmaId                 → externalIds.ifirmaId
 *   extras.gkReceiverId             → externalIds.gkReceiverId
 *   extras.contasimpleId            → externalIds.contasimpleId
 *   email                           → primaryEmail (jeśli puste)
 *
 * Default: dry-run. Flaga --apply zapisuje. Flaga --verbose loguje per-row.
 *
 * Uruchomienie lokalne z prod DB:
 *   DATABASE_URL=postgresql://...  node scripts/backfill-contractor-v2-fields.js
 *   DATABASE_URL=postgresql://...  node scripts/backfill-contractor-v2-fields.js --apply
 */

const prisma = require('../src/db');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');

function pickAliases(extras) {
  if (!extras || typeof extras !== 'object') return null;
  if (!Array.isArray(extras.aliases)) return null;
  const cleaned = extras.aliases
    .filter((a) => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => a.length >= 1 && a.length <= 200);
  return cleaned.length ? cleaned : null;
}

function pickExternalIds(extras) {
  if (!extras || typeof extras !== 'object') return null;
  const out = {};
  if (extras.ifirmaId != null) out.ifirmaId = extras.ifirmaId;
  if (extras.gkReceiverId != null) out.gkReceiverId = extras.gkReceiverId;
  if (extras.contasimpleId != null) out.contasimpleId = extras.contasimpleId;
  if (extras.eContractorId != null) out.eContractorId = extras.eContractorId;
  return Object.keys(out).length ? out : null;
}

async function main() {
  const all = await prisma.contractor.findMany({
    select: {
      id: true, name: true, email: true, extras: true,
      aliases: true, primaryEmail: true, externalIds: true,
    },
  });

  console.log(`scanning ${all.length} contractors (apply=${APPLY})`);

  let touched = 0;
  let setAliases = 0;
  let setExternalIds = 0;
  let setPrimaryEmail = 0;

  for (const c of all) {
    const data = {};

    if (!c.aliases || c.aliases.length === 0) {
      const aliases = pickAliases(c.extras);
      if (aliases) { data.aliases = aliases; setAliases++; }
    }

    const currentExternalIds = (c.externalIds && typeof c.externalIds === 'object') ? c.externalIds : {};
    if (Object.keys(currentExternalIds).length === 0) {
      const ids = pickExternalIds(c.extras);
      if (ids) { data.externalIds = ids; setExternalIds++; }
    }

    if (!c.primaryEmail && c.email) {
      data.primaryEmail = c.email.trim().toLowerCase();
      setPrimaryEmail++;
    }

    if (Object.keys(data).length === 0) continue;
    touched++;

    if (VERBOSE) {
      console.log(`  ${c.id}  ${c.name}  -> ${JSON.stringify(data)}`);
    }

    if (APPLY) {
      await prisma.contractor.update({ where: { id: c.id }, data });
    }
  }

  console.log('---');
  console.log(`touched:          ${touched}`);
  console.log(`aliases set:      ${setAliases}`);
  console.log(`externalIds set:  ${setExternalIds}`);
  console.log(`primaryEmail set: ${setPrimaryEmail}`);
  if (!APPLY) console.log('(dry-run — rerun z --apply żeby zapisać)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
