'use strict';

/* RAPORTY KASOWE → GOOGLE SHEETS (26.10.2026; przeniesione z n8n „Raporty
 * kasowe → Google Sheets", żeby zamknąć n8n Claude).
 *
 * Bar i recepcja Pałacu Galiny wysyłają dzienne raporty (PDF albo zdjęcie) na
 * skrzynkę bota. Dla każdego załącznika:
 *   1. poprawa skanu (/preprocess-scan w tym samym procesie; awaria = odczyt
 *      oryginału i jeden mail z alertem na maila, jak w n8n),
 *   2. odczyt modelem (typ, data, kwoty) + kontrole spójności raportu BAR,
 *   3. czy dzień już wpisany: te same kwoty → cicho pomijamy, inne → mail
 *      „duplikat z INNYMI kwotami", nic nie nadpisujemy,
 *   4. niezależna weryfikacja drugim odczytem,
 *   5. spór → arbitraż mocniejszym modelem (krok po kroku z arytmetyką),
 *   6. zapis do arkusza (zakładka „MIESIĄC RRRR", wiersz = dzień + 3) i mail
 *      z potwierdzeniem i oryginałem raportu.
 * Codziennie o 4:00 (Warszawa): kopia arkusza (XLSX do bazy, 60 dni) i — gdy
 * jutro 1-szy — zakładka nowego miesiąca (kopia bieżącej, dane B4:M34 czyszczone).
 *
 * Różnice względem n8n (celowe):
 *  - wynik arbitrażu też przechodzi kontrolę duplikatu (n8n wpisywał od razu),
 *  - arkusz czytany jako liczby (UNFORMATTED_VALUE) — porównanie kwot nie
 *    zależy od formatu komórek,
 *  - skrzynka czytana po UID, nic nie oznaczamy jako przeczytane; stan w Config,
 *  - każdy załącznik ma ślad w RaportKasowy (powtórka po restarcie nie dubluje),
 *  - obrazki osadzone w treści (logo, podpis) i drobne obrazki pomijamy —
 *    n8n wysyłał je do odczytu i odpisywał „nierozpoznany załącznik",
 *  - kopia jako XLSX w bazie zamiast kopii pliku w Drive (konto serwisowe nie
 *    ma miejsca na Dysku),
 *  - token do poprawy skanów nie jest wpisany w kod (był w węźle n8n). */

const KLUCZ_USTAWIENIA = 'raporty_kasowe';       // { arkuszId, potwierdzenia[], alerty[], nadawcy[] }
const KLUCZ_STAN = 'raporty_kasowe_stan';        // { uidValidity, lastUid, od? }
const KLUCZ_DZIEN = 'raporty_kasowe_dzien';      // RRRR-MM-DD ostatniej kopii (Warszawa)
const MIESIACE = ['STYCZEŃ', 'LUTY', 'MARZEC', 'KWIECIEŃ', 'MAJ', 'CZERWIEC', 'LIPIEC', 'SIERPIEŃ', 'WRZESIEŃ', 'PAŹDZIERNIK', 'LISTOPAD', 'GRUDZIEŃ'];
const MODELE = () => ({
  odczyt: process.env.RAPORTY_MODEL_ODCZYT || 'claude-sonnet-5-5',
  weryfikacja: process.env.RAPORTY_MODEL_WERYFIKACJA || 'claude-sonnet-5-5',
  arbitraz: process.env.RAPORTY_MODEL_ARBITRAZ || 'claude-opus-4-8',
});
const MIN_OBRAZ_B = 20 * 1024; // mniejsze obrazki to logo/podpisy, nie skany raportów

// ── prompty — DOSŁOWNIE z węzłów n8n (dostrojone na prawdziwych raportach) ──
const PROMPT_ODCZYT = `Dostajesz PDF lub zdjęcie hotelowego raportu dziennego. Zdjęcie może być krzywe lub niedoświetlone — czytaj uważnie. To jeden z dwóch typów:\n\n1. BAR — nagłówek \"RAPORT PUNKTÓW SPRZEDAŻY\", firma BELL PPHU, Józefów. Często jest to SKAN, bywa przekrzywiony. UWAGA: na stronie mogą być DWA wydruki obok siebie — czytaj WYŁĄCZNIE ten z nagłówkiem RAPORT PUNKTÓW SPRZEDAŻY, całkowicie ignoruj RAPORT SPRZEDAŻY GRT wg PS i inne wydruki.\n2. RECEPCJA — nagłówek \"Pałac i Folwark Galiny\", \"Raport recepcji / sprzedaż wykonana za dzień\".\n\nWyekstrahuj dane i zwróć WYŁĄCZNIE czysty JSON, bez markdown, bez komentarzy.\n\nDla typu BAR:\n{\"typ\":\"bar\",\"data\":\"DD/MM/YYYY\" (pole Doba),\"gotowka\": liczba (sekcja Zapłaty → wiersz Gotówka, wartość; NIE Karta kredytowa),\"netto\": liczba (sekcja Grupy prowizyjne → wiersz Gastronomia → kolumna Netto; to pełna sprzedaż Z kredytem hotelowym — NIE bierz wartości NETTO z sekcji Obr.BRUTTO),\"brutto\": liczba (sekcja Grupy prowizyjne → wiersz Gastronomia → kolumna Brutto; NIE bierz Obr.BRUTTO ani Zapłaty),\"rabaty\": liczba (Sprzedaż własna PLU → wiersz Rabaty, wartość; NIE Storna),\"goscie\": liczba całkowita (wiersz Gości/śred.brutt, kolumna Ilość; NIE liczba przy Rach.zamk.własne ani Rach/śred.brutto — to liczby rachunków),\"sr_brutto\": liczba (wiersz Gości/śred.brutt, kolumna Wartość),\"sr_netto\": liczba (wiersz netto bezpośrednio pod Gości/śred.brutt; sr_brutto musi być większe od sr_netto),\"obrot\": liczba (Obr.BRUTTO, pierwsza wartość — pole kontrolne, równe sumie Zapłat),\"karta\": liczba (Zapłaty → Karta kredytowa, wartość — pole kontrolne),\"rachunki\": liczba całkowita (Rach.zamk.własne, kolumna Ilość — pole kontrolne)}\n\nDla typu RECEPCJA:\n{\"typ\":\"recepcja\",\"data\":\"DD/MM/YYYY\" (data z 'za dzień'),\"gotowka\": liczba (sekcja Kasa: SUMA pozycji 'Gotówka' ORAZ 'Przedpłata - gotówka' jeśli występuje; NIE licz 'Przedpłata - przelew', 'Przelew', 'Karta kredytowa' ani pozycji technicznych oznaczonych gwiazdką jak 'Przyjęcie gotówki od kasjera', 'KW - wypłata', 'Przekazanie gotówki'; jeśli brak pozycji gotówkowych wpisz 0),\"netto\": liczba (jeśli raport ma sekcję 'Grupy podatkowe razem' — pojawia się gdy jest też np. Sklep — bierz wiersz Razem → kolumna Netto z NIEJ; w przeciwnym razie Grupy podatkowe → Razem → Netto)}\n\nLiczby zapisuj z kropką dziesiętną, bez separatorów tysięcy, bez zł (np. 27944.33). Jeśli dokument nie pasuje do żadnego typu (np. RAPORT SPRZEDAŻY GRT wg PS, raport fiskalny, faktura, cokolwiek innego), zwróć {\"typ\":\"nieznany\"}. BEZWZGLĘDNA ZASADA: Twoja odpowiedź to ZAWSZE wyłącznie jeden obiekt JSON — nigdy zdania, opisy, wyjaśnienia ani komentarze, w żadnej sytuacji.`;
const promptWeryfikacji = (odczyt) => `Otrzymujesz dokument (hotelowy raport dzienny) oraz wartości odczytane z niego przez inny system. Twoje zadanie: NIEZALEŻNIE sprawdź każdą wartość w dokumencie i orzeknij, czy odczyt jest poprawny. Jeśli na stronie są dwa wydruki, właściwy jest WYŁĄCZNIE RAPORT PUNKTÓW SPRZEDAŻY — ignoruj RAPORT SPRZEDAŻY GRT wg PS.\n\nDefinicje pól:\n- typ bar: gotowka = sekcja Zapłaty → wiersz Gotówka (NIE Karta kredytowa); netto = Grupy prowizyjne → Gastronomia → kolumna Netto (Z kredytem hotelowym, NIE z sekcji Obr.BRUTTO); brutto = Grupy prowizyjne → Gastronomia → kolumna Brutto (NIE Obr.BRUTTO ani Zapłaty); rabaty = Sprzedaż własna PLU → Rabaty (NIE Storna); goscie = wiersz Gości/śred.brutt kolumna Ilość (NIE liczby przy Rach.zamk.własne ani Rach/śred.brutto — to rachunki); sr_brutto = wartość przy Gości/śred.brutt; sr_netto = wiersz netto pod nim (sr_brutto > sr_netto); data = pole Doba.\n- typ recepcja: gotowka = SUMA pozycji Kasa 'Gotówka' oraz 'Przedpłata - gotówka' jeśli występuje (bez przelewów, kart i pozycji technicznych z gwiazdką; 0 jeśli brak); netto = wiersz Razem → Netto z sekcji 'Grupy podatkowe razem' jeśli istnieje, inaczej z 'Grupy podatkowe'; data = data z 'za dzień'.\n\nWartości do weryfikacji: ${JSON.stringify(odczyt)}\n\nZwróć WYŁĄCZNIE czysty JSON, bez markdown: {\"zgodne\": true} jeśli wszystko poprawne, albo {\"zgodne\": false, \"bledy\": \"które pola się nie zgadzają i jakie wartości faktycznie widzisz w dokumencie\"}.`;
const promptArbitrazu = (kontekst) => `Jesteś arbitrem. Odczyt hotelowego raportu dziennego budzi wątpliwości (niespójność wewnętrzna lub rozbieżność dwóch odczytów). Twoje zadanie: bardzo dokładnie przeanalizować dokument i OSTATECZNIE rozstrzygnąć poprawne wartości. Dokument może być SKANEM PRZEKRZYWIONYM — wtedy przypisanie liczb do kolumn i wierszy wymaga ostrożnego rozumowania, nie czytania wprost.\n\nKontekst sporu: ${kontekst}\n\nWartości bierz WYŁĄCZNIE z wydruku RAPORT PUNKTÓW SPRZEDAŻY. Jeśli obok jest drugi wydruk (RAPORT SPRZEDAŻY GRT wg PS), NIE bierz z niego wartości, ale MOŻESZ go użyć do krzyżowej weryfikacji sum (np. OGÓŁEM na GRT = Obr.BRUTTO = suma Zapłat).\n\nDefinicje pól:\n- typ bar: gotowka = sekcja Zapłaty → wiersz Gotówka (NIE Karta kredytowa); netto = Grupy prowizyjne → Gastronomia → kolumna Netto; brutto = Grupy prowizyjne → Gastronomia → kolumna Brutto (NIE Obr.BRUTTO ani Zapłaty); rabaty = Sprzedaż własna PLU → Rabaty (NIE Storna); goscie = wiersz Gości/śred.brutt kolumna Ilość (NIE liczby rachunków przy Rach.zamk.własne / Rach/śred.brutto); sr_brutto = wartość przy Gości/śred.brutt; sr_netto = wiersz netto pod nim; data = pole Doba.\n- typ recepcja: gotowka = SUMA pozycji Kasa 'Gotówka' oraz 'Przedpłata - gotówka' jeśli występuje (bez przelewów, kart i pozycji technicznych z gwiazdką; 0 jeśli brak); netto = Razem → Netto z sekcji 'Grupy podatkowe razem' jeśli istnieje, inaczej z 'Grupy podatkowe'; data = 'za dzień'.\n\nPRZEANALIZUJ KROK PO KROKU zanim odpowiesz: wypisz wszystkie liczby jakie widzisz i sprawdź arytmetykę — Obr.BRUTTO ÷ goscie ≈ sr_brutto; Obr.BRUTTO ÷ liczba rachunków ≈ średni rachunek na rachunek; Gotówka + Karta kredytowa ≈ suma Zapłat; brutto Gastronomii ÷ netto Gastronomii ≈ 1.08–1.23 (mix VAT); sr_brutto > sr_netto; brutto > netto. Użyj tych zależności, żeby jednoznacznie przypisać liczby do pól nawet na krzywym skanie. Rozstrzygnij pewny:true tylko gdy wartości spinają się arytmetycznie.\n\nAnalizę prowadź zwięźle — maksymalnie kilkanaście krótkich linijek, bez przepisywania całego dokumentu. Na SAMYM KOŃCU odpowiedzi, w ostatniej linii, podaj obiekt JSON, a po nim już absolutnie NIC: {\"pewny\": true, \"dane\": {\"typ\":\"bar|recepcja\",\"data\":\"DD/MM/YYYY\",\"gotowka\":liczba,\"netto\":liczba, dla baru też \"brutto\",\"rabaty\",\"goscie\",\"sr_brutto\",\"sr_netto\"}} albo {\"pewny\": false, \"powod\": \"dlaczego nie da się jednoznacznie odczytać\"}. Liczby z kropką, bez separatorów tysięcy.`;

// ── czyste funkcje (port węzłów „Code" z n8n) ──────────────────────────────
const fmt = n => Number(n).toLocaleString('pl-PL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const tekstOdpowiedzi = (resp) => ((resp && resp.content) || []).filter(c => c.type === 'text').map(c => c.text).join('\n');

// Pierwszy pełny obiekt {...} w tekście (model bywa gadatliwy mimo zakazu).
function pierwszyObiekt(tekst) {
  const start = tekst.indexOf('{');
  if (start < 0) return null;
  let glebokosc = 0;
  for (let i = start; i < tekst.length; i++) {
    if (tekst[i] === '{') glebokosc++;
    else if (tekst[i] === '}') { glebokosc--; if (glebokosc === 0) return tekst.slice(start, i + 1); }
  }
  return null;
}

/* „Parsuj JSON i wylicz zakres": odczyt → zakres w arkuszu albo powód
 * wstrzymania. arbitraz:true = do rozstrzygnięcia mocniejszym modelem. */
function ocenOdczyt(tekst) {
  const czysty = String(tekst || '').replace(/```json|```/g, '').trim();
  let d;
  try { d = JSON.parse(pierwszyObiekt(czysty) || czysty); } catch (e) {
    return { ok: false, arbitraz: true, temat: '⚠️ Raport kasowy — nierozpoznany dokument', opis: `Nie udało się odczytać załącznika jako raportu barowego ani recepcyjnego. Najczęstsza przyczyna: bar/recepcja wysłała inny wydruk (np. RAPORT SPRZEDAŻY GRT wg PS zamiast RAPORT PUNKTÓW SPRZEDAŻY). Poproś o właściwy raport.\n\nOdpowiedź systemu: ${czysty.slice(0, 300)}` };
  }
  if (!d || d.typ === 'nieznany' || !d.data) {
    return { ok: false, temat: '⚠️ Raport kasowy — nierozpoznany załącznik', opis: 'Załącznik nie wygląda na raport barowy (RAPORT PUNKTÓW SPRZEDAŻY) ani recepcyjny (Raport recepcji Galiny) — pomijam. Jeśli to miał być raport dzienny, poproś nadawcę o właściwy wydruk: bar → RAPORT PUNKTÓW SPRZEDAŻY, recepcja → Raport recepcji / sprzedaż wykonana.' };
  }
  const [dd, mm, yyyy] = String(d.data).split(/[/.-]/).map(Number);
  if (!dd || !mm || !yyyy || dd > 31 || mm > 12) return { ok: false, temat: '❌ Raport kasowy — błędna data', opis: `Nieprawidłowa data w raporcie: ${d.data}` };
  const sheet = `${MIESIACE[mm - 1]} ${yyyy}`;
  const row = dd + 3; // dzień 1 = wiersz 4

  if (d.typ === 'bar') {
    const problemy = [];
    if (!(Number(d.brutto) > Number(d.netto))) problemy.push('brutto nie większe od netto');
    const ratio = Number(d.brutto) / Number(d.netto);
    if (!(ratio > 1.03 && ratio < 1.35)) problemy.push('stosunek brutto/netto poza widełkami VAT (możliwe pomylenie pól)');
    if (!(Number(d.sr_brutto) >= Number(d.sr_netto))) problemy.push('średni rachunek brutto mniejszy od netto (prawdopodobnie zamienione)');
    if (!(Number(d.goscie) > 0 && Number(d.goscie) < 2000)) problemy.push('podejrzana liczba gości');
    if (d.rachunki != null && Number(d.goscie) <= Number(d.rachunki)) problemy.push('liczba gości nie większa niż liczba rachunków (możliwa zamiana pól)');
    if (d.obrot != null && d.karta != null && Math.abs(Number(d.gotowka) + Number(d.karta) - Number(d.obrot)) > 0.02) problemy.push(`gotówka + karta (${(Number(d.gotowka) + Number(d.karta)).toFixed(2)}) nie sumuje się do obrotu (${Number(d.obrot).toFixed(2)}) — możliwy błąd cyfry lub inna forma płatności`);
    if (d.obrot != null && Number(d.goscie) > 0 && Math.abs(Number(d.obrot) / Number(d.goscie) - Number(d.sr_brutto)) > 0.5) problemy.push('obrót ÷ goście nie zgadza się ze średnim rachunkiem brutto');
    if ([d.gotowka, d.netto, d.brutto, d.rabaty, d.sr_brutto, d.sr_netto].some(v => isNaN(Number(v)) || Number(v) < 0)) problemy.push('ujemna lub nieliczbowa wartość');
    if (problemy.length) {
      return { ok: false, arbitraz: true, typ: d.typ, data: d.data, sheet, row, values: [[d.gotowka, d.netto, d.brutto, d.rabaty, d.goscie, d.sr_brutto, d.sr_netto]], temat: `⚠️ Raport BAR ${d.data} — odczyt niespójny, WSTRZYMANY`, opis: `Kontrola spójności wykryła problemy: ${problemy.join('; ')}.\n\nOdczytane wartości: ${JSON.stringify(d)}\n\nPrawdopodobnie skan jest krzywy lub nieczytelny — nic nie wpisałem. Poproś o ponowny, prosty skan samego RAPORTU PUNKTÓW SPRZEDAŻY (jeden wydruk na stronie) albo wpisz wartości ręcznie.` };
    }
    return {
      ok: true, typ: 'bar', data: d.data, sheet, row, range: `'${sheet}'!F${row}:L${row}`,
      values: [[d.gotowka, d.netto, d.brutto, d.rabaty, d.goscie, d.sr_brutto, d.sr_netto]],
      temat: `✅ Raport BAR ${d.data} wpisany do arkusza`,
      opis: `Raport barowy za ${d.data} został wpisany do arkusza (zakładka ${sheet}, wiersz ${row}):\n\nGotówka: ${fmt(d.gotowka)} zł (kol. F)\nSprzedaż netto: ${fmt(d.netto)} zł (kol. G)\nSprzedaż brutto: ${fmt(d.brutto)} zł (kol. H)\nRabaty: ${fmt(d.rabaty)} zł (kol. I)\nIlość gości: ${d.goscie} (kol. J)\nŚredni rachunek brutto: ${fmt(d.sr_brutto)} zł (kol. K)\nŚredni rachunek netto: ${fmt(d.sr_netto)} zł (kol. L)`,
    };
  }
  if (d.typ === 'recepcja') {
    return {
      ok: true, typ: 'recepcja', data: d.data, sheet, row, range: `'${sheet}'!C${row}:D${row}`,
      values: [[d.gotowka, d.netto]],
      temat: `✅ Raport RECEPCJA ${d.data} wpisany do arkusza`,
      opis: `Raport recepcyjny za ${d.data} został wpisany do arkusza (zakładka ${sheet}, wiersz ${row}):\n\nGotówka: ${fmt(d.gotowka)} zł (kol. C)\nSprzedaż netto: ${fmt(d.netto)} zł (kol. D)`,
    };
  }
  return { ok: false, temat: '⚠️ Raport kasowy — nieznany typ', opis: `Nieznany typ raportu: ${d.typ}` };
}

// Wartości do promptu weryfikacji (jak „Weryfikacja — payload").
function odczytDoWeryfikacji(w) {
  const v = w.values[0];
  return w.typ === 'bar'
    ? { typ: 'bar', data: w.data, gotowka: v[0], netto: v[1], brutto: v[2], rabaty: v[3], goscie: v[4], sr_brutto: v[5], sr_netto: v[6] }
    : { typ: 'recepcja', data: w.data, gotowka: v[0], netto: v[1] };
}

function ocenWeryfikacje(tekst) {
  try {
    const p = JSON.parse(String(tekst || '').replace(/```json|```/g, '').trim());
    if (typeof p.zgodne === 'boolean') return p;
  } catch (e) { /* niżej */ }
  return { zgodne: false, bledy: 'Nie udało się sparsować odpowiedzi weryfikatora' };
}

function kontekstArbitrazu(p, wer) {
  const uwagiWer = wer && wer.bledy ? ` Zastrzeżenia weryfikatora: ${wer.bledy}.` : '';
  return (p.values ? `Pierwszy odczyt (typ ${p.typ}, data ${p.data}): ${JSON.stringify(p.values)}.` : 'Pierwszy odczyt nie zwrócił poprawnego JSON — przeczytaj dokument całkowicie od zera.')
    + uwagiWer + (p.opis && !uwagiWer ? ' Powód wstrzymania: ' + p.opis.split('\n')[0] : '');
}

/* „Parsuj arbitraż": ostatni obiekt JSON z polem `pewny` po analizie. */
function ocenArbitraz(tekst) {
  const t = String(tekst || '').replace(/```json|```/g, '').trim();
  try {
    const obiekty = [];
    for (let i = 0; i < t.length; i++) {
      if (t[i] !== '{') continue;
      let g = 0;
      for (let j = i; j < t.length; j++) {
        if (t[j] === '{') g++;
        else if (t[j] === '}') { g--; if (g === 0) { obiekty.push(t.slice(i, j + 1)); i = j; break; } }
      }
    }
    let p = null;
    for (const kand of obiekty.reverse()) { try { const o = JSON.parse(kand); if (typeof o.pewny === 'boolean') { p = o; break; } } catch (e2) { /* następny */ } }
    if (!p) throw new Error('brak obiektu JSON z polem pewny');
    if (p.pewny === true && p.dane && p.dane.data) {
      const d = p.dane;
      const [dd, mm, yyyy] = String(d.data).split(/[/.-]/).map(Number);
      let ok = dd >= 1 && dd <= 31 && mm >= 1 && mm <= 12 && !!yyyy;
      if (d.typ === 'bar') {
        if (!(Number(d.brutto) >= Number(d.netto))) ok = false;
        if (!(Number(d.sr_brutto) >= Number(d.sr_netto))) ok = false;
        if (!(Number(d.goscie) > 0 && Number(d.goscie) < 2000)) ok = false;
      } else if (d.typ !== 'recepcja') ok = false;
      if (ok) {
        const sheet = `${MIESIACE[mm - 1]} ${yyyy}`;
        const row = dd + 3;
        const bar = d.typ === 'bar';
        const values = bar ? [[d.gotowka, d.netto, d.brutto, d.rabaty, d.goscie, d.sr_brutto, d.sr_netto]] : [[d.gotowka, d.netto]];
        const kolumny = bar
          ? `gotówka ${d.gotowka} (F), netto ${d.netto} (G), brutto ${d.brutto} (H), rabaty ${d.rabaty} (I), goście ${d.goscie} (J), śr. brutto ${d.sr_brutto} (K), śr. netto ${d.sr_netto} (L)`
          : `gotówka ${d.gotowka} (C), netto ${d.netto} (D)`;
        return {
          ok: true, typ: d.typ, data: d.data, sheet, row, range: bar ? `'${sheet}'!F${row}:L${row}` : `'${sheet}'!C${row}:D${row}`, values,
          temat: `✅ Raport ${d.typ.toUpperCase()} ${d.data} wpisany do arkusza (rozstrzygnięty przez arbitraż)`,
          opis: `Dwa odczyty się różniły, mocniejszy model przeanalizował dokument i rozstrzygnął. Wpisano do arkusza (zakładka ${sheet}, wiersz ${row}):\n\n${kolumny}`,
        };
      }
      return { ok: false, powod: `Wynik arbitra nie przeszedł kontroli spójności: ${JSON.stringify(d)}` };
    }
    return { ok: false, powod: p.powod || 'Arbiter nie podał powodu' };
  } catch (e) {
    return { ok: false, powod: 'Nie udało się sparsować odpowiedzi arbitra. Początek odpowiedzi: ' + t.slice(0, 200) };
  }
}

// Wiersz w arkuszu ma już coś wpisane?
const czyWpisane = (arkusz) => (arkusz || []).flat().some(v => v !== null && v !== undefined && String(v).trim() !== '');
// Te same kwoty co w arkuszu? (liczby; tolerancja na grosze z zaokrągleń)
function teSameKwoty(arkusz, values) {
  const a = (arkusz || []).flat().map(v => Number(String(v).replace(/\s/g, '').replace(',', '.')));
  const b = (values || []).flat().map(Number);
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 0.005);
}

/* Data w Warszawie: { rok, miesiac (1-12), dzien } — „jutro 1-szy?" liczymy
 * po polskim kalendarzu, nie UTC (o 4:00 w Polsce w UTC bywa jeszcze wczoraj). */
function dataWarszawa(d) {
  const [rok, miesiac, dzien] = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Warsaw', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d).split('-').map(Number);
  return { rok, miesiac, dzien };
}
function nowyMiesiac(teraz = new Date()) {
  const dzis = dataWarszawa(teraz);
  const jutro = dataWarszawa(new Date(teraz.getTime() + 24 * 3600 * 1000));
  if (jutro.dzien !== 1) return null;
  return { nowa: `${MIESIACE[jutro.miesiac - 1]} ${jutro.rok}`, zrodlo: `${MIESIACE[dzis.miesiac - 1]} ${dzis.rok}` };
}

// ── jeden załącznik: odczyt → weryfikacja / arbitraż → arkusz → mail ────────
/* deps: claude(payload)→odpowiedź API, popraw(base64, mime)→{skip|pages},
 * arkusz {pobierz(range), zapisz(range, values)}, wyslij({do, temat, tekst,
 * zalacznik?}), ustawienia {potwierdzenia[], alerty[]}.
 * Zwraca { status, etap, typ, data, sheet, row, values, szczegoly, awariaPoprawy }. */
async function przetworzZalacznik(zal, deps) {
  const mime = String(zal.contentType || '').toLowerCase();
  const nazwa = String(zal.filename || 'raport').toLowerCase();
  const ust = deps.ustawienia;
  let media = null;
  const b64 = Buffer.from(zal.content).toString('base64');
  if (mime.includes('pdf') || nazwa.endsWith('.pdf')) media = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  else if (mime.includes('jpeg') || mime.includes('jpg') || /\.jpe?g$/.test(nazwa)) media = { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } };
  else if (mime.includes('png') || nazwa.endsWith('.png')) media = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: b64 } };
  else if (mime.includes('webp') || nazwa.endsWith('.webp')) media = { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: b64 } };
  else if (mime.includes('heic') || mime.includes('heif') || /\.hei[cf]$/.test(nazwa)) {
    await deps.wyslij({ do: ust.alerty, temat: '⚠️ Raport kasowy — format HEIC, nie odczytam', tekst: `Załącznik ${zal.filename || 'bez nazwy'} to zdjęcie w formacie HEIC (domyślny format iPhone), którego nie da się automatycznie odczytać.\n\nPoproś nadawcę o ponowne wysłanie raportu jako PDF (najlepiej skan z aplikacji Notatki: Notatki → aparat → Skanuj dokumenty) albo jako JPG.\n\nŻeby iPhone robił zdjęcia od razu w JPG: Ustawienia → Aparat → Formaty → Najbardziej zgodne.` });
    return { status: 'pominiety', szczegoly: 'HEIC' };
  } else return { status: 'pominiety', szczegoly: `nieobsługiwany typ ${mime || nazwa}` };

  // 1. Poprawa skanu — fail-open, ale głośno (awaria wraca do wołającego).
  let bloki = [media];
  let awariaPoprawy = null;
  try {
    const r = await deps.popraw(b64, mime || media.source.media_type);
    if (r && r.skip === true) { /* cyfrowy PDF — nie ma czego prostować */ }
    else if (r && Array.isArray(r.pages) && r.pages.length) bloki = r.pages.slice(0, 3).map(pg => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: pg } }));
    else awariaPoprawy = `${zal.filename}: usługa odpowiedziała, ale nie zwróciła stron`;
  } catch (e) {
    awariaPoprawy = `${zal.filename}: ${String(e.message || e).slice(0, 160)}`;
  }
  const modele = MODELE();
  const zalacznik = { filename: zal.filename || 'raport', content: zal.content, contentType: zal.contentType || media.source.media_type };
  const wynik = (o) => ({ awariaPoprawy, ...o });

  // 2. Odczyt.
  const odp = await deps.claude({ model: modele.odczyt, max_tokens: 1000, messages: [{ role: 'user', content: [...bloki, { type: 'text', text: PROMPT_ODCZYT }] }] });
  const p = ocenOdczyt(tekstOdpowiedzi(odp));

  // Zapis po sprawdzeniu duplikatu — wspólny dla odczytu potwierdzonego i arbitrażu.
  const wpisz = async (w, etap) => {
    const wArkuszu = await deps.arkusz.pobierz(w.range);
    if (czyWpisane(wArkuszu)) {
      if (teSameKwoty(wArkuszu, w.values)) return wynik({ status: 'duplikat', etap, typ: w.typ, data: w.data, sheet: w.sheet, row: w.row, values: w.values, szczegoly: 'te same kwoty już w arkuszu' });
      await deps.wyslij({ do: ust.alerty, temat: `🚨 Duplikat z INNYMI kwotami — raport ${w.typ.toUpperCase()} ${w.data} pominięty`, tekst: `Raport ${w.typ.toUpperCase()} za ${w.data} już jest wpisany w arkuszu (zakładka ${w.sheet}, wiersz ${w.row}), ale nowy mail zawiera INNE kwoty — nic nie nadpisałem, sprawdź który raport jest właściwy.\n\nWartości obecnie w arkuszu: ${JSON.stringify(wArkuszu)}\nWartości z pominiętego raportu: ${JSON.stringify(w.values)}` });
      return wynik({ status: 'duplikat_inne_kwoty', etap, typ: w.typ, data: w.data, sheet: w.sheet, row: w.row, values: w.values, szczegoly: JSON.stringify(wArkuszu) });
    }
    await deps.arkusz.zapisz(w.range, w.values);
    await deps.wyslij({ do: ust.potwierdzenia, temat: w.temat, tekst: w.opis, zalacznik });
    return wynik({ status: 'wpisany', etap, typ: w.typ, data: w.data, sheet: w.sheet, row: w.row, values: w.values });
  };

  const arbitraz = async (wer) => {
    const odpA = await deps.claude({ model: modele.arbitraz, max_tokens: 8000, messages: [{ role: 'user', content: [...bloki, { type: 'text', text: promptArbitrazu(kontekstArbitrazu(p, wer)) }] }] });
    const a = ocenArbitraz(tekstOdpowiedzi(odpA));
    if (a.ok) return wpisz(a, 'arbitraz');
    const TYP = (p.typ || 'NIEROZPOZNANY').toUpperCase();
    await deps.wyslij({ do: ust.alerty, temat: `🚨 Nawet arbitraż nie rozstrzygnął — raport ${TYP} ${p.data || ''} WSTRZYMANY`, tekst: `Odczyty (ekstrakcja, weryfikacja, arbitraż mocniejszym modelem) nie dały jednoznacznego wyniku — NIC nie zostało wpisane do arkusza. To prawie na pewno oznacza nieczytelny skan.\n\nRaport: ${TYP} za ${p.data || 'brak daty'} (zakładka ${p.sheet || '?'}, wiersz ${p.row || '?'})\n\nWartości z pierwszego odczytu: ${JSON.stringify(p.values || null)}\nUwagi weryfikatora: ${wer ? wer.bledy : 'weryfikacja pominięta — odczyt zatrzymany wcześniej'}\nPowód arbitra: ${a.powod}\n\nPoproś o ponowny, prosty skan samego RAPORTU PUNKTÓW SPRZEDAŻY albo wpisz wartości ręcznie.` });
    return wynik({ status: 'wstrzymany', etap: 'arbitraz', typ: p.typ, data: p.data, values: p.values, szczegoly: a.powod });
  };

  if (!p.ok) {
    if (p.arbitraz) return arbitraz(null);
    await deps.wyslij({ do: ust.alerty, temat: p.temat, tekst: p.opis });
    return wynik({ status: 'pominiety', etap: 'odczyt', szczegoly: p.temat });
  }

  // 3. Dzień już wpisany? Te same kwoty → nic; inne → alert (bez weryfikacji, jak w n8n).
  const wArkuszu = await deps.arkusz.pobierz(p.range);
  if (czyWpisane(wArkuszu)) {
    if (teSameKwoty(wArkuszu, p.values)) return wynik({ status: 'duplikat', etap: 'odczyt', typ: p.typ, data: p.data, sheet: p.sheet, row: p.row, values: p.values, szczegoly: 'te same kwoty już w arkuszu' });
    await deps.wyslij({ do: ust.alerty, temat: `🚨 Duplikat z INNYMI kwotami — raport ${p.typ.toUpperCase()} ${p.data} pominięty`, tekst: `Raport ${p.typ.toUpperCase()} za ${p.data} już jest wpisany w arkuszu (zakładka ${p.sheet}, wiersz ${p.row}), ale nowy mail zawiera INNE kwoty — nic nie nadpisałem, sprawdź który raport jest właściwy.\n\nWartości obecnie w arkuszu: ${JSON.stringify(wArkuszu)}\nWartości z pominiętego raportu: ${JSON.stringify(p.values)}` });
    return wynik({ status: 'duplikat_inne_kwoty', etap: 'odczyt', typ: p.typ, data: p.data, sheet: p.sheet, row: p.row, values: p.values, szczegoly: JSON.stringify(wArkuszu) });
  }

  // 4. Niezależna weryfikacja; spór → arbitraż.
  const odpW = await deps.claude({ model: modele.weryfikacja, max_tokens: 500, messages: [{ role: 'user', content: [...bloki, { type: 'text', text: promptWeryfikacji(odczytDoWeryfikacji(p)) }] }] });
  const wer = ocenWeryfikacje(tekstOdpowiedzi(odpW));
  if (wer.zgodne) return wpisz(p, 'weryfikacja');
  return arbitraz(wer);
}

module.exports = {
  KLUCZ_USTAWIENIA, KLUCZ_STAN, KLUCZ_DZIEN, MIESIACE, MODELE, MIN_OBRAZ_B,
  PROMPT_ODCZYT, promptWeryfikacji, promptArbitrazu,
  ocenOdczyt, ocenWeryfikacje, ocenArbitraz, kontekstArbitrazu, odczytDoWeryfikacji,
  czyWpisane, teSameKwoty, nowyMiesiac, dataWarszawa, przetworzZalacznik,
};
