'use strict';
/**
 * prompty.js — polityka odczytu karty (profil: karta ewidencji czasu pracy).
 *
 * NAJWAŻNIEJSZA różnica wobec starego core-api/src/karty-pracy-odczyt.js:
 * tam prompt ZAKAZYWAŁ wnioskowania ("NIGDY nie zgaduj i nie wyliczaj").
 * Tu wnioskowanie po nadmiarowości karty jest NAKAZANE — ale wyłącznie
 * w osobnym kanale "wniosek", przy nienaruszalnej transkrypcji w "zapis".
 * Dzięki temu audyt widzi, co model PRZECZYTAŁ, a co WYWNIOSKOWAŁ.
 */

// ZERO UNII TYPOW: structured outputs dopuszczaja najwyzej 16 pol z unia
// (nasz schemat mial 32 i API odrzucalo zadanie bledem 400). Dlatego KAZDE pole
// jest zwyklym stringiem z konwencja: "" = pusta rubryka / brak wartosci,
// "?" = nieczytelne, liczby jako string z kropka ("9.5"). Parsowanie robi
// walidacja.js (L() zamienia ""/"?" na null).
const S = () => ({ type: 'string' });

const DZIEN_ZAPIS = {
  type: 'object',
  properties: {
    od: S(), do: S(), razem: S(),
    sto: S(), nocne: S(), uw: S(), chor: S(),
    kod: S(), notatka: S(),
  },
  required: ['od', 'do', 'razem', 'sto', 'nocne', 'uw', 'chor', 'kod', 'notatka'],
  additionalProperties: false,
};

const DZIEN_WNIOSEK = {
  type: 'object',
  properties: {
    razem: S(), sto: S(), nocne: S(),
    uw: S(), chor: S(), kod: S(),
  },
  required: ['razem', 'sto', 'nocne', 'uw', 'chor', 'kod'],
  additionalProperties: false,
};

const SUMA_POLA = {
  type: 'object',
  properties: { razem: S(), sto: S(), nocne: S(), uw: S(), chor: S() },
  required: ['razem', 'sto', 'nocne', 'uw', 'chor'],
  additionalProperties: false,
};

const SCHEMAT_KARTY = {
  type: 'object',
  properties: {
    naglowek: {
      type: 'object',
      properties: {
        nazwisko: S(),
        miesiac: S(),
        rok: S(),
        norma: S(),
      },
      required: ['nazwisko', 'miesiac', 'rok', 'norma'],
      additionalProperties: false,
    },
    dni: {
      // BEZ minItems/maxItems: structured outputs wspieraja tylko wartosci 0/1
      // (API odrzucalo schemat z minItems:28). Komplet dni pilnuje walidacja K9.
      type: 'array',
      items: {
        type: 'object',
        properties: {
          d: { type: 'integer' },
          zapis: DZIEN_ZAPIS,
          wniosek: DZIEN_WNIOSEK,
          pewnosc: { type: 'string', enum: ['wysoka', 'niska'] },
          uwaga: S(),
        },
        required: ['d', 'zapis', 'wniosek', 'pewnosc', 'uwaga'],
        additionalProperties: false,
      },
    },
    suma: {
      type: 'object',
      properties: {
        zapis: {
          type: 'object',
          properties: { razem: S(), sto: S(), nocne: S(), uw: S(), chor: S() },
          required: ['razem', 'sto', 'nocne', 'uw', 'chor'],
          additionalProperties: false,
        },
        wniosek: SUMA_POLA,
        pewnosc: { type: 'string', enum: ['wysoka', 'niska'] },
        uwaga: S(),
      },
      required: ['zapis', 'wniosek', 'pewnosc', 'uwaga'],
      additionalProperties: false,
    },
    rozbieznosci: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          miejsce: { type: 'string' },
          zapis: S(),
          wniosek: { type: 'string' },
          uzasadnienie: { type: 'string' },
        },
        required: ['miejsce', 'zapis', 'wniosek', 'uzasadnienie'],
        additionalProperties: false,
      },
    },
  },
  required: ['naglowek', 'dni', 'suma', 'rozbieznosci'],
  additionalProperties: false,
};

/* --- dogrywka P1: neutralny odczyt jednej komórki (zero kotwiczenia) --- */

const SCHEMAT_ZOOM = {
  type: 'object',
  properties: {
    dzien: { type: 'string' },
    wartosc: { type: 'string' },
    pewnosc: { type: 'string', enum: ['wysoka', 'niska'] },
  },
  required: ['dzien', 'wartosc', 'pewnosc'],
  additionalProperties: false,
};

const OPISY_POL = {
  od: 'Godz. rozpocz. pracy', do: 'Godz. zakoncz. pracy', razem: 'Ilosc godzin RAZEM',
  sto: '100% (godziny w swieto)', nocne: 'nocne', uw: 'UW (urlop wypoczynkowy)', chor: 'Chor. (chorobowe)',
};

const PROMPT_ZOOM = pole => `Na obrazie sa dwa wycinki JEDNEGO wiersza tabeli karty pracy:
po lewej numer dnia miesiaca, po prawej rubryka "${OPISY_POL[pole] || pole}".
Odczytaj obie rzeczy dokladnie tak, jak sa napisane.
- pusta rubryka -> wartosc "" (to czeste i normalne), nieczytelna -> "?"
- przecinek dziesietny zapisuj kropka; godziny sa wielokrotnosciami 0.5
- na krawedziach moga byc scinki sasiednich rubryk - ignoruj je
- NIE zgaduj: masz przed soba wszystko, co podlega ocenie`;

const PROMPT_ZOOM_SUMA = pole => `Na obrazie jest JEDNA rubryka z wiersza SUMA karty pracy
(kolumna "${OPISY_POL[pole] || pole}", podsumowanie miesiaca), powiekszona.
Odczytaj dokladnie to, co napisane. Pusta -> "", nieczytelna -> "?".
Przecinek dziesietny jako kropka; godziny sa wielokrotnosciami 0.5.
W polu dzien wpisz "SUMA".`;

const SCHEMAT_NAZWISKO = {
  type: 'object',
  properties: {
    zapis: S(),
    pewnosc: { type: 'string', enum: ['wysoka', 'niska'] },
  },
  required: ['zapis', 'pewnosc'],
  additionalProperties: false,
};

const PROMPT_KARTA = `Dostajesz JEDNĄ kartę "KARTA EWIDENCJI CZASU PRACY" (polski formularz wypełniany odręcznie) na czterech obrazach:
1) cała strona — do ogólnego kontekstu (układ, dopiski, parafki),
2) nagłówek — miesiąc/rok, nazwisko, "Ilość godzin do przepracowania" (norma),
3) górna połowa tabeli — nagłówki kolumn i dni 1–16,
4) dolna połowa tabeli — dni 16–31 oraz wiersz SUMA na dole.
Obrazy 3 i 4 zachodzą na siebie (dzień 16 jest w obu) i są ostrzejsze niż cała strona — liczby odczytuj z nich, a z obrazu 1 korzystaj do kontekstu.

Kolumny tabeli od lewej: [dzień miesiąca] [Godz. rozpocz. pracy] [podpis] [Godz. zakończ. pracy] [podpis] [Ilość godzin RAZEM] [normalne] [50%] [100%] [nocne] [UW] [Chor.].

KONWENCJA WARTOŚCI (wszystkie pola są stringami):
- pusta rubryka -> "" (pusty string); nieczytelna -> "?". Pusta i nieczytelna to RÓŻNE rzeczy.
- liczby w polach "wniosek" zapisuj jako string z KROPKĄ dziesiętną: "9", "6.5", "175.5".

TWOJE ZADANIE — dwa kanały dla każdego pola:
- "zapis" = WIERNA TRANSKRYPCJA tego, co fizycznie napisano: "6,5", "7/17", "W". Zapisu NIE WOLNO poprawiać ani uzupełniać.
- "wniosek" = wartość po interpretacji i sprawdzeniu krzyżowym. Karta jest NADMIAROWA: godzina rozpoczęcia i zakończenia ↔ RAZEM ↔ sumy narastające ↔ wiersz SUMA ↔ norma z nagłówka. UŻYWAJ tej nadmiarowości: niewyraźną cyfrę wolno rozstrzygnąć arytmetyką (np. RAZEM wygląda jak 9 lub 4, a 15:00−7:00=8 z przerwą daje 9 -> wniosek "9"). Pusta rubryka -> wniosek "".
- Gdy wniosek różni się od literalnego zapisu albo pewność jest niska: pewnosc="niska" i OBOWIĄZKOWA "uwaga" (co widzisz, co wybrałeś i dlaczego) + wpis w "rozbieznosci". Konflikt ZGŁOŚ — nie rozstrzygaj po cichu.

KONWENCJE TEGO FORMULARZA (zweryfikowane na prawdziwych kartach):
- Zamiast godziny rozpoczęcia bywa litera: W (wolne), U (urlop), C (chorobowe) albo pozioma kreska. Wtedy wniosek.razem="", litera w "kod". Kod i godziny naraz to błąd — zgłoś w uwadze.
- Zapis "7/17" w rozpoczęciu, "15/19" w zakończeniu, "8/2" w RAZEM = DWIE zmiany tego samego dnia; wniosek.razem = suma obu (8/2 -> 10).
- Kolumna "normalne" bywa brudnopisem: narastające sumy pośrednie (np. 127,5 przy dniu 22). To NIE są godziny dnia — do "zapis.notatka", nie do razem.
- Godziny są wielokrotnościami 0,5. Odręczne "6,5" bywa mylone z "65" — przecinek to nie cyfra. W "wniosek" przecinek dziesiętny zapisuj kropką (6.5).
- Ostatni wiersz tabeli (bez numeru dnia) to SUMA — podsumowanie miesiąca. Rubryki SUMA bywają puste (to normalne): zapis "" i wniosek "".
- Kolumny 100%, nocne, UW, Chor. są zwykle puste; wypełnione wartości są MNIEJSZE lub równe RAZEM.
- Parafki i podpisy to NIE są liczby. Na krawędziach wycinków bywa ścinek sąsiedniego wiersza — ignoruj.
- Rubryka "Miesiąc/rok" zawiera zwykle SAM miesiąc (np. CZERWIEC) — wtedy rok="", to normalne; miesiąc podaj jako liczbę ("6").
- Nazwisko przepisz dokładnie tak, jak napisane (zapis wierny; jeśli nieczytelne -> "?").

Tablica "dni" ma dokładnie tyle wpisów, ile dni ma miesiąc, po kolei od d=1. Dzień 16 (widoczny na obu połówkach) odczytaj raz, porównując oba obrazy.`;

const PROMPT_NAZWISKO = `Na obrazie jest nagłówek karty ewidencji czasu pracy. Odczytaj WYŁĄCZNIE odręcznie wpisane imię i nazwisko pracownika (rubryka "Nazwisko i imię" / "Imię i nazwisko").
Przepisz je dokładnie tak, jak jest napisane — bez poprawiania, bez zgadywania. Jeśli nie da się odczytać pewnie, daj zapis="?" i pewnosc="niska". Podpisy i parafki to nie jest nazwisko.`;

module.exports = { SCHEMAT_KARTY, SCHEMAT_NAZWISKO, PROMPT_KARTA, PROMPT_NAZWISKO,
  SCHEMAT_ZOOM, PROMPT_ZOOM, PROMPT_ZOOM_SUMA };
