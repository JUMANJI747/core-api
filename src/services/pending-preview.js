'use strict';

// Guard dla „oczekującego podglądu FV" (agentContext id='ksiegowosc',
// data.lastAction === 'preview'). Zapisy stanu (preview → confirmed) są
// fire-and-forget i potrafią wpaść w złej kolejności (async preview nadpisuje
// wcześniejszy confirmed), a część ścieżek wystawienia w ogóle nie zapisywała
// 'confirmed'. Efekt: bot pytał „potwierdź FV", choć chwilę wcześniej ją
// wystawił (np. FV 163/2026). Zamiast polegać wyłącznie na lastAction,
// krzyżowo sprawdzamy tabelę Invoice: jeśli dla TEGO kontrahenta powstała
// faktura od czasu podglądu (±slack), podgląd jest już zrealizowany.
//
// Zwraca obiekt wystawionej FV {id, number, createdAt} gdy podgląd jest już
// zamknięty, albo null gdy nadal realnie oczekuje.
async function invoicePreviewAlreadyIssued(prisma, data, slackMs = 5 * 60 * 1000) {
  if (!prisma || !data || data.lastAction !== 'preview') return null;
  const ts = Number(data.timestamp) || 0;
  if (!ts) return null;
  const c = data.contractor || {};
  const name = c.name ? String(c.name).trim() : null;
  const nip = c.nip ? String(c.nip).replace(/\s+/g, '') : null;
  if (!name && !nip) return null;

  const or = [];
  if (nip) or.push({ contractorNip: nip });
  if (name) or.push({ contractorName: name });

  try {
    const inv = await prisma.invoice.findFirst({
      where: { createdAt: { gte: new Date(ts - slackMs) }, OR: or },
      orderBy: { createdAt: 'desc' },
      select: { id: true, number: true, createdAt: true },
    });
    return inv || null;
  } catch (_) {
    return null;
  }
}

module.exports = { invoicePreviewAlreadyIssued };
