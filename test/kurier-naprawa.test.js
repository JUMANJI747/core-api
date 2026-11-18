'use strict';
// Automatyczna naprawa auto-listu przez model (18.11.2026): reguły
// (services/kurier-naprawa.js), pętla z atrapą API oraz trasy magazynu
// (routes/magazyn.js) — bez sieci, bez prawdziwego GlobKuriera.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');

const SRC = path.join(__dirname, '..', 'src');
process.env.ANTHROPIC_API_KEY = 'test-nie-jest-uzywany';
const prawdziwa = require(path.join(SRC, 'services', 'kurier-naprawa'));
const { naprawKuriera, rodzajBledu, naruszeniaPoprawki, MODEL, MODEL_ZAPAS, MAX_ZAMOWIEN } = prawdziwa;

// ── reguły ──────────────────────────────────────────────────────────────────
test('rodzajBledu: brak środków i płatność → od razu właściciel; cena i ustawienia też; reszta do naprawy', () => {
  for (const t of [
    'zamówienie: Płatność w GlobKurier odrzucona: "Brak wystarczających środków na koncie". Sprawdź saldo konta GlobKurier.',
    'zamówienie: GlobKurier (DPD) odrzucił zamówienie: Niewystarczające środki na koncie prepaid',
    'zamówienie: GlobKurier (DPD) odrzucił zamówienie: Insufficient funds',
    'zamówienie: paymentId: Wartość nieprawidłowa',
    'zamówienie: GlobKurier (DPD) odrzucił zamówienie: Saldo konta jest zbyt niskie, doładuj konto',
    'zamówienie: GlobKurier (FedEx) odrzucił zamówienie: przekroczony limit kredytowy',
  ]) assert.equal(rodzajBledu(t), 'brak-srodkow', t);
  assert.equal(rodzajBledu('Cena kuriera za wysoka: 138,94 zł (FedEx), a przy składaniu zamówienia szacunek był 47,00 zł'), 'cena');
  assert.equal(rodzajBledu('brak nadawcy magazynu: ustaw Config magazyn_sender_id'), 'konfiguracja');
  assert.equal(rodzajBledu('wycena: GlobKurier HTTP 401: token wygasł'), 'konfiguracja');
  for (const t of [
    'zamówienie: Pole „nazwa” odbiorcy odrzucone przez GK: "Wpisano nieprawidłowy znak proszę o weryfikację np.: . , ” ” % & + ( ) / [] ;!". Wysłaliśmy: „EBENHOLZ skincare, Katja Miller”.',
    'zamówienie: Telefon odbiorcy (+48502189198) odrzucony przez GK: "Nieprawidłowy numer"',
    'zamówienie: GlobKurier timeout po 25000ms (POST /v1/order)',
    'zamówienie: Brak dostępnych terminów odbioru dla tego kuriera. Spróbuj innego (np. DPD zamiast InPost).',
    'adres nie przejdzie w GlobKurier: brakuje: numer domu',
    'wycena bez ofert',
    // nazwa odbiorcy z „payment"/„saldo" w środku to nadal błąd nazwy, nie płatności
    'zamówienie: Pole „nazwa” odbiorcy odrzucone przez GK: "Wpisano nieprawidłowy znak". Wysłaliśmy: „Payment & Saldo Solutions GmbH”. Popraw to pole i ponów.',
  ]) assert.equal(rodzajBledu(t), 'naprawialny', t);
});

const ADRES = { name: 'EBENHOLZ skincare, Katja Miller', street: 'Auf dem Gesetz', houseNumber: '7a', apartmentNumber: '', postCode: '56075', city: 'Koblenz', country: 'DE', phone: '+492611349740', email: 'k@ebenholz.de' };

test('naruszeniaPoprawki: zmiana ZAPISU przechodzi', () => {
  const ok = (stary, zmiana) => assert.deepEqual(naruszeniaPoprawki(stary, { ...stary, ...zmiana }), [], JSON.stringify(zmiana));
  ok(ADRES, { name: 'EBENHOLZ skincare Katja Miller' });                      // przecinek
  ok(ADRES, { name: 'EBENHOLZ skincare' });                                   // skrócenie
  ok({ ...ADRES, street: 'Auf dem Gesetz 7a', houseNumber: '' }, { street: 'Auf dem Gesetz', houseNumber: '7a' }); // podział
  ok({ ...ADRES, houseNumber: '7a/3' }, { houseNumber: '7a', apartmentNumber: '3' });
  ok({ ...ADRES, city: 'Rosignano Marittimo (LI)' }, { city: 'Rosignano Marittimo' });
  ok({ ...ADRES, street: 'Hauptstraße' }, { street: 'Hauptstrasse' });
  ok({ ...ADRES, phone: '0049 261 1349740' }, { phone: '+492611349740' });
  ok({ ...ADRES, postCode: '56 075' }, { postCode: '56075' });
});

test('naruszeniaPoprawki: zmiana TREŚCI jest odrzucana — paczka nie może pojechać gdzie indziej', () => {
  const zle = (zmiana, wzor, stary = ADRES) => {
    const w = naruszeniaPoprawki(stary, { ...stary, ...zmiana });
    assert.equal(w.length, 1, `${JSON.stringify(zmiana)} → ${JSON.stringify(w)}`);
    assert.match(w[0], wzor);
  };
  zle({ country: 'AT' }, /kraju nie wolno/);
  zle({ street: 'Auf dem Berg' }, /ulica\/numer\/lokal/);
  zle({ houseNumber: '7' }, /ulica\/numer\/lokal/);
  zle({ houseNumber: 'SNC' }, /ulica\/numer\/lokal/, { ...ADRES, houseNumber: '' }); // brakującego numeru nie zgadujemy
  zle({ postCode: '56076' }, /kod pocztowy/);
  zle({ city: 'Köln' }, /miasto/);
  zle({ city: 'Bern' }, /miasto/, { ...ADRES, city: 'Berlin' });
  zle({ city: 'Rosignano' }, /miasto/, { ...ADRES, city: 'Rosignano Marittimo' }); // ucięta część nazwy to nie „dopisek"
  zle({ city: '' }, /miasto/);
  zle({ name: '' }, /nazwa/);
  assert.deepEqual(naruszeniaPoprawki({ country: 'DE' }, { country: 'DE' }), [], 'puste pola bez zmian to nie naruszenie');
  zle({ name: 'Katja Mueller GmbH' }, /nazwa/);
  zle({ name: 'EB' }, /nazwa/);
  zle({ phone: '+492611349741' }, /telefon/);
  zle({ phone: '+49151000000' }, /wymyślać/, { ...ADRES, phone: '' });
  zle({ email: 'inny@ebenholz.de' }, /e-maila/);
});

// ── pętla modelu z atrapą API ───────────────────────────────────────────────
function atrapaApi(odpowiedzi) {
  const wywolania = [];
  const nast = async (p, kanal) => {
    wywolania.push({ kanal, p: JSON.parse(JSON.stringify(p)) });
    const o = odpowiedzi.shift();
    if (!o) throw new Error('atrapa API: zabrakło odpowiedzi');
    if (o instanceof Error) throw o;
    return typeof o === 'function' ? o(p) : o;
  };
  return { wywolania, messages: { create: (p) => nast(p, 'zwykly') }, beta: { messages: { create: (p) => nast(p, 'beta') } } };
}
let nrWywolania = 0;
const uzyj = (name, input = {}) => ({ type: 'tool_use', id: `toolu_${++nrWywolania}`, name, input });
const myslenie = { type: 'thinking', thinking: '', signature: 'sig-nie-do-ruszenia' };
const tura = (...content) => ({ model: MODEL, stop_reason: content.some(b => b.type === 'tool_use') ? 'tool_use' : 'end_turn', content, usage: { input_tokens: 100, output_tokens: 20 } });
const koniec = (tekst) => tura({ type: 'text', text: tekst });
const bladApi = (status, wiadomosc) => Anthropic.APIError.generate(status, { type: 'error', error: { type: 'x', message: wiadomosc } }, undefined, new Headers());

function atrapaNarzedzi(over = {}) {
  const dziennik = [];
  const n = {
    dziennik,
    sprawdzAdres: async (pola) => { dziennik.push(['sprawdz', pola]); return { adres: { ...ADRES, ...pola }, bledy: [], ostrzezenia: [] }; },
    poprawOdbiorce: async (pola, powod) => { dziennik.push(['popraw', pola, powod]); return { ok: true, zmiany: Object.keys(pola).map(k => ({ pole: k, bylo: ADRES[k], jest: pola[k], powod })) }; },
    wycen: async () => { dziennik.push(['wycen']); return { ok: true, oferty: [{ productId: 11, przewoznik: 'DPD', cena: 43.02 }, { productId: 22, przewoznik: 'UPS', cena: 51.4 }], limitCeny: 68.02 }; },
    zamow: async (a) => { dziennik.push(['zamow', a]); return { ok: true, gkNumber: 'GK1', przewoznik: 'DPD', cena: 43.02 }; },
    ...over,
  };
  return n;
}
const ZAM = { numer: 9, odbiorca: ADRES, paczka: { dlugoscCm: 29, szerokoscCm: 19, wysokoscCm: 10, wagaKg: 1.2 }, szacunekCeny: { cena: 43.02, limit: 68.02 } };
const BLAD_NAZWY = 'zamówienie: Pole „nazwa” odbiorcy odrzucone przez GK: "Wpisano nieprawidłowy znak…". Wysłaliśmy: „EBENHOLZ skincare, Katja Miller”.';

test('naprawa udana: poprawka nazwy → zamówienie → podsumowanie; kształt wywołań API', async () => {
  const api = atrapaApi([
    tura(myslenie, uzyj('popraw_odbiorce', { name: 'EBENHOLZ skincare Katja Miller', powod: 'przecinek w nazwie' })),
    tura(uzyj('zamow_kuriera', {})),
    koniec('Przyczyną był przecinek w nazwie. Zmieniłem „EBENHOLZ skincare, Katja Miller” → „EBENHOLZ skincare Katja Miller”. Kurier DPD zamówiony.'),
  ]);
  const narz = atrapaNarzedzi();
  const w = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: narz, klient: api });
  assert.equal(w.ok, true);
  assert.equal(w.zamowiono.gkNumber, 'GK1');
  assert.equal(w.proby, 1);
  assert.match(w.podsumowanie, /przecinek w nazwie/);
  assert.deepEqual(w.zmiany.map(z => [z.pole, z.jest]), [['name', 'EBENHOLZ skincare Katja Miller']]);
  assert.deepEqual(w.zuzycie, { wejscie: 300, wyjscie: 60, wywolan: 3 });
  assert.deepEqual(narz.dziennik.map(d => d[0]), ['popraw', 'zamow']);
  assert.deepEqual(narz.dziennik[0].slice(1), [{ name: 'EBENHOLZ skincare Katja Miller' }, 'przecinek w nazwie'], '`powod` nie trafia do pól adresu');

  // Pierwsze wywołanie: model, myślenie adaptacyjne, jawny wysiłek, fallback odmów; bez parametrów próbkowania.
  const p1 = api.wywolania[0];
  assert.equal(p1.kanal, 'beta');
  assert.equal(p1.p.model, 'claude-opus-5-5');
  assert.deepEqual(p1.p.thinking, { type: 'adaptive' });
  assert.deepEqual(p1.p.output_config, { effort: 'medium' });
  assert.deepEqual(p1.p.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(p1.p.fallbacks, 'default');
  for (const zakazany of ['temperature', 'top_p', 'top_k', 'tool_choice']) assert.ok(!(zakazany in p1.p), zakazany);
  assert.deepEqual(p1.p.tools.map(t => t.name), ['sprawdz_adres', 'popraw_odbiorce', 'wycen_kuriera', 'zamow_kuriera']);
  assert.match(p1.p.messages[0].content, /zamówienia magazynu #9/);
  assert.ok(p1.p.messages[0].content.includes(BLAD_NAZWY) && p1.p.messages[0].content.includes('"postCode": "56075"'));

  // Drugie: odpowiedź modelu wraca BEZ zmian (blok myślenia z podpisem), wynik narzędzia w wiadomości użytkownika.
  const m2 = api.wywolania[1].p.messages;
  assert.equal(m2.length, 3);
  assert.deepEqual(m2[1].content[0], myslenie);
  assert.equal(m2[1].content[1].type, 'tool_use');
  assert.equal(m2[2].role, 'user');
  assert.equal(m2[2].content.length, 1);
  assert.equal(m2[2].content[0].type, 'tool_result');
  assert.equal(m2[2].content[0].tool_use_id, m2[1].content[1].id);
  assert.ok(!('is_error' in m2[2].content[0]));
  assert.equal(JSON.parse(m2[2].content[0].content).ok, true);
});

test('kilka narzędzi w jednej turze: wszystkie wyniki w JEDNEJ wiadomości, w tej samej kolejności; błąd narzędzia = is_error', async () => {
  const a = uzyj('sprawdz_adres', { name: 'EBENHOLZ skincare' });
  const b = uzyj('wycen_kuriera', {});
  const c = uzyj('nieznane_narzedzie', {});
  const api = atrapaApi([tura(a, b, c), koniec('Nie da się.')]);
  const w = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: atrapaNarzedzi(), klient: api });
  assert.equal(w.ok, false);
  const wyniki = api.wywolania[1].p.messages[2].content;
  assert.deepEqual(wyniki.map(x => x.tool_use_id), [a.id, b.id, c.id]);
  assert.deepEqual(wyniki.map(x => !!x.is_error), [false, false, true]);
  assert.equal(api.wywolania[1].p.messages.length, 3, 'jedna wiadomość z wynikami, nie trzy');
  assert.equal(w.podsumowanie, 'Nie da się.');
});

test('limit prób zamówienia: po trzech odmowach czwarta próba nie dociera do GlobKuriera', async () => {
  const narz = atrapaNarzedzi({ zamow: async () => { narz.dziennik.push(['zamow']); return { ok: false, blad: BLAD_NAZWY }; } });
  const api = atrapaApi([tura(uzyj('zamow_kuriera')), tura(uzyj('zamow_kuriera')), tura(uzyj('zamow_kuriera')), tura(uzyj('zamow_kuriera')), koniec('Nie udało się — GlobKurier odrzuca nazwę.')]);
  const w = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: narz, klient: api });
  assert.equal(w.ok, false);
  assert.equal(w.proby, MAX_ZAMOWIEN);
  assert.equal(narz.dziennik.filter(d => d[0] === 'zamow').length, 3);
  const czwarty = JSON.parse(api.wywolania[4].p.messages.at(-1).content[0].content);
  assert.match(czwarty.blad, /Wykorzystano 3 próby/);
  assert.equal(w.ostatniBlad, BLAD_NAZWY);
  assert.match(w.podsumowanie, /odrzuca nazwę/);
});

test('po udanym zamówieniu model nie zamówi drugi raz, nawet gdy spróbuje', async () => {
  const narz = atrapaNarzedzi();
  const api = atrapaApi([tura(uzyj('zamow_kuriera')), tura(uzyj('zamow_kuriera', { productId: 22 })), koniec('Kurier zamówiony.')]);
  const w = await naprawKuriera({ zamowienie: ZAM, blad: 'zamówienie: GlobKurier timeout po 25000ms (POST /v1/order)', narzedzia: narz, klient: api });
  assert.equal(w.ok, true);
  assert.equal(narz.dziennik.filter(d => d[0] === 'zamow').length, 1);
  assert.match(JSON.parse(api.wywolania[2].p.messages.at(-1).content[0].content).blad, /już zamówiony/);
});

test('wybór innego przewoźnika: productId z wyceny trafia do narzędzia jako liczba', async () => {
  const narz = atrapaNarzedzi();
  const api = atrapaApi([tura(uzyj('wycen_kuriera')), tura(uzyj('zamow_kuriera', { productId: '22' })), koniec('Zamówiony UPS.')]);
  await naprawKuriera({ zamowienie: ZAM, blad: 'zamówienie: Brak dostępnych terminów odbioru dla DPD', narzedzia: narz, klient: api });
  assert.deepEqual(narz.dziennik.at(-1), ['zamow', { productId: 22 }]);
});

test('brak środków wychodzi dopiero przy ponowieniu: naprawa kończy od razu, bez kolejnych pytań do modelu', async () => {
  const narz = atrapaNarzedzi({ zamow: async () => ({ ok: false, blad: 'zamówienie: Płatność w GlobKurier odrzucona: "Brak środków". Sprawdź saldo konta GlobKurier.' }) });
  const api = atrapaApi([tura(uzyj('zamow_kuriera')), koniec('nie powinno tu dojść')]);
  const w = await naprawKuriera({ zamowienie: ZAM, blad: 'zamówienie: GlobKurier timeout po 25000ms (POST /v1/order)', narzedzia: narz, klient: api });
  assert.equal(w.ok, false);
  assert.equal(w.brakSrodkow, true);
  assert.equal(api.wywolania.length, 1);
  assert.equal(w.powodKonca, 'brak środków w GlobKurier');
  assert.match(w.ostatniBlad, /Płatność w GlobKurier odrzucona/);
});

test('odmowa i ucięta odpowiedź: treść nie jest używana, wynik = nieudana z powodem', async () => {
  const odmowa = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: atrapaNarzedzi(), klient: atrapaApi([{ model: MODEL, stop_reason: 'refusal', content: [], usage: { input_tokens: 5, output_tokens: 0 } }]) });
  assert.equal(odmowa.ok, false);
  assert.equal(odmowa.powodKonca, 'model odmówił wykonania zadania');
  assert.match(odmowa.podsumowanie, /nie doprowadziła do zamówienia kuriera.*model odmówił/);
  const narz = atrapaNarzedzi();
  const uciete = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: narz, klient: atrapaApi([{ model: MODEL, stop_reason: 'max_tokens', content: [uzyj('zamow_kuriera')], usage: {} }]) });
  assert.equal(uciete.powodKonca, 'odpowiedź modelu została ucięta');
  assert.equal(narz.dziennik.length, 0, 'ucięte wywołanie narzędzia nie jest wykonywane');
});

test('awaria API: naprawa nieudana z czytelnym powodem (klucz, limit, sieć)', async () => {
  const przy = async (blad) => naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: atrapaNarzedzi(), klient: atrapaApi([blad]) });
  assert.match((await przy(bladApi(401, 'invalid x-api-key'))).powodKonca, /awaria modelu: zły klucz Anthropic/);
  assert.match((await przy(bladApi(429, 'rate limit'))).powodKonca, /limit zapytań Anthropic/);
  assert.match((await przy(new Anthropic.APIConnectionError({ message: 'Connection error.' }))).powodKonca, /brak połączenia z Anthropic/);
  assert.match((await przy(bladApi(529, 'overloaded'))).powodKonca, /awaria modelu: Anthropic 529/);
});

test('model niedostępny dla klucza → zapasowy; API nie zna `fallbacks` → to samo bez niego', async () => {
  const api = atrapaApi([bladApi(404, 'model: claude-opus-5-5'), { ...koniec('Brakuje numeru domu — nie zgaduję.'), model: MODEL_ZAPAS }]);
  const w = await naprawKuriera({ zamowienie: ZAM, blad: 'adres nie przejdzie w GlobKurier: brakuje: numer domu', narzedzia: atrapaNarzedzi(), klient: api });
  assert.equal(w.zapas, true);
  assert.equal(w.model, MODEL_ZAPAS);
  assert.deepEqual(api.wywolania.map(x => [x.kanal, x.p.model]), [['beta', 'claude-opus-5-5'], ['zwykly', 'claude-opus-4-8']]);
  assert.ok(!('fallbacks' in api.wywolania[1].p) && !('betas' in api.wywolania[1].p));
  assert.deepEqual(api.wywolania[1].p.thinking, { type: 'adaptive' });

  const api2 = atrapaApi([bladApi(400, 'fallbacks: Extra inputs are not permitted'), tura(uzyj('zamow_kuriera')), koniec('Zamówiony.')]);
  const w2 = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: atrapaNarzedzi(), klient: api2 });
  assert.equal(w2.ok, true);
  assert.equal(w2.bezFallbackow, true);
  assert.deepEqual(api2.wywolania.map(x => [x.kanal, x.p.model]), [['beta', 'claude-opus-5-5'], ['zwykly', 'claude-opus-5-5'], ['zwykly', 'claude-opus-5-5']]);
});

test('limit czasu naprawy: po 4 minutach nie pyta modelu dalej', async () => {
  let t = 1_000_000;
  const api = atrapaApi([tura(uzyj('wycen_kuriera')), koniec('za późno')]);
  const narz = atrapaNarzedzi({ wycen: async () => { t += 5 * 60 * 1000; return { ok: true, oferty: [] }; } });
  const w = await naprawKuriera({ zamowienie: ZAM, blad: BLAD_NAZWY, narzedzia: narz, klient: api, teraz: () => t });
  assert.equal(w.powodKonca, 'limit czasu naprawy');
  assert.equal(api.wywolania.length, 1);
  assert.equal(w.ok, false);
});

// ── trasy magazynu: podstawione GlobKurier, Telegram, model ─────────────────
function podstaw(plik, eksport) {
  const p = require.resolve(path.join(SRC, plik));
  require.cache[p] = { id: p, filename: p, loaded: true, exports: eksport };
}
const S = { telegram: [], gk: null, listaGk: null, napraw: null };
podstaw('mail-sender.js', { sendMail: async () => ({ id: 'm' }) });
podstaw('services/product-catalog.js', { getActiveCatalog: async () => [] });
podstaw('services/telegram-helper.js', { resolveTelegram: async () => ({ token: 'T', chatId: '1' }) });
podstaw('telegram-utils.js', { sendTelegram: async (t, c, tekst) => { S.telegram.push(String(tekst)); return { ok: true }; } });
podstaw('services/agent-runtime.js', { selfCall: async (metoda, sciezka, body) => S.gk(sciezka, body) });
podstaw('glob-client.js', { getOrderLabels: async () => ({ status: 404 }), fetchOrdersPaged: async () => S.listaGk(), findOrderInList: () => null });
podstaw('services/kurier-naprawa.js', { ...prawdziwa, naprawKuriera: (a) => S.napraw(a) });
const magazyn = require(path.join(SRC, 'routes', 'magazyn'));
const T = magazyn._test;

const OFERTY = [{ productId: 11, carrier: 'DPD', name: 'DPD Classic', price: 43.02, currency: 'PLN' }, { productId: 22, carrier: 'UPS', name: 'UPS Standard', price: 51.4, currency: 'PLN' }, { productId: 33, carrier: 'FedEx', name: 'Priority', price: 140, currency: 'PLN' }];
/** Atrapa GlobKuriera: wycena zawsze OK; zamówienie wg `zamowienie(body, nr)`. */
function gk(zamowienie) {
  const wolania = [];
  S.gk = async (sciezka, body) => {
    wolania.push([sciezka, body]);
    if (sciezka === '/api/glob/quote') return { status: 200, body: { ok: true, quoteId: `q${wolania.length}`, offers: OFERTY } };
    if (sciezka === '/api/glob/order') return zamowienie(body, wolania.filter(w => w[0] === '/api/glob/order').length);
    return { status: 404, body: {} };
  };
  return wolania;
}
const odmowa = (error) => ({ status: 200, body: { ok: false, error } });
const przyjete = (n = 'GK777') => ({ status: 200, body: { ok: true, hash: `hash-${n}`, orderNumber: n, carrier: 'DPD' } });

function zam(over = {}) {
  return {
    id: 'z9', numer: 9, status: 'NOWE', autoList: true, odbiorca: { ...ADRES, name: 'EBENHOLZ skincare Katja Miller' },
    items: [{ id: 'i1', ean: '5902082556022', name: 'Surf Stick Blue', variant: null, symbol: 'BSS 01', qty: 30, packaging: false, sort: 0 }],
    dokumenty: [], contractor: null, kurierSzacunek: { cena: 43.02, przewoznik: 'DPD' }, kurierBlad: null, kurierNaprawa: null,
    gkNumber: null, gkHash: null, ...over,
  };
}
function baza(z, inne = []) {
  const stan = { z: { ...z }, aktualizacje: [] };
  const db = {
    stan,
    warehouseOrder: {
      findUnique: async ({ where }) => (where.id === stan.z.id ? stan.z : null),
      findFirst: async ({ where }) => inne.find(x => (where.OR || []).some(w => (w.gkNumber && w.gkNumber === x.gkNumber) || (w.gkHash && w.gkHash === x.gkHash))) || null,
      findMany: async () => [stan.z].filter(x => x.status === 'GOTOWE' && x.kurierNaprawa && x.kurierNaprawa.stan === 'w-toku'),
      update: async ({ data }) => { stan.aktualizacje.push(data); stan.z = { ...stan.z, ...data }; return stan.z; },
      updateMany: async ({ where, data }) => {
        if (where.status && stan.z.status !== where.status) return { count: 0 };
        stan.aktualizacje.push(data); stan.z = { ...stan.z, ...data }; return { count: 1 };
      },
    },
    stockMovement: { groupBy: async () => [], createMany: async () => ({ count: 0 }) },
    warehouseBox: { findFirst: async () => null },
    config: { findUnique: async () => ({ value: 'nadawca1' }) },
    sender: { findUnique: async () => ({ id: 'nadawca1', name: 'Magazyn Bell', city: 'Józefów' }) },
  };
  db.$transaction = async (fn) => fn(db);
  return db;
}
async function zapytaj(db, metoda, sciezka, { rola = 'owner', body } = {}) {
  const app = express();
  app.use(express.json());
  app.locals.prisma = db;
  app.use((req, _res, next) => { req.crm = rola === 'magazyn' ? { user: 'm.urbaniak@bell.com.pl', role: 'magazyn' } : { user: 'michal', role: 'owner' }; next(); });
  app.use('/', magazyn);
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}${sciezka}`, { method: metoda, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json() };
  } finally { serwer.close(); }
}
const KARTON = { dlugoscCm: 29, szerokoscCm: 19, wysokoscCm: 10 };
const spakuj = (db) => zapytaj(db, 'POST', '/zamowienia/z9/gotowe', { rola: 'magazyn', body: KARTON });
/** Czeka, aż naprawa w tle się skończy (stan inny niż „w-toku"). */
async function poNaprawie(db) {
  for (let i = 0; i < 200; i++) {
    if (!T._naprawyWToku.has('z9') && (db.stan.z.kurierNaprawa || {}).stan !== 'w-toku') return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('naprawa w tle się nie skończyła');
}
const czysto = () => { S.telegram.length = 0; S.listaGk = async () => []; S.napraw = async () => { throw new Error('model nie powinien być wołany'); }; };
/** Wynik naprawy w kształcie naprawKuriera. */
const wynikNaprawy = (over = {}) => ({ ok: false, zamowiono: null, podsumowanie: 'GlobKurier odrzuca nazwę odbiorcy.', zmiany: [], kroki: [], proby: 1, model: MODEL, zapas: false, powodKonca: null, brakSrodkow: false, ostatniBlad: BLAD_NAZWY, zuzycie: { wejscie: 1, wyjscie: 1, wywolan: 1 }, trwaloMs: 1200, ...over });

test('auto-list udany: bez modelu i bez Telegrama', async () => {
  czysto(); gk(() => przyjete());
  const db = baza(zam());
  const r = await spakuj(db);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.zamowienie.status, 'KURIER');
  assert.equal(r.json.zamowienie.gkNumber, 'GK777');
  assert.equal(r.json.zamowienie.kurierNaprawa, null);
  assert.equal(db.stan.z.zatwierdzilKto, 'auto-list');
  assert.equal(db.stan.z.kurierCena, 43.02);
  assert.deepEqual(S.telegram, []);
});

test('brak środków w GlobKurier: Telegram OD RAZU, model nie jest wołany', async () => {
  czysto(); gk(() => odmowa('Płatność w GlobKurier odrzucona: "Brak wystarczających środków na koncie". Sprawdź saldo konta GlobKurier.'));
  const db = baza(zam());
  const r = await spakuj(db);
  assert.equal(r.json.zamowienie.status, 'GOTOWE');
  assert.equal(r.json.zamowienie.kurierNaprawa, null);
  assert.match(r.json.zamowienie.kurierBlad, /Płatność w GlobKurier odrzucona/);
  assert.equal(S.telegram.length, 1);
  assert.match(S.telegram[0], /^🛑 Magazyn #9 \(EBENHOLZ skincare Katja Miller, Koblenz\): paczka spakowana, kurier NIE zamówiony — GlobKurier odrzucił płatność \(brak środków na koncie\)\./);
  assert.match(S.telegram[0], /Doładuj konto GlobKurier i kliknij „Ponów auto-list”/);
});

test('bezpiecznik ceny: od razu do właściciela, model nie może go obejść', async () => {
  czysto();
  S.gk = async (sciezka) => (sciezka === '/api/glob/quote' ? { status: 200, body: { ok: true, quoteId: 'q', offers: [OFERTY[2]] } } : przyjete());
  const db = baza(zam());
  const r = await spakuj(db);
  assert.equal(r.json.zamowienie.status, 'GOTOWE');
  assert.equal(r.json.zamowienie.kurierNaprawa, null);
  assert.equal(S.telegram.length, 1);
  assert.match(S.telegram[0], /NIE udało się zamówić kuriera[\s\S]*Cena kuriera za wysoka: 140,00 zł[\s\S]*Zamów mimo to/);
});

test('odmowa GlobKuriera → naprawa w tle; magazyn od razu dostaje odpowiedź ze stanem „w toku"', async () => {
  czysto();
  const wolania = gk((body, nr) => (nr === 1 ? odmowa('Pole „nazwa” odbiorcy odrzucone przez GK: "Wpisano nieprawidłowy znak".') : przyjete('GK888')));
  let dostal = null;
  let puscModel;
  const brama = new Promise(r => { puscModel = r; }); // model „myśli", dopóki test nie sprawdzi odpowiedzi dla magazynu
  S.napraw = async ({ zamowienie, blad, narzedzia }) => {
    dostal = { zamowienie, blad };
    await brama;
    const p = await narzedzia.poprawOdbiorce({ name: 'EBENHOLZ skincare' }, 'krótsza nazwa');
    const z = await narzedzia.zamow({ productId: null });
    return wynikNaprawy({ ok: z.ok, zamowiono: z, zmiany: p.zmiany, podsumowanie: 'Skróciłem nazwę: „EBENHOLZ skincare Katja Miller” → „EBENHOLZ skincare”. Kurier DPD zamówiony.' });
  };
  const db = baza(zam());
  const r = await spakuj(db);
  assert.equal(r.status, 200);
  assert.equal(r.json.zamowienie.status, 'GOTOWE');
  assert.deepEqual(r.json.zamowienie.kurierNaprawa, { stan: 'w-toku' }, 'magazyn widzi sam stan');
  assert.deepEqual(S.telegram, [], 'Telegram dopiero z wynikiem naprawy');
  assert.equal(db.stan.z.status, 'GOTOWE', 'odpowiedź nie czekała na model');
  puscModel();
  await poNaprawie(db);

  assert.match(dostal.blad, /Pole „nazwa” odbiorcy odrzucone/);
  assert.equal(dostal.zamowienie.numer, 9);
  assert.deepEqual(dostal.zamowienie.paczka, { dlugoscCm: 29, szerokoscCm: 19, wysokoscCm: 10, wagaKg: db.stan.z.wagaKg });
  assert.equal(db.stan.z.status, 'KURIER');
  assert.equal(db.stan.z.gkNumber, 'GK888');
  assert.equal(db.stan.z.odbiorca.name, 'EBENHOLZ skincare');
  assert.equal(db.stan.z.zatwierdzilKto, 'auto-list (naprawa)');
  assert.equal(db.stan.z.kurierBlad, null);
  assert.equal(db.stan.z.kurierNaprawa.stan, 'udana');
  assert.equal(wolania.filter(w => w[0] === '/api/glob/order').length, 2);
  assert.equal(S.telegram.length, 1);
  assert.match(S.telegram[0], /^🔧 Magazyn #9[\s\S]*kurier zamówiony po automatycznej naprawie[\s\S]*Skróciłem nazwę[\s\S]*Kurier: DPD, 43,02 zł, GK888\./);

  const wl = (await zapytaj(db, 'GET', '/zamowienia/z9')).json.zamowienie;
  assert.equal(wl.kurierNaprawa.stan, 'udana');
  assert.match(wl.kurierNaprawa.podsumowanie, /Skróciłem nazwę/);
  assert.deepEqual(wl.kurierNaprawa.zmiany.map(z => [z.pole, z.bylo, z.jest]), [['nazwa', 'EBENHOLZ skincare Katja Miller', 'EBENHOLZ skincare']]);
  const mag = (await zapytaj(db, 'GET', '/zamowienia/z9', { rola: 'magazyn' })).json.zamowienie;
  assert.deepEqual(mag.kurierNaprawa, { stan: 'udana' });
  assert.equal(mag.zatwierdzilKto, 'auto-list');
});

test('naprawa nieudana → Telegram „NIE udało się zamówić kuriera" z ostatnim błędem i podsumowaniem', async () => {
  czysto(); gk(() => odmowa('Telefon odbiorcy (+48502189198) odrzucony przez GK: "Nieprawidłowy numer".'));
  S.napraw = async () => wynikNaprawy({ ostatniBlad: 'zamówienie: Telefon odbiorcy (+48502189198) odrzucony przez GK', podsumowanie: 'Telefon jest polski, a odbiorca w Niemczech — potrzebny niemiecki numer. Kurier nie jest zamówiony.' });
  const db = baza(zam({ odbiorca: { ...ADRES, name: 'EBENHOLZ skincare', phone: '+48502189198' } }));
  await spakuj(db);
  await poNaprawie(db);
  assert.equal(db.stan.z.status, 'GOTOWE');
  assert.equal(db.stan.z.kurierNaprawa.stan, 'nieudana');
  assert.match(db.stan.z.kurierBlad, /Telefon odbiorcy/);
  assert.equal(S.telegram.length, 1);
  assert.match(S.telegram[0], /^⚠️ Magazyn #9 \(EBENHOLZ skincare, Koblenz\): paczka spakowana, ale NIE udało się zamówić kuriera\.\nBłąd: zamówienie: Telefon odbiorcy[\s\S]*Automatyczna naprawa \(claude-opus-5-5\) nie pomogła: Telefon jest polski/);
  const mag = (await zapytaj(db, 'GET', '/zamowienia/z9', { rola: 'magazyn' })).json.zamowienie;
  assert.deepEqual(mag.kurierNaprawa, { stan: 'nieudana' });
});

test('brak środków wykryty w trakcie naprawy → komunikat o braku środków, nie ogólny', async () => {
  czysto(); gk(() => odmowa('GlobKurier (DPD) odrzucił zamówienie: błąd wewnętrzny 17'));
  S.napraw = async () => wynikNaprawy({ brakSrodkow: true, ostatniBlad: 'zamówienie: Płatność w GlobKurier odrzucona: "Brak środków".' });
  const db = baza(zam());
  await spakuj(db);
  await poNaprawie(db);
  assert.equal(S.telegram.length, 1);
  assert.match(S.telegram[0], /^🛑 Magazyn #9[\s\S]*odrzucił płatność[\s\S]*Brak środków/);
});

test('model wyłączony (brak klucza albo KURIER_NAPRAWA=0): zostaje zwykły alarm od razu', async () => {
  czysto(); gk(() => odmowa('Pole „nazwa” odbiorcy odrzucone przez GK'));
  process.env.KURIER_NAPRAWA = '0';
  try {
    const db = baza(zam());
    const r = await spakuj(db);
    assert.equal(r.json.zamowienie.kurierNaprawa, null);
    assert.equal(S.telegram.length, 1);
    assert.match(S.telegram[0], /NIE udało się zamówić kuriera/);
  } finally { delete process.env.KURIER_NAPRAWA; }
});

test('narzędzia naprawy: zmiana treści adresu odrzucona i NIE zapisana; zmiana zapisu zapisana z listą zmian', async () => {
  czysto(); gk(() => przyjete());
  const db = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2 }));
  const narz = T.narzedziaNaprawy(db, 'z9');
  const zla = await narz.poprawOdbiorce({ street: 'Auf dem Berg', city: 'Bonn' }, 'zgaduję');
  assert.equal(zla.ok, false);
  assert.match(zla.blad, /zmiana treści, nie zapisu[\s\S]*ulica\/numer\/lokal[\s\S]*miasto/);
  assert.equal(db.stan.aktualizacje.length, 0);
  const brak = await narz.poprawOdbiorce({ phone: '12' }, 'x');
  assert.match(brak.blad, /adres po zmianie nie przejdzie: telefon „12” nieczytelny/);
  const dobra = await narz.poprawOdbiorce({ name: 'EBENHOLZ skincare', kraj: 'AT', country: 'AT', email: 'x@y.pl' }, 'krócej');
  assert.equal(dobra.ok, true);
  assert.deepEqual(dobra.zmiany, [{ pole: 'nazwa', bylo: 'EBENHOLZ skincare Katja Miller', jest: 'EBENHOLZ skincare', powod: 'krócej' }]);
  assert.equal(db.stan.z.odbiorca.country, 'DE', 'kraju i e-maila model nie ustawia');
  assert.equal(db.stan.z.odbiorca.email, 'k@ebenholz.de');
  // Seria skróceń liczy się od adresu SPRZED naprawy — nazwa nie znika po kawałku.
  assert.equal((await narz.poprawOdbiorce({ name: 'EBENHOLZ' }, 'jeszcze krócej')).ok, true);
  const zaKrotka = await narz.poprawOdbiorce({ name: 'EBEN' }, 'i jeszcze');
  assert.equal(zaKrotka.ok, false);
  assert.match(zaKrotka.blad, /nazwa: wolno skrócić.*„EBENHOLZ skincare Katja Miller” → „EBEN”/);
  assert.equal(db.stan.z.odbiorca.name, 'EBENHOLZ');
  const spr = await narz.sprawdzAdres({ city: 'Koblenz (RP)' });
  assert.equal(spr.adres.city, 'Koblenz');
  assert.deepEqual(spr.zmianaTresci, []);
  const wyc = await narz.wycen();
  assert.deepEqual(wyc.oferty.map(o => [o.productId, o.przewoznik, o.cena]), [[11, 'DPD', 43.02], [22, 'UPS', 51.4], [33, 'FedEx', 140]]);
  assert.equal(wyc.limitCeny, 68.02);
});

test('narzędzie zamow: inny przewoźnik w limicie przechodzi, powyżej limitu nie; zamówienie w złym stanie — nigdy', async () => {
  czysto();
  const wolania = gk(() => przyjete('GK901'));
  const db = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2 }));
  const narz = T.narzedziaNaprawy(db, 'z9');
  const drogo = await narz.zamow({ productId: 33 });
  assert.equal(drogo.ok, false);
  assert.match(drogo.blad, /Cena kuriera za wysoka: 140,00 zł/);
  assert.equal(wolania.filter(w => w[0] === '/api/glob/order').length, 0);
  const nieMa = await narz.zamow({ productId: 999 });
  assert.match(nieMa.blad, /oferty 999 nie ma w aktualnej wycenie/);
  const ups = await narz.zamow({ productId: 22 });
  assert.equal(ups.ok, true);
  assert.deepEqual(wolania.at(-1), ['/api/glob/order', { quoteId: wolania.at(-1)[1].quoteId, productId: 22 }]);
  assert.equal(db.stan.z.status, 'KURIER');
  assert.equal(db.stan.z.kurierCena, 51.4);
  const drugi = await narz.zamow({ productId: null });
  assert.equal(drugi.ok, false);
  assert.match(drugi.blad, /stanie KURIER/);
  assert.equal(wolania.filter(w => w[0] === '/api/glob/order').length, 1, 'drugiego zlecenia nie ma');
});

// ── GlobKurier nie odpowiedział przy zamawianiu: zlecenie mogło powstać ─────
const teraz = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', dateStyle: 'short', timeStyle: 'medium' }).format(new Date());
const zlecenieGk = (over = {}) => ({ number: 'GK555', hash: 'hash-555', status: 'NEW', creationDate: teraz(), carrier: { id: 11, name: 'DPD' }, pricing: { priceGross: 44.85 }, receiverAddress: { name: 'EBENHOLZ skincare Katja Miller', street: 'Auf dem Gesetz', houseNumber: '7a', postCode: '56075', city: 'Koblenz' }, ...over });

test('czas GK jest warszawski; niepewny jest tylko błąd z fazy zamawiania', () => {
  assert.equal(new Date(T.czasGkNaMs('2026-11-18 13:26:15')).toISOString(), '2026-11-18T12:26:15.000Z');
  assert.equal(new Date(T.czasGkNaMs('2026-07-01 10:00:00')).toISOString(), '2026-07-01T08:00:00.000Z');
  assert.equal(T.czasGkNaMs('wczoraj'), null);
  assert.equal(T.niepewnyZapisany('zamówienie: GlobKurier timeout po 25000ms (POST /v1/order)'), true);
  assert.equal(T.niepewnyZapisany('zamówienie: HTTP 500'), true);
  assert.equal(T.niepewnyZapisany('zamówienie: GlobKurier nie potwierdził zamówienia (brak numeru/hash w odpowiedzi).'), true);
  assert.equal(T.niepewnyZapisany('wycena: GlobKurier timeout po 25000ms (POST /v1/products)'), false, 'wycena niczego nie tworzy');
  assert.equal(T.niepewnyZapisany('zamówienie: Pole „nazwa” odbiorcy odrzucone przez GK'), false);
});

test('swiezeZlecenieGk: ten sam odbiorca i kod, po czasie próby, niepodpięte gdzie indziej', async () => {
  const o = zam({ status: 'GOTOWE' });
  const od = Date.now() - 60 * 1000;
  const szukaj = (lista, inne = []) => T.swiezeZlecenieGk(baza(o, inne), o, od, async () => lista);
  assert.deepEqual(await szukaj([zlecenieGk()]), { gkNumber: 'GK555', gkHash: 'hash-555', carrier: 'DPD', cena: 44.85 });
  assert.equal((await szukaj([zlecenieGk({ receiverAddress: { name: 'EBENHOLZ skincare Katja', postCode: '56075' } })])).gkNumber, 'GK555', 'nazwa ucięta przez GK');
  assert.equal((await szukaj([zlecenieGk({ receiverAddress: { name: 'Katja Miller', street: 'Auf dem Gesetz', houseNumber: '7a', postCode: '56075' } })])).gkNumber, 'GK555', 'inna nazwa, ta sama ulica i kod');
  assert.equal(await szukaj([zlecenieGk({ receiverAddress: { name: 'EBENHOLZ skincare Katja Miller', postCode: '50667' } })]), null, 'inny kod pocztowy');
  assert.equal(await szukaj([zlecenieGk({ receiverAddress: { name: 'Salted Berlin', street: 'Zeughofstraße', houseNumber: '20', postCode: '56075' } })]), null, 'inny odbiorca');
  assert.equal(await szukaj([zlecenieGk({ creationDate: '2026-11-10 09:45:00' })]), null, 'stare zlecenie do tego samego odbiorcy');
  assert.equal(await szukaj([zlecenieGk({ status: 'CANCELED' })]), null);
  assert.equal(await szukaj([zlecenieGk()], [{ id: 'inne', gkNumber: 'GK555' }]), null, 'podpięte pod inne zamówienie magazynu');
  await assert.rejects(T.swiezeZlecenieGk(baza(o), o, od, async () => { throw new Error('GlobKurier timeout'); }), /timeout/);
});

test('limit czasu przy zamawianiu, zlecenie JEDNAK powstało: naprawa podpina je i NIE zamawia drugiego', async () => {
  czysto();
  const wolania = gk(() => ({ status: 500, body: { error: 'GlobKurier timeout po 25000ms (POST /v1/order)' } }));
  S.listaGk = async () => [zlecenieGk()];
  S.napraw = async ({ narzedzia }) => {
    const z = await narzedzia.zamow({ productId: null });
    return wynikNaprawy({ ok: z.ok, zamowiono: z, podsumowanie: 'GlobKurier nie odpowiedział na czas, ale zlecenie powstało — podpięte.' });
  };
  const db = baza(zam());
  const r = await spakuj(db);
  assert.deepEqual(r.json.zamowienie.kurierNaprawa, { stan: 'w-toku' });
  await poNaprawie(db);
  assert.equal(wolania.filter(w => w[0] === '/api/glob/order').length, 1, 'tylko pierwsza, zawieszona próba');
  assert.equal(db.stan.z.status, 'KURIER');
  assert.equal(db.stan.z.gkNumber, 'GK555');
  assert.equal(db.stan.z.gkHash, 'hash-555');
  assert.equal(db.stan.z.kurierCena, 44.85);
  assert.match(S.telegram[0], /^🔧[\s\S]*Kurier: DPD, 44,85 zł, GK555\./);
});

test('limit czasu, zlecenia NIE ma na liście: naprawa zamawia; gdy listy nie da się sprawdzić — nie zamawia w ciemno', async () => {
  czysto();
  let wolania = gk((body, nr) => (nr === 1 ? { status: 500, body: { error: 'GlobKurier timeout po 25000ms (POST /v1/order)' } } : przyjete('GK602')));
  S.listaGk = async () => [zlecenieGk({ receiverAddress: { name: 'Ktoś inny', postCode: '00-001' } })];
  S.napraw = async ({ narzedzia }) => { const z = await narzedzia.zamow({ productId: null }); return wynikNaprawy({ ok: z.ok, zamowiono: z.ok ? z : null, ostatniBlad: z.blad }); };
  let db = baza(zam());
  await spakuj(db); await poNaprawie(db);
  assert.equal(db.stan.z.gkNumber, 'GK602');
  assert.equal(wolania.filter(w => w[0] === '/api/glob/order').length, 2);

  czysto();
  wolania = gk(() => ({ status: 500, body: { error: 'GlobKurier timeout po 25000ms (POST /v1/order)' } }));
  S.listaGk = async () => { throw new Error('GlobKurier timeout po 25000ms (GET /v1/orders)'); };
  S.napraw = async ({ narzedzia }) => { const z = await narzedzia.zamow({ productId: null }); return wynikNaprawy({ ok: false, ostatniBlad: z.blad, podsumowanie: 'Nie da się sprawdzić listy zleceń.' }); };
  db = baza(zam());
  await spakuj(db); await poNaprawie(db);
  assert.equal(wolania.filter(w => w[0] === '/api/glob/order').length, 1, 'bez drugiego zlecenia');
  assert.equal(db.stan.z.status, 'GOTOWE');
  assert.equal(db.stan.z.kurierNaprawa.niepewne, true);
  assert.match(S.telegram[0], /NIE udało się zamówić kuriera[\s\S]*nie zamawiam ponownie[\s\S]*UWAGA: GlobKurier nie odpowiedział przy zamawianiu — zlecenie mogło powstać/);
});

test('„Ponów auto-list" po niepewnym błędzie: najpierw lista GK — podpina istniejące zlecenie zamiast zamawiać', async () => {
  czysto();
  const wolania = gk(() => przyjete('GK-DRUGI'));
  S.listaGk = async () => [zlecenieGk()];
  const db = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2, gotoweAt: new Date(Date.now() - 30 * 1000), kurierBlad: 'zamówienie: GlobKurier timeout po 25000ms (POST /v1/order)' }));
  const r = await zapytaj(db, 'POST', '/zamowienia/z9/kurier', { body: { autoList: true } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.zamowienie.gkNumber, 'GK555');
  assert.match(r.json.uwaga, /powstało już przy poprzedniej próbie/);
  assert.equal(wolania.length, 0, 'ani wyceny, ani zamówienia');

  S.listaGk = async () => { throw new Error('GK leży'); };
  const db2 = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2, gotoweAt: new Date(), kurierBlad: 'zamówienie: HTTP 502' }));
  const r2 = await zapytaj(db2, 'POST', '/zamowienia/z9/kurier', { body: { autoList: true } });
  assert.equal(r2.status, 502);
  assert.match(r2.json.error, /nie zamawiam w ciemno drugiego kuriera/);
  assert.equal(wolania.length, 0);

  // Zwykły błąd (odmowa adresu) niczego nie sprawdza — zamawia od razu.
  S.listaGk = async () => { throw new Error('nie powinno być wołane'); };
  const db3 = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2, kurierBlad: 'zamówienie: Pole „nazwa” odbiorcy odrzucone przez GK' }));
  const r3 = await zapytaj(db3, 'POST', '/zamowienia/z9/kurier', { body: { autoList: true } });
  assert.equal(r3.json.zamowienie.gkNumber, 'GK-DRUGI');
});

test('w trakcie naprawy: „Ponów auto-list", podpięcie listu i cofnięcie „gotowe" są wstrzymane (409)', async () => {
  czysto(); gk(() => przyjete());
  const db = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2, kurierBlad: 'x', kurierNaprawa: { stan: 'w-toku', od: new Date().toISOString() } }));
  for (const [sciezka, body] of [['/zamowienia/z9/kurier', { autoList: true }], ['/zamowienia/z9/kurier', { gkNumber: 'GK1' }], ['/zamowienia/z9/cofnij-gotowe', {}], ['/zamowienia/z9/napraw-kuriera', {}]]) {
    const r = await zapytaj(db, 'POST', sciezka, { body });
    assert.equal(r.status, 409, `${sciezka} ${JSON.stringify(r.json)}`);
  }
  for (const body of [{ odbiorca: { street: 'Inna' } }, { status: 'ANULOWANE' }]) assert.equal((await zapytaj(db, 'PATCH', '/zamowienia/z9', { body })).status, 409, JSON.stringify(body));
  assert.equal(db.stan.aktualizacje.length, 0);
  assert.equal((await zapytaj(db, 'PATCH', '/zamowienia/z9', { body: { uwagiNasze: 'Towar w ekspozytorach.' } })).status, 200, 'sama uwaga nie przeszkadza naprawie');
  // Stan „w toku" starszy niż najdłuższa naprawa nie blokuje wiecznie.
  const stare = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2, kurierBlad: 'x', kurierNaprawa: { stan: 'w-toku', od: new Date(Date.now() - 11 * 60 * 1000).toISOString() } }));
  assert.equal((await zapytaj(stare, 'GET', '/zamowienia/z9')).json.zamowienie.kurierNaprawa.stan, 'przerwana');
  assert.equal((await zapytaj(stare, 'POST', '/zamowienia/z9/kurier', { body: { autoList: true } })).status, 200);
});

test('napraw-kuriera (właściciel): uruchamia naprawę dla spakowanej paczki; nie dla braku środków, nie dla magazynu', async () => {
  czysto(); gk(() => przyjete('GK910'));
  S.napraw = async ({ narzedzia }) => { const z = await narzedzia.zamow({ productId: null }); return wynikNaprawy({ ok: true, zamowiono: z, podsumowanie: 'Zamówiony.' }); };
  const db = baza(zam({ status: 'GOTOWE', ...KARTON, wagaKg: 1.2, kurierBlad: 'zamówienie: Pole „miasto” odbiorcy odrzucone przez GK' }));
  assert.equal((await zapytaj(db, 'POST', '/zamowienia/z9/napraw-kuriera', { rola: 'magazyn' })).status, 403);
  const r = await zapytaj(db, 'POST', '/zamowienia/z9/napraw-kuriera', { body: {} });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.uruchomiono, true);
  assert.equal(r.json.zamowienie.kurierNaprawa.stan, 'w-toku');
  await poNaprawie(db);
  assert.equal(db.stan.z.gkNumber, 'GK910');

  const srodki = baza(zam({ status: 'GOTOWE', kurierBlad: 'zamówienie: Płatność w GlobKurier odrzucona: "Brak środków"' }));
  const odm = await zapytaj(srodki, 'POST', '/zamowienia/z9/napraw-kuriera', { body: {} });
  assert.equal(odm.status, 400);
  assert.match(odm.json.error, /brak środków w GlobKurier/);
  assert.equal((await zapytaj(baza(zam({ status: 'KURIER', gkNumber: 'GK1' })), 'POST', '/zamowienia/z9/napraw-kuriera', { body: {} })).status, 400);
});

test('próba (proba:true): prawdziwa pętla na kopii — nic nie zapisuje, nic nie zamawia, nic nie wysyła', async () => {
  czysto();
  const wolania = gk(() => { throw new Error('próba nie może zamawiać'); });
  let widzial = null;
  S.napraw = async ({ zamowienie, blad, narzedzia }) => {
    widzial = { zamowienie, blad };
    const pierwsza = await narzedzia.zamow({ productId: null });
    const p = await narzedzia.poprawOdbiorce({ name: 'EBENHOLZ skincare Katja Miller' }, 'przecinek');
    const druga = await narzedzia.zamow({ productId: null });
    return wynikNaprawy({ ok: druga.ok, zamowiono: druga, zmiany: p.zmiany, kroki: [pierwsza, druga] });
  };
  const db = baza(zam({ status: 'KURIER', gkNumber: 'GK261118179579', gkHash: 'h' }));
  const r = await zapytaj(db, 'POST', '/zamowienia/z9/napraw-kuriera', { body: { proba: true, odbiorca: { name: 'EBENHOLZ skincare, Katja Miller', country: 'PL' } } });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.proba, true);
  assert.equal(r.json.rodzajBledu, 'naprawialny');
  assert.equal(widzial.zamowienie.odbiorca.name, 'EBENHOLZ skincare, Katja Miller');
  assert.equal(widzial.zamowienie.odbiorca.country, 'DE', 'kraju próba nie podmienia');
  assert.equal(r.json.wynik.kroki[0].ok, false, 'atrapa GK odrzuca przecinek jak prawdziwy');
  assert.equal(r.json.wynik.zamowiono.gkNumber, 'PROBA-NIC-NIE-ZAMOWIONO');
  assert.equal(r.json.odbiorcaPo.name, 'EBENHOLZ skincare Katja Miller');
  assert.equal(db.stan.aktualizacje.length, 0);
  assert.equal(db.stan.z.gkNumber, 'GK261118179579');
  assert.deepEqual(wolania, []);
  assert.deepEqual(S.telegram, []);

  // Błąd, którego model nie dostaje: próba pokazuje treść alarmu, niczego nie wysyła.
  S.napraw = async () => { throw new Error('model nie powinien być wołany'); };
  const srodki = await zapytaj(db, 'POST', '/zamowienia/z9/napraw-kuriera', { body: { proba: true, blad: 'zamówienie: Płatność w GlobKurier odrzucona: "Brak środków na koncie".' } });
  assert.equal(srodki.json.rodzajBledu, 'brak-srodkow');
  assert.match(srodki.json.telegram, /^🛑 Magazyn #9[\s\S]*odrzucił płatność/);
  assert.deepEqual(S.telegram, []);
});

test('naprawa przerwana restartem: po starcie oznaczona jako nieudana, właściciel dostaje alarm', async () => {
  czysto();
  const db = baza(zam({ status: 'GOTOWE', kurierBlad: 'zamówienie: Pole „nazwa” odrzucone', kurierNaprawa: { stan: 'w-toku', od: new Date(Date.now() - 4 * 60 * 1000).toISOString() } }));
  assert.equal(await magazyn.posprzatajPrzerwaneNaprawy(db, { startProcesu: Date.now() - 3 * 60 * 1000 }), 1);
  assert.equal(db.stan.z.kurierNaprawa.stan, 'nieudana');
  assert.match(S.telegram[0], /NIE udało się zamówić kuriera[\s\S]*przerwana restartem serwera[\s\S]*zlecenie mogło powstać/);
  // Naprawa zaczęta w tym procesie nie jest ruszana.
  const zywa = baza(zam({ status: 'GOTOWE', kurierNaprawa: { stan: 'w-toku', od: new Date().toISOString() } }));
  assert.equal(await magazyn.posprzatajPrzerwaneNaprawy(zywa, { startProcesu: Date.now() - 60 * 1000 }), 0);
  assert.equal(zywa.stan.aktualizacje.length, 0);
});

test('naprawa się wysypała (wyjątek): stan nieudana i alarm — nigdy cisza', async () => {
  czysto(); gk(() => odmowa('Pole „nazwa” odbiorcy odrzucone przez GK'));
  S.napraw = async () => { throw new Error('nieoczekiwany wyjątek'); };
  const db = baza(zam());
  await spakuj(db); await poNaprawie(db);
  assert.equal(db.stan.z.kurierNaprawa.stan, 'nieudana');
  assert.match(S.telegram[0], /NIE udało się zamówić kuriera[\s\S]*Automatyczna naprawa przerwana: nieoczekiwany wyjątek/);
});
