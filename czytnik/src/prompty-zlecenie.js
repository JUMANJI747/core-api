'use strict';
/**
 * prompty-zlecenie.js — DRUGI FORMULARZ: „Ewidencjonowanie czasu wykonywania
 * umowy zlecenie". To nie jest wariant karty pracy, tylko inny dokument:
 *
 *   - trzy kolumny: Dzień | Liczba godzin | Podpis zleceniobiorcy,
 *   - w rubryce „Liczba godzin" NIE MA LICZBY, tylko PRZEDZIAŁ ("7:00 - 15:00"),
 *     więc godziny trzeba wyliczyć — i robi to KOD, nie model,
 *   - wiersz SUMA na dole jest zwykle pusty (na 38 kartach sierpnia 2026 nie
 *     wypełniono go ani razu), więc kontrola „suma z karty" tu nie działa,
 *   - imię i nazwisko jest pisane ręcznie w jednej linii, bez zamkniętej listy
 *     pracowników — zleceniobiorcy zmieniają się co miesiąc.
 *
 * Priorytet ustalony z użytkownikiem: **liczy się suma godzin**, literówka
 * w nazwisku jest do przełknięcia. Dlatego bramką jest zgodność SUMY między
 * dwoma niezależnymi czytelnikami, a nazwisko idzie jako informacja.
 *
 * Konwencja pól jak w karcie pracy: wszystko stringami (schemat bez unii typów),
 * "" = pusto, "?" = nieczytelne.
 */

const S = () => ({ type: 'string' });

const SCHEMAT_ZLECENIE = {
  type: 'object',
  properties: {
    imieNazwisko: S(),
    miesiac: S(),
    rok: S(),
    dni: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          d: S(),          // numer dnia, tak jak w pierwszej kolumnie
          zapis: S(),      // DOKŁADNIE to, co widać w rubryce "Liczba godzin"
          od: S(),         // godzina rozpoczęcia z przedziału ("7:00")
          do: S(),         // godzina zakończenia ("15:00")
          podpis: S(),     // "tak" gdy w trzeciej kolumnie jest podpis, inaczej ""
          uwaga: S(),
        },
        required: ['d', 'zapis', 'od', 'do', 'podpis', 'uwaga'],
        additionalProperties: false,
      },
    },
    suma: S(),             // wiersz SUMA, jeśli wypełniony
    uwagaOgolna: S(),
  },
  required: ['imieNazwisko', 'miesiac', 'rok', 'dni', 'suma', 'uwagaOgolna'],
  additionalProperties: false,
};

const PROMPT_ZLECENIE = `Dostajesz zdjęcia jednej karty „EWIDENCJONOWANIE CZASU WYKONYWANIA UMOWY ZLECENIE"
(cała strona, nagłówek, górna połowa tabeli, dolna połowa tabeli).

Tabela ma trzy kolumny: "Dzień" (1-31 i wiersz SUMA), "Liczba godzin", "Podpis zleceniobiorcy".

TWOJE ZADANIE: przepisać zawartość, nie interpretować.

ZASADY:
- W rubryce "Liczba godzin" prawie zawsze jest PRZEDZIAŁ GODZIN, np. "7:00 - 15:00", często zapisany
  z małymi zerami u góry ("7 00 - 15 00") albo z kreską w środku. Przepisz go DOKŁADNIE do pola "zapis",
  a rozłóż na "od" i "do" (format "7:00", "15:30").
- Jeżeli w rubryce jest sama LICZBA godzin (np. "8"), wpisz ją do "zapis", a "od" i "do" zostaw puste.
- Pusty wiersz: "zapis", "od", "do" puste. NIE zgaduj, NIE uzupełniaj dni, których nie ma.
- Godzin NIE LICZ i NIE SUMUJ — od tego jest kod. Twoim zadaniem jest wierna transkrypcja.
- Kolumna podpisu: wpisz "tak", jeśli w wierszu jest jakikolwiek podpis/parafka, inaczej "".
  Podpis bez godzin i godziny bez podpisu to normalne sytuacje — po prostu zapisz stan faktyczny.
- Nieczytelna rubryka: "?" w polu "zapis" i krótkie wyjaśnienie w "uwaga".
- MAŁE ZERA U GÓRY to minuty "00", a nie cyfry przy godzinie: "7 00 - 15 00" znaczy 7:00-15:00, nie 700-1500.
- Wiersz SUMA na dole: jeżeli ktoś go wypełnił, przepisz wartość do pola "suma"; pusty -> "".
- Imię i nazwisko przepisz z nagłówka dokładnie tak, jak napisano (pismo odręczne).
  Jeśli nieczytelne, napisz tyle, ile widzisz, i dopisz "?" — nie zgaduj nazwisk.
- Miesiąc i rok przepisz z nagłówka.

Zwróć dokładnie jeden obiekt JSON zgodny ze schematem, bez komentarzy.`;

module.exports = { SCHEMAT_ZLECENIE, PROMPT_ZLECENIE };
