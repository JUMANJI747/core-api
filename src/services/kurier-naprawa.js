'use strict';

/* NAPRAWA AUTO-LISTU PRZEZ OPUSA (18.11.2026).
 *
 * Właściciel: „jak auto-list się nie wystawi, to wywołuje Opusa po API, żeby
 * to naprawił i zamówił list, a jak jemu się nie uda — powiadomienie na
 * Telegram, że nie udało się zamówić kuriera. Chyba że komunikat jest, że nie
 * ma kasy na GlobKurier — wtedy od razu powiadomienie do mnie".
 *
 * Trzy odmowy kuriera w dwa tygodnie (#5 nawias w mieście, #9 przecinek
 * w nazwie) kończyły się tak samo: paczka spakowana, kurier niezamówiony,
 * a naprawa czekała, aż właściciel zobaczy alarm. Teraz po nieudanym
 * auto-liście:
 *   - `rodzajBledu` rozstrzyga, czy w ogóle jest co naprawiać: brak środków,
 *     bezpiecznik ceny i błędy konfiguracji idą OD RAZU do właściciela,
 *   - resztę dostaje model z czterema narzędziami: sprawdź adres, popraw
 *     odbiorcę, wyceń, zamów. Nic poza tym — nie ma dostępu do bazy ani poczty.
 *
 * Model może poprawić FORMAT, nie ADRES. Pilnuje tego kod, nie prompt:
 * `naruszeniaPoprawki` odrzuca zmianę, po której paczka mogłaby pojechać
 * gdzie indziej (inne litery/cyfry w ulicy, mieście, kodzie, telefonie).
 * Cenę pilnuje bezpiecznik z kurier-szacunek (także przy innym przewoźniku).
 *
 * Tu jest sama pętla i reguły; narzędzia (baza, GlobKurier) podaje
 * routes/magazyn.js, w testach — atrapy. */

const Anthropic = require('@anthropic-ai/sdk');

const MODEL = process.env.KURIER_NAPRAWA_MODEL || 'claude-opus-5-5';
// Zapas, gdy klucz nie ma dostępu do modelu głównego (CLAUDE.md: działa na pewno).
const MODEL_ZAPAS = process.env.KURIER_NAPRAWA_MODEL_ZAPAS || 'claude-opus-4-8';
const WYSILEK = process.env.KURIER_NAPRAWA_WYSILEK || 'medium';
const MAX_KROKOW = 8;                  // tury modelu
const MAX_ZAMOWIEN = 3;                // próby zamówienia kuriera w jednej naprawie
const LIMIT_CZASU_MS = 4 * 60 * 1000;
// Odmowa klasyfikatora bezpieczeństwa → serwer sam powtarza na modelu zapasowym.
const BETA_FALLBACK = 'server-side-fallback-2026-07-01';
const MODELE_Z_FALLBACKIEM = /^claude-(opus-5|sonnet-5-5|fable-5)/;

// ---------- czy jest co naprawiać ----------

/** 'brak-srodkow' | 'cena' | 'konfiguracja' | 'naprawialny' */
function rodzajBledu(blad) {
  // Bez wartości, które sami wysłaliśmy („Wysłaliśmy: „Payment Solutions GmbH”") —
  // nazwa firmy odbiorcy nie może udawać komunikatu o płatności.
  const t = String(blad || '').replace(/Wysłaliśmy: „[^”]*”\.?/g, '');
  if (/^Cena kuriera za wysoka/i.test(t)) return 'cena';
  if (/brak\w*\s+(wystarczaj\w+\s+)?[śs]rodk|niewystarczaj\w+\s+([śs]rodk|sald)|\bsald[oa]\b|pre-?paid|do[łl]aduj|insufficient|not enough (funds|balance|credit)|\b(funds|balance)\b|limit\w*\s+kredyt|kredyt\w*\s+(wyczerp|przekrocz)|p[łl]atno[śs]\w*|payment/i.test(t)) return 'brak-srodkow';
  if (/brak nadawcy magazynu|GLOBKURIER_(EMAIL|PASSWORD)|API zablokowane|HTTP 40[13]\b|unauthorized|token/i.test(t)) return 'konfiguracja';
  return 'naprawialny';
}

// ---------- czy poprawka nie zmienia, dokąd jedzie paczka ----------

const sam = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/ß/g, 'ss').toLowerCase().replace(/[^a-z0-9]/g, '');
function podciag(krotki, dlugi) { // czy znaki `krotki` występują w `dlugi` w tej samej kolejności
  let i = 0;
  for (const z of dlugi) if (i < krotki.length && z === krotki[i]) i++;
  return i === krotki.length;
}

/** Lista powodów, dla których poprawka NIE jest samą zmianą formatu
 *  (pusta = wolno). `stary`/`nowy` w kształcie WarehouseOrder.odbiorca.
 *  `stary` to adres SPRZED naprawy, nie po poprzedniej poprawce — inaczej
 *  seria małych skróceń zjadłaby nazwę albo miasto po kawałku. */
function naruszeniaPoprawki(stary, nowy) {
  const s = stary || {};
  const n = nowy || {};
  const zle = [];
  if (String(n.country || '').toUpperCase() !== String(s.country || '').toUpperCase()) zle.push('kraju nie wolno zmieniać');
  // Ulica + numer + lokal: te same litery i cyfry, dowolnie rozłożone po polach.
  const adr = (o) => sam(`${o.street || ''}${o.houseNumber || ''}${o.apartmentNumber || ''}`);
  if (adr(s) !== adr(n)) zle.push(`ulica/numer/lokal: wolno zmienić zapis i podział na pola, nie treść („${[s.street, s.houseNumber, s.apartmentNumber].filter(Boolean).join(' ')}” → „${[n.street, n.houseNumber, n.apartmentNumber].filter(Boolean).join(' ')}”)`);
  if (sam(s.postCode) !== sam(n.postCode)) zle.push(`kod pocztowy: wolno zmienić zapis, nie cyfry („${s.postCode}” → „${n.postCode}”)`);
  // Miasto: wolno uciąć krótki dopisek z początku albo końca (skrót prowincji),
  // nie wolno dopisać, podmienić ani uciąć części nazwy — nowa nazwa to ciągły
  // fragment starej i co najmniej 60% jej liter.
  const cs = sam(s.city);
  const cn = sam(n.city);
  if (cs !== cn && (!cn || !cs.includes(cn) || cn.length < Math.ceil(cs.length * 0.6))) zle.push(`miasto: wolno usunąć dopisek, nie zmienić nazwy („${s.city}” → „${n.city}”)`);
  // Nazwa: wolno skrócić i wyczyścić; musi zostać rozpoznawalna (te same litery
  // w tej samej kolejności, co najmniej 8 albo połowa).
  const ns = sam(s.name);
  const nn = sam(n.name);
  if (ns !== nn && (!nn || !podciag(nn, ns) || nn.length < Math.min(8, Math.ceil(ns.length / 2)))) zle.push(`nazwa: wolno skrócić i usunąć znaki, nie zmienić („${s.name}” → „${n.name}”)`);
  // Telefon: ten sam numer w innym zapisie (końcówka 7 cyfr bez zmian).
  const cyf = (x) => String(x || '').replace(/\D/g, '');
  if (cyf(s.phone) && cyf(n.phone).slice(-7) !== cyf(s.phone).slice(-7)) zle.push(`telefon: wolno zmienić zapis, nie numer („${s.phone}” → „${n.phone}”)`);
  if (!cyf(s.phone) && cyf(n.phone)) zle.push('telefonu nie wolno wymyślać — w zamówieniu go nie ma');
  if (String(n.email || '').trim().toLowerCase() !== String(s.email || '').trim().toLowerCase()) zle.push('e-maila nie zmieniamy');
  return zle;
}

// ---------- model ----------

const SYSTEM = `Jesteś automatem naprawczym w CRM firmy Surf Stick Bell (kosmetyki, wysyłki kurierem przez GlobKurier). Magazyn spakował paczkę, a automatyczne zamówienie kuriera się nie udało. Masz doprowadzić do zamówienia kuriera dla tej paczki — albo uczciwie stwierdzić, że się nie da. Na wynik czeka magazyn z gotową paczką, więc liczy się skuteczność i czas, nie elegancja.

Co możesz zrobić:
- Poprawić ZAPIS danych odbiorcy tak, żeby GlobKurier je przyjął: usunąć niedozwolone znaki, rozdzielić ulicę, numer domu i lokal, poprawić zapis telefonu (pełny numer z kierunkowym kraju odbiorcy, bez zera krajowego) i kodu pocztowego, skrócić nazwę (na liście przewozowym mieści się 30 znaków — firma albo osoba ma zostać rozpoznawalna).
- Wybrać innego przewoźnika z wyceny, gdy najtańszy odrzuca zamówienie albo nie ma terminu odbioru. Limitu ceny pilnuje narzędzie.
- Ponowić zamówienie, gdy błąd wyglądał na chwilowy (limit czasu, błąd serwera GlobKuriera). Gdy GlobKurier nie odpowiedział przy samym zamawianiu, zlecenie mogło mimo to powstać — narzędzie zamow_kuriera przy następnym wywołaniu samo to sprawdzi i podepnie istniejące zlecenie zamiast zamawiać drugie.

Czego nie robisz:
- Nie zmieniasz, DOKĄD jedzie paczka. Po poprawce odbiorca, ulica, numer, miasto, kod i kraj mają znaczyć to samo co przed nią. Gdy danych brakuje albo wyglądają na błędne w treści (nie ma numeru domu, kod nie pasuje do kraju, nie ma telefonu), nie zgadujesz i niczego nie wymyślasz — kończysz i piszesz, czego brakuje. Narzędzie i tak odrzuci zmianę treści.
- Gdy błąd mówi o płatności, saldzie albo braku środków w GlobKurier, nie próbujesz dalej — to sprawa właściciela.
- Po udanym zamówieniu nie zamawiasz drugi raz.

Wskazówki z praktyki:
- GlobKurier odrzuca znaki jednym komunikatem („Wpisano nieprawidłowy znak…”), często bez wskazania pola. W nazwie, ulicy i mieście bezpieczne są tylko litery, cyfry, spacja, kropka i myślnik.
- Telefon odbiorcy musi mieć kierunkowy jego kraju (np. +49… dla Niemiec, bez zera po kierunkowym). Numeru z innego kraju nie „naprawisz” — wtedy zakończ i napisz, że trzeba podać właściwy numer.
- Masz najwyżej ${MAX_ZAMOWIEN} próby zamówienia. Najpierw ustal przyczynę i popraw najmniejszą możliwą rzecz, dopiero potem zamawiaj.

Na koniec napisz po polsku 2–3 zdania dla właściciela: co było przyczyną, co zmieniłeś (stara wartość → nowa) i czy kurier jest zamówiony. Bez wstępów i bez list. To trafi do wiadomości na Telegramie jako zwykły tekst — bez Markdowna (gwiazdek, nagłówków, odwrotnych apostrofów).`;

const NARZEDZIA = [
  {
    name: 'sprawdz_adres',
    description: 'Sprawdza dane odbiorcy regułami GlobKuriera BEZ zapisywania. Podaj tylko pola, które chcesz zmienić; reszta zostaje z zamówienia. Zwraca adres po czyszczeniu, listę poprawek zrobionych automatycznie, ostrzeżenia i błędy. Użyj przed popraw_odbiorce, gdy nie masz pewności, czy zmiana przejdzie.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, street: { type: 'string' }, houseNumber: { type: 'string' }, apartmentNumber: { type: 'string' },
        postCode: { type: 'string' }, city: { type: 'string' }, phone: { type: 'string' },
      },
    },
  },
  {
    name: 'popraw_odbiorce',
    description: 'Zapisuje poprawiony ZAPIS danych odbiorcy w zamówieniu. Podaj tylko pola, które zmieniasz. Wolno zmienić format (znaki, podział ulica/numer/lokal, zapis telefonu i kodu, skrócenie nazwy) — zmiana treści adresu, kraju, e-maila albo numeru telefonu zostanie odrzucona.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, street: { type: 'string' }, houseNumber: { type: 'string' }, apartmentNumber: { type: 'string' },
        postCode: { type: 'string' }, city: { type: 'string' }, phone: { type: 'string' },
        powod: { type: 'string', description: 'Jedno zdanie: co poprawiasz i dlaczego.' },
      },
      required: ['powod'],
    },
  },
  {
    name: 'wycen_kuriera',
    description: 'Aktualna wycena GlobKuriera dla tej paczki i adresu: oferty od najtańszej (productId, przewoźnik, usługa, cena brutto w zł, najbliższy termin odbioru) oraz limit ceny, powyżej którego zamówienie zostanie odrzucone. Użyj, gdy chcesz wybrać innego przewoźnika.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'zamow_kuriera',
    description: `Zamawia kuriera w GlobKurier (prawdziwe, płatne zlecenie). Bez productId bierze najtańszą ofertę; z productId — wskazaną ofertę z wycen_kuriera. Zwraca numer zlecenia albo treść błędu. Najwyżej ${MAX_ZAMOWIEN} próby na całą naprawę.`,
    input_schema: {
      type: 'object',
      properties: { productId: { type: 'integer', description: 'productId oferty z wycen_kuriera; pomiń, żeby wziąć najtańszą.' } },
    },
  },
];

let _klient = null;
function klientAnthropic() {
  if (!_klient) {
    // Klucz czytamy z env jak reszta serwisów; .trim(), bo zmienna w Railway
    // bywała wklejona ze spacją. Limit czasu w milisekundach (SDK TS/JS):
    // 90 s na odpowiedź i jedno ponowienie — magazyn czeka z paczką.
    const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim() || undefined;
    _klient = new Anthropic({ apiKey, maxRetries: 1, timeout: 90000 });
  }
  return _klient;
}

function zadanie(model, messages) {
  return {
    model,
    max_tokens: 16000,
    system: SYSTEM,
    tools: NARZEDZIA,
    // Myślenie adaptacyjne + jawny wysiłek: domyślny różni się między modelami.
    thinking: { type: 'adaptive' },
    output_config: { effort: WYSILEK },
    messages,
  };
}

/** Jedno wywołanie modelu z dwiema ścieżkami awaryjnymi: bez parametru
 *  `fallbacks`, gdy API go nie przyjmuje, i na modelu zapasowym, gdy klucz nie
 *  ma dostępu do głównego. `stan` pamięta wybór do końca naprawy. */
async function wywolajModel(klient, stan, messages) {
  for (let i = 0; i < 3; i++) {
    const p = zadanie(stan.model, messages);
    try {
      if (!stan.bezFallbackow && MODELE_Z_FALLBACKIEM.test(stan.model)) {
        return await klient.beta.messages.create({ ...p, betas: [BETA_FALLBACK], fallbacks: 'default' });
      }
      return await klient.messages.create(p);
    } catch (e) {
      if (e instanceof Anthropic.BadRequestError && !stan.bezFallbackow && MODELE_Z_FALLBACKIEM.test(stan.model) && /fallback|beta/i.test(e.message)) {
        stan.bezFallbackow = true;
        continue;
      }
      const brakModelu = e instanceof Anthropic.NotFoundError || e instanceof Anthropic.PermissionDeniedError
        || (e instanceof Anthropic.BadRequestError && /\bmodel\b/i.test(e.message));
      if (brakModelu && stan.model !== MODEL_ZAPAS) {
        console.warn(`[kurier-naprawa] model ${stan.model} niedostępny (${e.status}) — przechodzę na ${MODEL_ZAPAS}`);
        stan.model = MODEL_ZAPAS;
        stan.zapas = true;
        continue;
      }
      throw e;
    }
  }
  throw new Error('model nie odpowiedział po zmianie ustawień');
}

function opisBleduApi(e) {
  if (e instanceof Anthropic.AuthenticationError) return 'zły klucz Anthropic (ANTHROPIC_API_KEY)';
  if (e instanceof Anthropic.RateLimitError) return 'limit zapytań Anthropic — spróbuj za chwilę';
  if (e instanceof Anthropic.APIConnectionError) return `brak połączenia z Anthropic (${e.message})`;
  if (e instanceof Anthropic.APIError) return `Anthropic ${e.status || ''}: ${String(e.message).slice(0, 200)}`;
  return String((e && e.message) || e).slice(0, 200);
}

// Telegram i panel pokazują podsumowanie jako zwykły tekst — znaczniki Markdowna
// (gdyby model ich jednak użył) byłyby widoczne dosłownie.
const tekstOdpowiedzi = (odp) => ((odp && odp.content) || []).filter(b => b.type === 'text').map(b => b.text).join('\n')
  .replace(/\*\*|`/g, '').replace(/^#{1,6}\s+/gm, '').trim();

/** Naprawa jednego zamówienia.
 *  `zamowienie` — dane dla modelu (numer, odbiorca, karton, szacunek…),
 *  `blad` — treść błędu auto-listu,
 *  `narzedzia` — { sprawdzAdres(pola), poprawOdbiorce(pola, powod), wycen(), zamow({productId}) },
 *     każde zwraca obiekt; `zamow` → { ok:true, gkNumber, przewoznik, cena } albo { ok:false, blad }.
 *  Zwraca { ok, zamowiono, podsumowanie, zmiany, kroki, model, powodKonca, brakSrodkow, zuzycie }. */
async function naprawKuriera({ zamowienie, blad, narzedzia, klient = null, teraz = Date.now }) {
  const start = teraz();
  const k = klient || klientAnthropic();
  const stan = { model: MODEL, zapas: false, bezFallbackow: false };
  const kroki = [];
  const zmiany = [];
  const zuzycie = { wejscie: 0, wyjscie: 0, wywolan: 0 };
  let zamowiono = null;
  let proby = 0;
  let ostatniBlad = String(blad || '');
  let brakSrodkow = false;
  let powodKonca = null;
  let odp = null;
  let obsluzyl = null; // model, który faktycznie odpowiedział (po fallbacku serwera bywa inny)

  async function wykonaj(nazwa, wejscie) {
    const we = wejscie && typeof wejscie === 'object' ? wejscie : {};
    if (zamowiono) return { ok: false, blad: 'Kurier jest już zamówiony — napisz podsumowanie i zakończ.' };
    try {
      if (nazwa === 'sprawdz_adres') return await narzedzia.sprawdzAdres(we);
      if (nazwa === 'popraw_odbiorce') {
        const { powod, ...pola } = we;
        const w = await narzedzia.poprawOdbiorce(pola, String(powod || '').slice(0, 300));
        if (w && w.ok && Array.isArray(w.zmiany)) zmiany.push(...w.zmiany);
        return w;
      }
      if (nazwa === 'wycen_kuriera') return await narzedzia.wycen();
      if (nazwa === 'zamow_kuriera') {
        if (proby >= MAX_ZAMOWIEN) return { ok: false, blad: `Wykorzystano ${MAX_ZAMOWIEN} próby zamówienia — zakończ i napisz, co zostało do zrobienia.` };
        proby++;
        const productId = Number.isInteger(we.productId) ? we.productId : (/^\d+$/.test(String(we.productId || '')) ? Number(we.productId) : null);
        const w = await narzedzia.zamow({ productId });
        if (w && w.ok) zamowiono = w;
        else if (w && w.blad) {
          ostatniBlad = String(w.blad);
          if (rodzajBledu(w.blad) === 'brak-srodkow') brakSrodkow = true;
        }
        return w;
      }
      return { ok: false, blad: `Nie ma narzędzia ${nazwa}.` };
    } catch (e) {
      return { ok: false, blad: String(e.message || e).slice(0, 400) };
    }
  }

  const messages = [{
    role: 'user',
    content: `Automatyczne zamówienie kuriera dla zamówienia magazynu #${zamowienie.numer} się nie udało.\n\nBłąd:\n${ostatniBlad}\n\nDane zamówienia (JSON):\n${JSON.stringify(zamowienie, null, 1)}`,
  }];

  try {
    for (let krok = 0; krok < MAX_KROKOW; krok++) {
      if (teraz() - start > LIMIT_CZASU_MS) { powodKonca = 'limit czasu naprawy'; break; }
      odp = await wywolajModel(k, stan, messages);
      zuzycie.wywolan++;
      if (odp.model) obsluzyl = odp.model;
      if (odp.usage) { zuzycie.wejscie += odp.usage.input_tokens || 0; zuzycie.wyjscie += odp.usage.output_tokens || 0; }
      // Najpierw powód zakończenia — przy odmowie i ucięciu treść nie nadaje się do użycia.
      if (odp.stop_reason === 'refusal') { powodKonca = 'model odmówił wykonania zadania'; break; }
      if (odp.stop_reason === 'max_tokens') { powodKonca = 'odpowiedź modelu została ucięta'; break; }
      // Treść wraca do historii BEZ zmian (bloki myślenia i tool_use muszą zostać nietknięte).
      messages.push({ role: 'assistant', content: odp.content });
      if (odp.stop_reason === 'pause_turn') continue;
      const wywolania = (odp.content || []).filter(b => b.type === 'tool_use');
      if (odp.stop_reason !== 'tool_use' || !wywolania.length) break; // koniec: model napisał podsumowanie
      const wyniki = [];
      for (const w of wywolania) {
        const wynik = await wykonaj(w.name, w.input);
        kroki.push({ narzedzie: w.name, wejscie: w.input, ok: !(wynik && wynik.ok === false), wynik: JSON.stringify(wynik).slice(0, 300) });
        wyniki.push({ type: 'tool_result', tool_use_id: w.id, content: JSON.stringify(wynik), ...(wynik && wynik.ok === false ? { is_error: true } : {}) });
      }
      // Wszystkie wyniki w JEDNEJ wiadomości użytkownika.
      messages.push({ role: 'user', content: wyniki });
      if (brakSrodkow) { powodKonca = 'brak środków w GlobKurier'; break; }
      if (krok === MAX_KROKOW - 1) powodKonca = 'wykorzystano limit kroków';
    }
  } catch (e) {
    powodKonca = `awaria modelu: ${opisBleduApi(e)}`;
    console.error('[kurier-naprawa] błąd API:', opisBleduApi(e));
  }

  const tekst = powodKonca && !/limit kroków/.test(powodKonca) ? '' : tekstOdpowiedzi(odp);
  const zmianyTekst = zmiany.map(z => `${z.pole}: „${z.bylo}” → „${z.jest}”`).join('; ');
  const podsumowanie = (tekst || [
    zamowiono ? 'Kurier zamówiony po automatycznej poprawce.' : 'Automatyczna naprawa nie doprowadziła do zamówienia kuriera.',
    zmianyTekst ? `Zmiany: ${zmianyTekst}.` : '',
    powodKonca ? `Powód zakończenia: ${powodKonca}.` : '',
  ].filter(Boolean).join(' ')).slice(0, 900);

  return {
    ok: !!zamowiono, zamowiono, podsumowanie, zmiany, kroki, proby,
    model: obsluzyl || stan.model, zapas: stan.zapas, bezFallbackow: stan.bezFallbackow, powodKonca, brakSrodkow, ostatniBlad, zuzycie,
    trwaloMs: teraz() - start,
  };
}

module.exports = {
  naprawKuriera, rodzajBledu, naruszeniaPoprawki,
  MODEL, MODEL_ZAPAS, MAX_ZAMOWIEN, MAX_KROKOW,
  _test: { NARZEDZIA, SYSTEM, wywolajModel, zadanie },
};
