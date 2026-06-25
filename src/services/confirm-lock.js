'use strict';

// Trwała (DB) idempotencja wystawiania FV/WZ — działa MIĘDZY instancjami.
// In-memory Set/Map nie chronią, bo Railway potrafi mieć kilka instancji,
// a podgląd jest wtedy w pamięci tylko jednej z nich; przy wolnym API
// (iFirma/Contasimple ~2-3s) równoległe tapnięcia „Wystaw" tworzą duplikaty.
// Tu robimy ATOMOWE zajęcie klucza w Postgres (unique @id): pierwszy request
// tworzy wiersz, kolejne dostają błąd unikalności → wiemy, że to duplikat.
//
// Stany:
//   claimConfirm  → { state:'fresh' }                         możesz wystawiać
//                 → { state:'done', invoiceNumber, invoiceId } już wystawione
//                 → { state:'in_progress' }                   ktoś właśnie wystawia
//   completeConfirm — po sukcesie zapisz numer (kolejne tapnięcia: 'done')
//   releaseConfirm  — po BŁĘDZIE zwolnij klucz, by user mógł spróbować ponownie

async function claimConfirm(prisma, key) {
  if (!key) return { state: 'fresh' }; // brak klucza → nie blokuj (lepiej wystawić niż utknąć)
  try {
    await prisma.confirmLock.create({ data: { key: String(key) } });
    return { state: 'fresh' };
  } catch (e) {
    // P2002 = klucz już istnieje → ktoś zajął/wystawił. Sprawdź czy skończone.
    const row = await prisma.confirmLock.findUnique({ where: { key: String(key) } }).catch(() => null);
    if (row && row.invoiceNumber) return { state: 'done', invoiceNumber: row.invoiceNumber, invoiceId: row.invoiceId };
    return { state: 'in_progress' };
  }
}

async function completeConfirm(prisma, key, invoiceNumber, invoiceId) {
  if (!key) return;
  await prisma.confirmLock.update({
    where: { key: String(key) },
    data: { invoiceNumber: invoiceNumber != null ? String(invoiceNumber) : null, invoiceId: invoiceId != null ? String(invoiceId) : null },
  }).catch(() => {});
}

async function releaseConfirm(prisma, key) {
  if (!key) return;
  await prisma.confirmLock.delete({ where: { key: String(key) } }).catch(() => {});
}

module.exports = { claimConfirm, completeConfirm, releaseConfirm };
