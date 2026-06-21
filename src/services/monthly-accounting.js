'use strict';

// Wspólna logika „dodatkowej księgowości" — zakres miesiąca + raport
// (pokrycie KSeF, WDT bez sparowanej wysyłki). Używane przez routes/accounting
// (UI) i można reużyć w cronie.

function isWdtInvoice(inv) {
  const t = `${inv.ifirmaType || ''} ${inv.type || ''}`.toLowerCase();
  return t.includes('dostawa_ue') || t.includes('wdt');
}

// month: 'YYYY-MM' albo brak → poprzedni miesiąc.
function monthRange(month) {
  let from, to;
  if (month && /^\d{4}-\d{2}$/.test(month)) {
    const [y, m] = month.split('-').map(Number);
    from = new Date(Date.UTC(y, m - 1, 1));
    to = new Date(Date.UTC(y, m, 0, 23, 59, 59));
  } else {
    const now = new Date();
    from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0, 23, 59, 59));
  }
  return { from, to, fromIso: from.toISOString().slice(0, 10), toIso: to.toISOString().slice(0, 10) };
}

async function buildReport(prisma, { from, to }) {
  const plInvoices = await prisma.invoice.findMany({
    where: { ifirmaId: { not: null }, issueDate: { gte: from, lte: to } },
    select: { id: true, number: true, ksefNumber: true, type: true, ifirmaType: true, shipmentNumber: true, currency: true, grossAmount: true, contractorName: true },
    orderBy: { issueDate: 'asc' },
  });
  const total = plInvoices.length;
  const toSend = plInvoices.filter(i => !i.ksefNumber);
  const inKsef = total - toSend.length;
  const wdt = plInvoices.filter(isWdtInvoice);

  // Parowanie WDT liczymy TAK SAMO jak strona Faktury: faktura jest „sparowana"
  // gdy ma jawny shipmentNumber LUB dopasowanie po nazwie do zamówienia GK
  // (runtime, niezapisane w bazie). Bez tego raport pokazywał 21/21 mimo że
  // prawie wszystkie są połączone. Stan bierzemy wprost z GET /api/invoices.
  let pairedNumbers = null;
  try {
    const { selfCall } = require('./agent-runtime');
    const r = await selfCall('GET', '/api/invoices', { limit: 10000 });
    const arr = Array.isArray(r.body) ? r.body : null;
    if (arr) {
      pairedNumbers = new Set();
      for (const it of arr) { if (it && it.shipment && it.number) pairedNumbers.add(String(it.number)); }
    }
  } catch (_) { /* fallback niżej */ }
  const isPaired = (inv) => pairedNumbers ? pairedNumbers.has(String(inv.number)) : !!inv.shipmentNumber;
  const wdtUnpaired = wdt.filter(i => !isPaired(i));

  return {
    sales: { total, inKsef, toSend: toSend.length, toSendNumbers: toSend.map(i => i.number) },
    wdt: { total: wdt.length, unpaired: wdtUnpaired.length, unpairedNumbers: wdtUnpaired.map(i => i.number) },
    _toSend: toSend,
    _wdtUnpaired: wdtUnpaired,
  };
}

module.exports = { isWdtInvoice, monthRange, buildReport };
