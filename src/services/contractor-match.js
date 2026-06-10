'use strict';

function normalizeContractorName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/ç/g, 'c').replace(/[ãõ]/g, a => a === 'ã' ? 'a' : 'o')
    .replace(/[-.,&]/g, ' ')
    .replace(/\b(lda|slu|sl|sa|sp|gmbh|srl|snc|unipessoal|spolka|sp z o o|sp\. z o\.o\.?)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function scoreContractor(contractor, search) {
  const normSearch = normalizeContractorName(search);
  const normName = normalizeContractorName(contractor.name);
  const searchWords = normSearch.split(/\s+/).filter(w => w.length >= 3);
  const nameWords = normName.split(/\s+/).filter(w => w.length >= 3);

  if (normName === normSearch) return 100;
  if (searchWords.length > 0 && searchWords.every(w => normName.includes(w))) return 90;

  // Prefix-match z większym progiem — gdy user wpisze 'pozowince', słowo
  // ma wspólny 4+ znakowy prefix z 'pozo' z 'pozo winds'. Wcześniej dawało
  // tylko 40, teraz 85 jeśli WSZYSTKIE searchWords mają taki prefix match,
  // bo to silny sygnał (literówka, częściowa nazwa).
  const allHavePrefix = searchWords.length > 0 && searchWords.every(sw => {
    const pfx = sw.slice(0, Math.min(4, sw.length));
    return pfx.length >= 4 && nameWords.some(nw => nw.startsWith(pfx) || sw.startsWith(nw.slice(0, 4)));
  });
  if (allHavePrefix) return 85;

  if (searchWords.some(w => normName.includes(w))) return 80;

  const has70 = searchWords.some(sw => nameWords.some(nw => nw.includes(sw) || sw.includes(nw)));
  if (has70) return 70;

  const aliases = (contractor.extras && Array.isArray(contractor.extras.aliases)) ? contractor.extras.aliases : [];
  if (aliases.some(a => normalizeContractorName(a) === normSearch)) return 60;

  if (contractor.nip && contractor.nip.replace(/\s/g, '').includes(search.replace(/\s/g, ''))) return 50;

  const has40 = searchWords.some(sw => {
    const pfx = sw.slice(0, 4);
    return nameWords.some(nw => nw.startsWith(pfx));
  });
  if (has40) return 40;

  return 0;
}

// Domyślny select pod scoring + typowe pola wyświetlane przez callerów.
// extras MUSI tu być — scoreContractor czyta z niego aliasy.
const DEFAULT_CONTRACTOR_SELECT = {
  id: true, name: true, nip: true, country: true, email: true,
  address: true, city: true, phone: true, extras: true,
};

/**
 * Znajduje i scoruje kontrahentów po fuzzy-search, BEZ ładowania całej tabeli
 * na ścieżce typowej. Strategia (sprawdzona wcześniej w glob-quote):
 *   1. prefilter SQL po tokenach (name/email contains) — zwykle łapie trafienie,
 *   2. fallback do pełnego skanu TYLKO gdy prefilter nic nie zescoruje
 *      (literówki/aliasy/akcenty, których nie wyrazi ILIKE) — rzadka ścieżka,
 *      identyczna z dawnym zachowaniem, więc zero regresji w matchowaniu.
 *
 * Zwraca posortowane malejąco [{ contractor, score }] (score >= minScore).
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} search
 * @param {{minScore?:number, limit?:number, select?:object, prefilterTake?:number, fallbackTake?:number|null}} [opts]
 */
async function findBestContractors(prisma, search, opts = {}) {
  const {
    minScore = 1,
    limit = 10,
    select = DEFAULT_CONTRACTOR_SELECT,
    prefilterTake = 50,
    fallbackTake = null, // null = bez limitu (pełny skan jak dawniej) na rzadkiej ścieżce
  } = opts;

  const s = (search == null ? '' : String(search)).trim();
  if (!s) return [];

  const tokens = s.toLowerCase().split(/\s+/).filter(t => t.length >= 3).slice(0, 4);
  const orFilters = [
    { name: { contains: s, mode: 'insensitive' } },
    { email: { contains: s, mode: 'insensitive' } },
    ...tokens.map(t => ({ name: { contains: t, mode: 'insensitive' } })),
  ];

  const rank = (list) => list
    .map(c => ({ contractor: c, score: scoreContractor(c, s) }))
    .filter(x => x.score >= minScore)
    .sort((a, b) => b.score - a.score);

  let scored = rank(await prisma.contractor.findMany({ where: { OR: orFilters }, select, take: prefilterTake }));
  if (!scored.length) {
    const args = { select };
    if (fallbackTake) args.take = fallbackTake;
    scored = rank(await prisma.contractor.findMany(args));
  }
  return scored.slice(0, limit);
}

module.exports = { normalizeContractorName, scoreContractor, findBestContractors, DEFAULT_CONTRACTOR_SELECT };
