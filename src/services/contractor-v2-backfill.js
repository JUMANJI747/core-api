'use strict';

/**
 * CRM v2 Etap 1 — backfill znormalizowanych pol Contractor z extras + flat fields.
 *
 *   extras.aliases (array of string)     -> aliases[]
 *   extras.ifirmaId (string identifier)  -> externalIds.ifirmaIdentifier
 *                                            (UWAGA: w iFirma to NIE numeric ID
 *                                            tylko string-skrot max 16 chars,
 *                                            np. "FARMACIA PORTO" — pole API
 *                                            'IdentyfikatorKontrahenta')
 *   externalIds.ifirmaId (legacy)        -> externalIds.ifirmaIdentifier
 *                                            (rename po pierwszym blednym backfillu)
 *   extras.gkReceiverId                  -> externalIds.gkReceiverId
 *   extras.contasimpleId                 -> externalIds.contasimpleId
 *   extras.eContractorId                 -> externalIds.eContractorId
 *   email                                -> primaryEmail (lowercase, gdy primaryEmail puste)
 *
 * Idempotentne — nadpisuje tylko gdy nowe pole jest puste (zachowuje
 * reczne korekty z NocoDB).
 *
 * Wolane z:
 *   - scripts/backfill-contractor-v2-fields.js (CLI, lokalnie z prod DB)
 *   - POST /api/admin/backfill/contractor-v2 (in-process, na Railway)
 */

function pickAliases(extras) {
  if (!extras || typeof extras !== 'object') return null;
  if (!Array.isArray(extras.aliases)) return null;
  const cleaned = extras.aliases
    .filter((a) => typeof a === 'string')
    .map((a) => a.trim())
    .filter((a) => a.length >= 1 && a.length <= 200);
  return cleaned.length ? cleaned : null;
}

function buildExternalIds(extras, currentExternalIds) {
  const out = { ...(currentExternalIds || {}) };

  // Rename legacy ifirmaId (z pierwszego blednego backfillu) -> ifirmaIdentifier.
  // Te wartosci sa stringami (iFirma 'IdentyfikatorKontrahenta'), nie liczbami.
  if (out.ifirmaId != null && out.ifirmaIdentifier == null) {
    out.ifirmaIdentifier = out.ifirmaId;
    delete out.ifirmaId;
  } else if (out.ifirmaId != null && out.ifirmaIdentifier != null) {
    // Both ustawione — wybieramy nowszy (ifirmaIdentifier) i wywalamy stary klucz.
    delete out.ifirmaId;
  }

  if (extras && typeof extras === 'object') {
    if (extras.ifirmaId != null && out.ifirmaIdentifier == null) {
      out.ifirmaIdentifier = extras.ifirmaId;
    }
    if (extras.gkReceiverId != null && out.gkReceiverId == null) {
      out.gkReceiverId = extras.gkReceiverId;
    }
    if (extras.contasimpleId != null && out.contasimpleId == null) {
      out.contasimpleId = extras.contasimpleId;
    }
    if (extras.eContractorId != null && out.eContractorId == null) {
      out.eContractorId = extras.eContractorId;
    }
  }

  return out;
}

function externalIdsChanged(before, after) {
  const a = JSON.stringify(before || {});
  const b = JSON.stringify(after || {});
  return a !== b;
}

async function runBackfill(prisma, opts = {}) {
  const apply = !!opts.apply;
  const verbose = !!opts.verbose;
  const log = typeof opts.log === 'function' ? opts.log : () => {};

  const all = await prisma.contractor.findMany({
    select: {
      id: true, name: true, email: true, extras: true,
      aliases: true, primaryEmail: true, externalIds: true,
    },
  });

  log(`scanning ${all.length} contractors (apply=${apply})`);

  const sample = [];
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
    const nextExternalIds = buildExternalIds(c.extras, currentExternalIds);
    if (externalIdsChanged(currentExternalIds, nextExternalIds)) {
      data.externalIds = nextExternalIds;
      setExternalIds++;
    }

    if (!c.primaryEmail && c.email) {
      data.primaryEmail = c.email.trim().toLowerCase();
      setPrimaryEmail++;
    }

    if (Object.keys(data).length === 0) continue;
    touched++;

    if (verbose) log(`  ${c.id}  ${c.name}  -> ${JSON.stringify(data)}`);
    if (sample.length < 10) sample.push({ id: c.id, name: c.name, changes: data });

    if (apply) {
      await prisma.contractor.update({ where: { id: c.id }, data });
    }
  }

  return {
    apply, scanned: all.length, touched,
    setAliases, setExternalIds, setPrimaryEmail,
    sample,
  };
}

module.exports = { runBackfill };
