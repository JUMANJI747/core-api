'use strict';

/* KTO MOŻE ROZMAWIAĆ Z BOTAMI TELEGRAM (24.10.2026).
 *
 * Bot ma moce CRM i AI, a tryb „xxx" (sudo) czyta i ZMIENIA bazę. Do dziś
 * odpowiadał KAŻDEMU, kto znalazł go w Telegramie — 12.05.2026 nieznany czat
 * wysłał /start i dostał menu. Teraz polecenia wykonujemy tylko dla czatów
 * z listy:
 *   Config `telegram_dozwolone_czaty` (JSON ["8164…", …])
 *   ∪ env TELEGRAM_DOZWOLONE_CZATY (po przecinku)
 *   ∪ czat alertów (env TELEGRAM_CHAT_ID / Config telegram_chat_id).
 * Gdy listy w Config jeszcze nie ma, zakładamy ją z historii rozmów (Memory):
 * czaty z co najmniej PROG_HISTORII wiadomościami — jednorazowe /start nie
 * wchodzi. Błąd bazy = tylko czaty z env (zamknięte, nie otwarte). */

const KLUCZ = 'telegram_dozwolone_czaty';
const PROG_HISTORII = 5;
let cache = { t: 0, lista: null };

const zTekstu = (s) => String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(x => /^-?\d+$/.test(x));

async function dozwoloneCzaty(prisma) {
  if (cache.lista && Date.now() - cache.t < 60000) return cache.lista;
  const zbior = new Set([...zTekstu(process.env.TELEGRAM_DOZWOLONE_CZATY), ...zTekstu(process.env.TELEGRAM_CHAT_ID)]);
  try {
    const rows = await prisma.config.findMany({ where: { key: { in: [KLUCZ, 'telegram_chat_id'] } } });
    const wartosc = new Map(rows.map(r => [r.key, r.value]));
    zTekstu(wartosc.get('telegram_chat_id')).forEach(c => zbior.add(c));
    let lista;
    if (wartosc.has(KLUCZ)) {
      try { lista = JSON.parse(wartosc.get(KLUCZ)); } catch { lista = zTekstu(wartosc.get(KLUCZ)); }
    } else {
      const hist = await prisma.$queryRawUnsafe(
        `SELECT "chatId" AS c FROM "Memory" WHERE role = 'user' AND "chatId" IS NOT NULL GROUP BY 1 HAVING count(*) >= ${PROG_HISTORII}`);
      lista = hist.map(h => String(h.c));
      const value = JSON.stringify(lista);
      await prisma.config.upsert({ where: { key: KLUCZ }, update: { value }, create: { key: KLUCZ, value } });
      console.log(`[czaty-bota] lista dozwolonych czatów założona z historii: ${lista.length}`);
    }
    (Array.isArray(lista) ? lista : []).forEach(c => zbior.add(String(c)));
  } catch (e) {
    console.error('[czaty-bota] lista:', e.message);
  }
  cache = { t: Date.now(), lista: [...zbior] };
  return cache.lista;
}

async function czatDozwolony(prisma, chatId) {
  const c = String(chatId == null ? '' : chatId).trim();
  if (!c) return false;
  return (await dozwoloneCzaty(prisma)).includes(c);
}

module.exports = { dozwoloneCzaty, czatDozwolony, KLUCZ, PROG_HISTORII, _reset: () => { cache = { t: 0, lista: null }; } };
