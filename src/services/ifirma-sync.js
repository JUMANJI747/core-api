'use strict';

const { appendAlias } = require('./contractor-sync-helpers');

function guessCountryFromInv(inv) {
  const rodzaj = (inv.Rodzaj || '').toLowerCase();
  const waluta = (inv.Waluta || 'PLN').toUpperCase();
  const nip = (inv.NIPKontrahenta || '').replace(/[\s\-]/g, '');
  if (rodzaj.includes('kraj')) return 'PL';
  if (waluta === 'EUR') {
    if (/^\d{9}$/.test(nip) && parseInt(nip[0]) >= 1 && parseInt(nip[0]) <= 5) return 'PT';
    if (/^[BXA-Z]/i.test(nip)) return 'ES';
    if (/^\d{11}$/.test(nip) && nip[0] === '0') return 'IT';
    if (/^\d{11}$/.test(nip) && nip[0] === '4') return 'FR';
  }
  return null;
}

async function processIfirmaInvoices(invoices, prisma, opts = {}) {
  // skipDelete/skipLink — dla importu historycznego (sync-history): kasowanie
  // per-miesiąc i pełne linkowanie maili nie mają tam sensu (linkujemy raz na końcu).
  const { dataOd, dataDo, dryRun = false, silent = false, skipDelete = false, skipLink = false } = opts;

  // ============ FAZA 1: KONTRAHENCI ============
  const nipToInv = new Map();
  for (const inv of invoices) {
    const rawNip = (inv.NIPKontrahenta || '').replace(/[\s\-]/g, '');
    if (!rawNip) continue;
    if (!nipToInv.has(rawNip)) nipToInv.set(rawNip, inv);
  }

  let contractorsCreated = 0, contractorsSkipped = 0;
  const nipToContractorId = new Map();

  for (const [nip, inv] of nipToInv) {
    const existing = await prisma.contractor.findUnique({ where: { nip } });
    if (existing) {
      contractorsSkipped++;
      nipToContractorId.set(nip, existing.id);
      // CRM v2 Etap 1.5 — alias bump. iFirma czesto ma rozne nazwy tej
      // samej firmy (Ltd vs Sp. z o.o. vs skrot), wiec dorzucamy NazwaKontrahenta
      // do aliases jak novel. Sanity + dedup w helperze.
      if (!dryRun) {
        const altName = (inv.NazwaKontrahenta || '').replace(/^-+\s*/, '').trim();
        if (altName) appendAlias(prisma, existing.id, altName, 'ifirma-sync').catch(() => {});
      }
    } else if (!dryRun) {
      const rawName = (inv.NazwaKontrahenta || '').replace(/^-+\s*/, '').trim();
      const country = guessCountryFromInv(inv);
      // UWAGA: iFirma 'IdentyfikatorKontrahenta' to STRING-skrot (max 16 chars),
      // NIE numeric ID. Trzymamy go w externalIds.ifirmaIdentifier zeby
      // nie mylic z numerycznym ID (ktore w iFirma istnieje pod inna nazwa
      // ale nie zwracaja go w API faktur).
      const ifirmaIdentifier = inv.IdentyfikatorKontrahenta || null;
      const created = await prisma.contractor.create({
        data: {
          name: rawName,
          nip,
          type: 'BUSINESS',
          country,
          source: 'ifirma',
          tags: ['ifirma-import'],
          externalIds: ifirmaIdentifier ? { ifirmaIdentifier } : {},
        },
      });
      contractorsCreated++;
      nipToContractorId.set(nip, created.id);
    } else {
      contractorsCreated++;
    }
  }

  // ============ FAZA 2: FAKTURY ============
  let invoicesCreated = 0, invoicesUpdated = 0;
  for (const inv of invoices) {
    const ifirmaId = inv.FakturaId || null;
    if (!ifirmaId) continue;

    const rawNip = (inv.NIPKontrahenta || '').replace(/[\s\-]/g, '');
    const contractorId = rawNip ? (nipToContractorId.get(rawNip) || null) : null;
    const grossAmount = parseFloat(inv.Brutto || 0);
    const paidAmount = parseFloat(inv.Zaplacono || 0);
    const currency = (inv.Waluta || 'PLN').toUpperCase();
    const status = paidAmount >= grossAmount ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';
    // CRM v2 Etap 2.1 — snapshot kontrahenta z momentu wystawienia. City
    // nie istnieje w payloadzie iFirmy listy FV — uzupelni go backfill po
    // Contractor.city, ale nie blokujemy importu.
    const snapshotName = (inv.NazwaKontrahenta || '').replace(/^-+\s*/, '').trim() || null;
    const snapshotCountry = guessCountryFromInv(inv) || null;

    const existing = await prisma.invoice.findUnique({ where: { ifirmaId } });
    if (existing) {
      if (!dryRun) {
        // iFirma = zrodlo prawdy. Aktualizujemy tez grossAmount/currency (gdy
        // lista podaje Brutto), bo inaczej zawyzona/stara kwota z momentu
        // tworzenia nigdy sie nie poprawia, a status liczyl sie wzgledem niej
        // (efekt: "paid" mimo ze zapl. < kwoty, albo zawyzona kwota).
        const effGross = grossAmount > 0 ? grossAmount : parseFloat(existing.grossAmount || 0);
        const effStatus = paidAmount >= effGross ? 'paid' : paidAmount > 0 ? 'partial' : 'unpaid';
        const updateData = { paidAmount, status: effStatus };
        if (grossAmount > 0) { updateData.grossAmount = grossAmount; updateData.currency = currency; }
        if (!existing.ifirmaType && inv.Rodzaj) updateData.ifirmaType = inv.Rodzaj;
        // Backfill missing/placeholder number from iFirma (covers cases where
        // invoice-confirm parsed iFirma response into 'UNKNOWN' fallback).
        const realNumber = inv.PelnyNumer || '';
        if (realNumber && (!existing.number || existing.number === 'UNKNOWN' || existing.number === '')) {
          updateData.number = realNumber;
        }
        await prisma.invoice.update({ where: { ifirmaId }, data: updateData });
      }
      invoicesUpdated++;
    } else {
      if (!dryRun) {
        await prisma.invoice.create({
          data: {
            ifirmaId,
            contractorId,
            number: inv.PelnyNumer || '',
            issueDate: inv.DataWystawienia ? new Date(inv.DataWystawienia) : new Date(),
            dueDate: inv.TerminPlatnosci ? new Date(inv.TerminPlatnosci) : null,
            grossAmount,
            currency,
            paidAmount,
            status,
            type: inv.Rodzaj || null,
            ifirmaType: inv.Rodzaj || null,
            source: 'ifirma_sync',
            ifirmaContractorId: inv.IdentyfikatorKontrahenta ? String(inv.IdentyfikatorKontrahenta) : null,
            contractorName: snapshotName,
            contractorNip: rawNip || null,
            contractorCountry: snapshotCountry,
            extras: (() => {
              const e = { kontrahentNazwa: inv.NazwaKontrahenta || inv.KontrahentNazwa || '' };
              const positions = inv.Pozycje || inv.Positions || inv.Items;
              if (Array.isArray(positions) && positions.length) {
                e.items = positions.map(p => ({
                  name: p.NazwaPelna || p.Nazwa || p.name || '',
                  qty: parseFloat(p.Ilosc || p.qty || p.quantity || 1),
                  productEan: p.EAN || p.productEan || null,
                }));
              }
              return e;
            })(),
          },
        });
      }
      invoicesCreated++;
    }
  }

  // ============ FAZA 2.5: USUWANIE NIEISTNIEJĄCYCH W IFIRMA ============
  const deleted = [];
  if (dataOd && dataDo && !skipDelete) {
    const localInvoices = await prisma.invoice.findMany({
      where: { issueDate: { gte: new Date(dataOd), lte: new Date(dataDo + 'T23:59:59Z') } },
    });

    const ifirmaIds = new Set(invoices.map(i => i.FakturaId).filter(Boolean));
    const ifirmaNumbers = new Set(invoices.map(i => i.PelnyNumer).filter(Boolean));

    const toDelete = localInvoices.filter(local =>
      local.ifirmaId ? !ifirmaIds.has(local.ifirmaId) : !ifirmaNumbers.has(local.number),
    );

    // GUARD anty-masowe-kasowanie: pusta odpowiedź iFirmy przy niepustej lokalnej
    // bazie, albo kasowanie >50% lokalnych FV (gdy jest ich ≥5) to prawie na pewno
    // NIE "wszystko usunięte w iFirmie", tylko błąd API / przerwana paginacja.
    // Lepiej zostawić stary rekord niż skasować realną fakturę (kaskadowo
    // powiązania). Kasujemy tylko przy wiarygodnej odpowiedzi.
    const suspicious =
      (invoices.length === 0 && localInvoices.length > 0) ||
      (localInvoices.length >= 5 && toDelete.length / localInvoices.length > 0.5);

    if (suspicious) {
      console.warn(`[sync] FAZA 2.5 POMINIĘTA (ochrona): iFirma=${invoices.length} FV, lokalnych=${localInvoices.length}, do skasowania=${toDelete.length} dla ${dataOd}..${dataDo} — prawdopodobnie niepełna odpowiedź iFirmy, NIE kasuję.`);
    } else {
      for (const local of toDelete) {
        if (!dryRun) {
          try {
            await prisma.invoice.delete({ where: { id: local.id } });
          } catch (e) {
            console.error(`[sync] failed to delete invoice ${local.number}:`, e.message);
            continue;
          }
        }
        deleted.push({ id: local.id, number: local.number, ifirmaId: local.ifirmaId, grossAmount: Number(local.grossAmount) });
      }
    }
  }

  // ============ FAZA 3: LINKOWANIE EMAILI ============
  let linked = 0;
  if (!dryRun && !skipLink) {
    const allContractors = await prisma.contractor.findMany({ select: { id: true, name: true } });
    for (const contractor of allContractors) {
      if (!contractor.name || contractor.name.length < 4) continue;
      const updated = await prisma.email.updateMany({
        where: { contractorId: null, fromName: { contains: contractor.name, mode: 'insensitive' } },
        data: { contractorId: contractor.id },
      });
      linked += updated.count;
    }
  }

  // ============ TELEGRAM ============
  if (!silent && !dryRun && dataOd && dataDo && (invoicesCreated > 0 || invoicesUpdated > 0 || deleted.length > 0)) {
    try {
      const { sendTelegram } = require('../telegram-utils');
      const { resolveTelegram } = require('./telegram-helper');
      const __tg = await resolveTelegram(prisma, { scope: 'pl' });
      const tgToken = __tg.token;
      const tgChat = __tg.chatId;
      if (tgToken && tgChat) {
        const localCount = dataOd ? (await prisma.invoice.count({
          where: { issueDate: { gte: new Date(dataOd), lte: new Date(dataDo + 'T23:59:59Z') } },
        })) : '?';
        await sendTelegram(tgToken, tgChat,
          `🔄 Sync iFirma — ${dataOd} → ${dataDo}\n📊 iFirma: ${invoices.length} | Lokalne: ${localCount}\n🗑 Usunięte: ${deleted.length}\n📥 Nowe: ${invoicesCreated}\n✏️ Zaktualizowane: ${invoicesUpdated}`
        );
      }
    } catch (e) {
      console.error('[sync] Telegram notify error:', e.message);
    }
  }

  return {
    contractors: { created: contractorsCreated, skipped: contractorsSkipped },
    invoices: { created: invoicesCreated, updated: invoicesUpdated },
    deleted,
    deletedCount: deleted.length,
    linked,
  };
}

// Okno dat dla syncu z iFirmy. Domyslnie 60 dni wstecz, ALE rozszerzane tak,
// by objac NAJSTARSZA nieoplacona/czesciowa FV — bo platnosc moze zostac
// zaksiegowana dlugo po wystawieniu (FV z marca oplacona w czerwcu wypadala
// poza okno 60 dni i status "oplacona" nigdy nie wskakiwal do CRM). Cap od
// 2025-01-01, zeby nie ciagnac w nieskonczonosc.
async function computeSyncWindow(prisma) {
  const dataDo = new Date().toISOString().slice(0, 10);
  let fromMs = Date.now() - 60 * 24 * 60 * 60 * 1000;
  try {
    const oldestUnpaid = await prisma.invoice.findFirst({
      where: { ifirmaId: { not: null }, status: { in: ['unpaid', 'partial'] } },
      orderBy: { issueDate: 'asc' },
      select: { issueDate: true },
    });
    if (oldestUnpaid && oldestUnpaid.issueDate) {
      const t = new Date(oldestUnpaid.issueDate).getTime();
      if (Number.isFinite(t) && t < fromMs) fromMs = t;
    }
  } catch (_) { /* best-effort — zostajemy przy 60 dniach */ }
  const capMs = new Date('2025-01-01').getTime();
  if (fromMs < capMs) fromMs = capMs;
  return { dataOd: new Date(fromMs).toISOString().slice(0, 10), dataDo };
}

module.exports = { processIfirmaInvoices, guessCountryFromInv, computeSyncWindow };
