'use strict';

// Lekki cache aktywnego katalogu produktow.
// Katalog zmienia sie rzadko (seed/import), a /invoice-preview czytal go z bazy
// przy KAZDYM wywolaniu (findMany na calej tabeli produktow). Cache z krotkim
// TTL + jawna inwalidacja przy zapisie produktow trzyma to swieze bez zapytania
// na goracej sciezce wystawiania faktury.

const TTL_MS = 5 * 60 * 1000;
let cache = null; // { items, at }

async function getActiveCatalog(prisma) {
  if (cache && (Date.now() - cache.at) < TTL_MS) return cache.items;
  const items = await prisma.product.findMany({ where: { active: true } });
  cache = { items, at: Date.now() };
  return items;
}

function invalidateCatalog() {
  cache = null;
}

module.exports = { getActiveCatalog, invalidateCatalog };
