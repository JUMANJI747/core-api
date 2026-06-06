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
  const { dataOd, dataDo, dryRun = false, silent = false } = opts;

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
        const updateData = { paidAmount, status };
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
  if (dataOd && dataDo) {
    const localInvoices = await prisma.invoice.findMany({
      where: { issueDate: { gte: new Date(dataOd), lte: new Date(dataDo + 'T23:59:59Z') } },
    });

    const ifirmaIds = new Set(invoices.map(i => i.FakturaId).filter(Boolean));
    const ifirmaNumbers = new Set(invoices.map(i => i.PelnyNumer).filter(Boolean));

    for (const local of localInvoices) {
      let foundInIfirma = false;
      if (local.ifirmaId) {
        foundInIfirma = ifirmaIds.has(local.ifirmaId);
      } else {
        foundInIfirma = ifirmaNumbers.has(local.number);
      }

      if (!foundInIfirma) {
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
  if (!dryRun) {
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

module.exports = { processIfirmaInvoices, guessCountryFromInv };
