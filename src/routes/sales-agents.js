'use strict';

// ============ AGENCI HANDLOWI (zakładka Agenci) ============
//
// Model rozliczeń: agent dostaje towar po SWOJEJ cenie (operacja `delivery`,
// np. 100 sticków × 3 €), a jego kontrahenci dostają od nas FV po cenach
// sprzedaży (np. 100 × 4,50 €). Saldo agenta:
//
//   saldo = Σ FV kontrahentów agenta (od daty przypięcia)
//         − Σ delivery (towar wydany agentowi)
//         − Σ settlement (rozliczenia, np. „rozliczono gotówką")
//         + Σ adjustment (ręczne korekty, ze znakiem)
//
// W przykładzie: 450 − 300 = 150 € salda; „rozliczono gotówką 150" → 0.
// Wszystko per waluta (PL bywa w PLN). Historia = operacje + FV, chronologicznie.

const router = require('express').Router();

function num(v) { return v == null ? 0 : Number(v) || 0; }

// Suma per waluta: { EUR: 123.45, PLN: ... }
function addTo(sums, currency, amount) {
  const cur = (currency || 'EUR').toUpperCase();
  sums[cur] = (sums[cur] || 0) + amount;
}

// Kontrahent agenta jest STAŁY — bez dat przy przypięciu. Granicę wyznacza
// automatycznie PIERWSZA DOSTAWA agenta (albo wcześniejsza korekta salda
// początkowego): FV sprzed niej nie liczą się, bo dotyczyły towaru sprzed
// ewidencji. Brak dostaw = FV jeszcze nie wchodzą (nie ma czego rozliczać).
function agentCutoff(operations) {
  let cutoff = null;
  for (const op of operations) {
    if (op.type !== 'delivery' && op.type !== 'adjustment') continue;
    const d = new Date(op.date);
    if (!cutoff || d < cutoff) cutoff = d;
  }
  return cutoff;
}

// Każda FV niesie `paid` = ile z niej REALNIE zapłacono (0..amount) — do salda
// wchodzi tylko część opłacona; reszta wisi jako „w nieopłaconych FV".
async function loadAgentInvoices(prisma, links, cutoff) {
  if (!cutoff) return [];
  const out = [];
  for (const link of links) {
    if (link.system === 'pl') {
      const rows = await prisma.invoice.findMany({
        where: { contractorId: link.contractorId, issueDate: { gte: cutoff } },
        select: { id: true, number: true, issueDate: true, grossAmount: true, paidAmount: true, currency: true, contractorName: true, status: true },
        orderBy: { issueDate: 'desc' },
      }).catch(() => []);
      for (const r of rows) {
        const amount = num(r.grossAmount);
        // status 'paid' bez zapisanej kwoty (stare rekordy) = opłacona w całości.
        const paidRaw = num(r.paidAmount) || (String(r.status || '').toLowerCase() === 'paid' ? amount : 0);
        out.push({
          kind: 'invoice', system: 'pl', id: r.id, number: r.number,
          date: r.issueDate, amount, paid: Math.min(Math.max(paidRaw, 0), amount),
          currency: r.currency || 'PLN',
          contractorName: r.contractorName || link.name || null, status: r.status || null,
        });
      }
    } else {
      const rows = await prisma.esInvoice.findMany({
        where: { contractorId: link.contractorId, invoiceDate: { gte: cutoff } },
        select: { id: true, number: true, invoiceDate: true, totalAmount: true, totalPayedAmount: true, currency: true, contractorName: true, status: true },
        orderBy: { invoiceDate: 'desc' },
      }).catch(() => []);
      for (const r of rows) {
        const amount = num(r.totalAmount);
        const paidRaw = num(r.totalPayedAmount) || (String(r.status || '') === 'Payed' ? amount : 0);
        out.push({
          kind: 'invoice', system: 'es', id: r.id, number: r.number,
          date: r.invoiceDate, amount, paid: Math.min(Math.max(paidRaw, 0), amount),
          currency: r.currency || 'EUR',
          contractorName: r.contractorName || link.name || null, status: r.status || null,
        });
      }
    }
  }
  return out;
}

// Do salda wchodzi tylko OPŁACONA część FV (częściowa wpłata = częściowo) —
// wystawienie faktury samo w sobie salda nie rusza; nieopłacone kwoty wracają
// osobno w `unpaidInvoiced`, żeby było widać ile wisi w fakturach.
function computeSaldo(invoices, operations) {
  const saldo = {};
  const unpaidInvoiced = {};
  const totals = { invoiced: {}, invoicedPaid: {}, delivered: {}, settled: {}, adjusted: {} };
  for (const inv of invoices) {
    const paid = num(inv.paid);
    addTo(saldo, inv.currency, paid);
    addTo(totals.invoiced, inv.currency, inv.amount);
    addTo(totals.invoicedPaid, inv.currency, paid);
    const unpaid = inv.amount - paid;
    if (unpaid > 0.005) addTo(unpaidInvoiced, inv.currency, unpaid);
  }
  for (const op of operations) {
    const amt = num(op.amount);
    if (op.type === 'delivery') { addTo(saldo, op.currency, -amt); addTo(totals.delivered, op.currency, amt); }
    else if (op.type === 'settlement') { addTo(saldo, op.currency, -amt); addTo(totals.settled, op.currency, amt); }
    else if (op.type === 'adjustment') { addTo(saldo, op.currency, amt); addTo(totals.adjusted, op.currency, amt); }
  }
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return {
    saldo: round(saldo),
    unpaidInvoiced: round(unpaidInvoiced),
    totals: {
      invoiced: round(totals.invoiced), invoicedPaid: round(totals.invoicedPaid),
      delivered: round(totals.delivered), settled: round(totals.settled), adjusted: round(totals.adjusted),
    },
  };
}

// Lista agentów z saldem (do tabelki w zakładce).
router.get('/sales-agents', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const agents = await prisma.salesAgent.findMany({
      orderBy: [{ active: 'desc' }, { name: 'asc' }],
      include: { contractors: true, operations: { select: { type: true, amount: true, currency: true, date: true } } },
    });
    const data = [];
    for (const a of agents) {
      const invoices = await loadAgentInvoices(prisma, a.contractors, agentCutoff(a.operations));
      const { saldo, unpaidInvoiced } = computeSaldo(invoices, a.operations);
      data.push({
        id: a.id, name: a.name, notes: a.notes, active: a.active, currency: a.currency,
        contractorCount: a.contractors.length,
        operationCount: a.operations.length,
        saldo, unpaidInvoiced,
      });
    }
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Tworzenie: nazwa + waluta rozliczeń (EUR/PLN) + opcjonalnie od razu cennik
// [{name, unitPrice}] — agent może mieć inną cenę na każdy produkt.
router.post('/sales-agents', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { name, notes, currency, prices } = req.body || {};
    if (!name || !String(name).trim()) return res.status(400).json({ ok: false, error: 'Podaj nazwę agenta' });
    const cur = String(currency || 'EUR').toUpperCase();
    if (!['EUR', 'PLN'].includes(cur)) return res.status(400).json({ ok: false, error: 'Waluta agenta: EUR albo PLN' });
    const priceRows = Array.isArray(prices)
      ? prices
        .map(p => ({ name: String((p && p.name) || '').trim(), unitPrice: Number(p && p.unitPrice) }))
        .filter(p => p.name && Number.isFinite(p.unitPrice) && p.unitPrice >= 0)
      : [];
    const agent = await prisma.salesAgent.create({
      data: {
        name: String(name).trim(),
        notes: notes ? String(notes) : null,
        currency: cur,
        ...(priceRows.length ? { prices: { create: priceRows } } : {}),
      },
      include: { prices: true },
    });
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.patch('/sales-agents/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { name, notes, active, currency } = req.body || {};
    const data = {};
    if (name !== undefined) data.name = String(name).trim();
    if (notes !== undefined) data.notes = notes ? String(notes) : null;
    if (active !== undefined) data.active = !!active;
    if (currency !== undefined) {
      const cur = String(currency).toUpperCase();
      if (!['EUR', 'PLN'].includes(cur)) return res.status(400).json({ ok: false, error: 'Waluta agenta: EUR albo PLN' });
      data.currency = cur;
    }
    const agent = await prisma.salesAgent.update({ where: { id: req.params.id }, data });
    res.json({ ok: true, agent });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Karta agenta: kontrahenci, saldo, pełna historia (operacje + FV) malejąco po dacie.
router.get('/sales-agents/:id', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const agent = await prisma.salesAgent.findUnique({
      where: { id: req.params.id },
      include: {
        contractors: { orderBy: { createdAt: 'asc' } },
        operations: { orderBy: [{ date: 'desc' }, { createdAt: 'desc' }] },
        prices: { orderBy: { name: 'asc' } },
      },
    });
    if (!agent) return res.status(404).json({ ok: false, error: 'Nie znaleziono agenta' });
    const cutoff = agentCutoff(agent.operations);
    const invoices = await loadAgentInvoices(prisma, agent.contractors, cutoff);
    const { saldo, unpaidInvoiced, totals } = computeSaldo(invoices, agent.operations);
    const history = [
      ...agent.operations.map(op => ({
        kind: 'operation', id: op.id, type: op.type, date: op.date,
        description: op.description, qty: op.qty != null ? Number(op.qty) : null,
        unitPrice: op.unitPrice != null ? Number(op.unitPrice) : null,
        amount: num(op.amount), currency: op.currency,
      })),
      ...invoices,
    ].sort((a, b) => new Date(b.date) - new Date(a.date));
    // Saldo narastająco („saldo po" przy każdej pozycji) — przy uzupełnianiu
    // historii wstecz widać, jak stan zbliża się do prawdy z każdym wpisem.
    // Iterujemy WYŚWIETLANĄ listę od końca (nie ponownym sortem!): daty wpisów
    // wstecznych i FV to często ta sama północ, a stabilny re-sort zostawiał
    // remisy w kolejności wyświetlania — akumulacja szła wtedy od góry i
    // najnowszy wiersz nie zgadzał się z saldem w nagłówku.
    const running = {};
    for (let i = history.length - 1; i >= 0; i--) {
      const h = history[i];
      const cur = (h.currency || 'EUR').toUpperCase();
      // FV wchodzi do salda tylko OPŁACONĄ częścią (spójnie z computeSaldo).
      const delta = h.kind === 'invoice' ? num(h.paid) : (h.type === 'adjustment' ? h.amount : -h.amount);
      running[cur] = (running[cur] || 0) + delta;
      h.saldoAfter = Math.round(running[cur] * 100) / 100;
    }
    res.json({
      ok: true,
      agent: { id: agent.id, name: agent.name, notes: agent.notes, active: agent.active, currency: agent.currency },
      contractors: agent.contractors,
      prices: agent.prices.map(p => ({ id: p.id, name: p.name, unitPrice: Number(p.unitPrice) })),
      fvOd: cutoff ? cutoff.toISOString() : null,
      saldo, unpaidInvoiced, totals, history,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Operacja: delivery (qty × unitPrice; amount policzymy gdy nie podany),
// settlement („rozliczono gotówką" — kwota), adjustment (korekta ze znakiem).
router.post('/sales-agents/:id/operations', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { type, qty, unitPrice, amount, currency, description, date } = req.body || {};
    if (!['delivery', 'settlement', 'adjustment'].includes(type)) {
      return res.status(400).json({ ok: false, error: "type: 'delivery' | 'settlement' | 'adjustment'" });
    }
    let amt = amount != null ? Number(amount) : null;
    if (amt == null && type === 'delivery' && qty != null && unitPrice != null) {
      amt = Number(qty) * Number(unitPrice);
    }
    if (amt == null || !Number.isFinite(amt)) return res.status(400).json({ ok: false, error: 'Podaj kwotę (amount) albo qty × unitPrice' });
    if (type !== 'adjustment' && amt < 0) return res.status(400).json({ ok: false, error: 'Kwota nie może być ujemna (do korekt służy adjustment)' });
    const agent = await prisma.salesAgent.findUnique({ where: { id: req.params.id }, select: { id: true, currency: true } });
    if (!agent) return res.status(404).json({ ok: false, error: 'Nie znaleziono agenta' });
    const op = await prisma.salesAgentOperation.create({
      data: {
        agentId: agent.id, type,
        date: date ? new Date(date) : new Date(),
        description: description ? String(description) : null,
        qty: qty != null ? Number(qty) : null,
        unitPrice: unitPrice != null ? Number(unitPrice) : null,
        amount: Math.round(amt * 100) / 100,
        // Domyślnie waluta AGENTA (agent jest w EUR albo PLN) — jawne
        // `currency` w body nadal wygrywa (korekty w innej walucie).
        currency: (currency || agent.currency || 'EUR').toUpperCase(),
      },
    });
    res.json({ ok: true, operation: op });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Usunięcie pomyłkowej operacji (historia ma być prawdziwa, nie „storno").
router.delete('/sales-agents/:id/operations/:opId', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const r = await prisma.salesAgentOperation.deleteMany({ where: { id: req.params.opId, agentId: req.params.id } });
    if (!r.count) return res.status(404).json({ ok: false, error: 'Nie znaleziono operacji' });
    res.json({ ok: true, deleted: r.count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Cennik agenta: dodaj/zmień cenę produktu (upsert po nazwie w ramach agenta).
router.post('/sales-agents/:id/prices', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { name, unitPrice } = req.body || {};
    const n = String(name || '').trim();
    const price = Number(unitPrice);
    if (!n) return res.status(400).json({ ok: false, error: 'Podaj nazwę produktu' });
    if (!Number.isFinite(price) || price < 0) return res.status(400).json({ ok: false, error: 'Podaj poprawną cenę' });
    const agent = await prisma.salesAgent.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!agent) return res.status(404).json({ ok: false, error: 'Nie znaleziono agenta' });
    const row = await prisma.salesAgentPrice.upsert({
      where: { agentId_name: { agentId: agent.id, name: n } },
      update: { unitPrice: price },
      create: { agentId: agent.id, name: n, unitPrice: price },
    });
    res.json({ ok: true, price: { id: row.id, name: row.name, unitPrice: Number(row.unitPrice) } });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/sales-agents/:id/prices/:priceId', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const r = await prisma.salesAgentPrice.deleteMany({ where: { id: req.params.priceId, agentId: req.params.id } });
    if (!r.count) return res.status(404).json({ ok: false, error: 'Nie znaleziono pozycji cennika' });
    res.json({ ok: true, deleted: r.count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Przypnij kontrahenta (PL/ES) — NA STAŁE, bez dat: granicę liczenia FV
// wyznacza automatycznie pierwsza dostawa agenta. Jeden kontrahent = jeden agent.
router.post('/sales-agents/:id/contractors', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { system, contractorId } = req.body || {};
    if (!['pl', 'es'].includes(system)) return res.status(400).json({ ok: false, error: "system: 'pl' | 'es'" });
    if (!contractorId) return res.status(400).json({ ok: false, error: 'Podaj contractorId' });
    const agent = await prisma.salesAgent.findUnique({ where: { id: req.params.id }, select: { id: true } });
    if (!agent) return res.status(404).json({ ok: false, error: 'Nie znaleziono agenta' });

    let name = null;
    if (system === 'pl') {
      const c = await prisma.contractor.findUnique({ where: { id: String(contractorId) }, select: { name: true } });
      if (!c) return res.status(404).json({ ok: false, error: 'Nie znaleziono kontrahenta PL' });
      name = c.name;
    } else {
      const c = await prisma.esContractor.findUnique({ where: { id: String(contractorId) }, select: { name: true, organization: true } });
      if (!c) return res.status(404).json({ ok: false, error: 'Nie znaleziono kontrahenta ES' });
      name = c.organization || c.name;
    }

    const existing = await prisma.salesAgentContractor.findUnique({
      where: { system_contractorId: { system, contractorId: String(contractorId) } },
      include: { agent: { select: { name: true } } },
    }).catch(() => null);
    if (existing) {
      return res.status(400).json({ ok: false, error: `Ten kontrahent jest już przypisany do agenta „${existing.agent.name}" — najpierw go odepnij.` });
    }

    const link = await prisma.salesAgentContractor.create({
      data: { agentId: agent.id, system, contractorId: String(contractorId), name },
    });
    res.json({ ok: true, link });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.delete('/sales-agents/:id/contractors/:linkId', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const r = await prisma.salesAgentContractor.deleteMany({ where: { id: req.params.linkId, agentId: req.params.id } });
    if (!r.count) return res.status(404).json({ ok: false, error: 'Nie znaleziono przypisania' });
    res.json({ ok: true, deleted: r.count });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
