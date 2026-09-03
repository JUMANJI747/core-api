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
 * TRZY WZORCE DOPISANE PO ŚLEPEJ KONTROLI SIERPNIA 2026 (38 kart, trzeci
 * czytelnik czytał je od zera i porównaliśmy dzień po dniu):
 *   - `skreslone` — wiersz przekreślony. Model czytał cyfry i nie widział kreski,
 *     drugi czytelnik miał tę samą ślepotę, więc obaj zgodnie potwierdzali
 *     anulowany dzień i karta dostawała „auto". Szejerska: +11 h z dnia,
 *     który jest przekreślony i nie ma nawet podpisu.
 *   - `zapis2` — DWIE ZMIANY w jednym dniu („6-8:30" i „11-22" = 13,5 h).
 *     Fedorstova miała tak dwa dni; braliśmy jeden przedział, karta była
 *     zaniżona o 21 h.
 *   - `zapisPodpis` — liczba godzin dopisana w kolumnie podpisu. Na części kart
 *     to JEDYNE miejsce, gdzie człowiek podaje wynik. Stępnowski dzień 17:
 *     w rubryce „11-19 kl. 11-20", przy podpisie jego własne „9" — my
 *     wpisaliśmy 20 h.
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
          zapis2: S(),     // DRUGA zmiana tego samego dnia, jeśli jest ("11:00-22:00")
          od: S(),         // godzina rozpoczęcia z przedziału ("7:00")
          do: S(),         // godzina zakończenia ("15:00")
          podpis: S(),     // "tak" gdy w trzeciej kolumnie jest podpis, inaczej ""
          zapisPodpis: S(),// co jeszcze stoi w kolumnie podpisu poza samym podpisem
          skreslone: S(),  // "tak" gdy CAŁY wiersz jest przekreślony, inaczej ""
          podpisSkreslony: S(), // "tak" gdy kreska idzie także przez podpis
          uwaga: S(),
        },
        required: ['d', 'zapis', 'zapis2', 'od', 'do', 'podpis', 'zapisPodpis', 'skreslone',
          'podpisSkreslony', 'uwaga'],
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
- POPRAWKI: jeżeli część wpisu jest przekreślona/zamazana i obok stoi wartość poprawiona,
  przepisz do "zapis" TYLKO wartość ostateczną (tę nieprzekreśloną), a w "uwaga" napisz,
  co było skreślone. Nie sklejaj skreślonej i poprawionej wartości w jeden ciąg.
- CAŁY WIERSZ PRZEKREŚLONY (kreska/kreski przez cały wpis, często też przez podpis) —
  wpisz "tak" w polu "skreslone" i mimo to przepisz treść do "zapis". Godzin nie usuwaj,
  od odliczenia jest kod. Osobno odpowiedz w polu "podpisSkreslony": "tak", jeżeli kreska
  idzie TAKŻE przez podpis, "" jeżeli podpis został nietknięty. To rozstrzyga, czy dzień
  odwołano, czy tylko poprawiono zapis — nie pisz tego w "uwaga", tylko w tym polu.
  To jest osobna rzecz niż poprawka: poprawka ma wartość zastępczą, skreślenie nie ma.
- DWIE ZMIANY W JEDNYM DNIU: jeżeli w wierszu są DWA osobne przedziały
  (np. "6:00-8:30" i "11:00-22:00"), pierwszy idzie do "zapis", drugi do "zapis2".
  Nie rób tego przy poprawkach — tam jest jedna zmiana i skreślona pomyłka.
- KOLUMNA PODPISU: jeżeli poza samym podpisem stoi tam coś jeszcze — liczba godzin
  ("9") albo przedział ("11 - 22") — przepisz to DOKŁADNIE do "zapisPodpis".
  Na części kart to jedyne miejsce, gdzie człowiek podał liczbę godzin. Samego podpisu
  (nazwiska, parafki) tam NIE przepisuj — od tego jest pole "podpis".
- Nieczytelna rubryka: "?" w polu "zapis" i krótkie wyjaśnienie w "uwaga".
- MAŁE ZERA U GÓRY to minuty "00", a nie cyfry przy godzinie: "7 00 - 15 00" znaczy 7:00-15:00, nie 700-1500.
- Wiersz SUMA na dole: jeżeli ktoś go wypełnił, przepisz wartość do pola "suma"; pusty -> "".
- Imię i nazwisko przepisz z nagłówka dokładnie tak, jak napisano (pismo odręczne).
  Jeśli nieczytelne, napisz tyle, ile widzisz, i dopisz "?" — nie zgaduj nazwisk.
- Miesiąc i rok przepisz z nagłówka.

Zwróć dokładnie jeden obiekt JSON zgodny ze schematem, bez komentarzy.`;


/* Wariant dla trybu PASKÓW. Ta sama treść zadania i ten sam schemat — różni się
 * wyłącznie opisem tego, co model dostaje na wejściu. Powód rozdzielenia:
 * prompt „cała strona, nagłówek, górna połowa, dolna połowa" opisywał obrazy,
 * których w tym trybie nie ma, a rozbieżność między opisem a wejściem to
 * najtańszy sposób na pogorszenie odczytu. */
const PROMPT_ZLECENIE_PASKI = PROMPT_ZLECENIE.replace(
  'Dostajesz zdjęcia jednej karty „EWIDENCJONOWANIE CZASU WYKONYWANIA UMOWY ZLECENIE"\n(cała strona, nagłówek, górna połowa tabeli, dolna połowa tabeli).',
  `Dostajesz zdjęcia jednej karty „EWIDENCJONOWANIE CZASU WYKONYWANIA UMOWY ZLECENIE":
najpierw NAGŁÓWEK karty, a potem TABELĘ pociętą na kolejne PASKI po kilka wierszy,
każdy w dużym powiększeniu. Paski idą po kolei od dnia 1 do wiersza SUMA i razem
pokrywają całą tabelę — żaden dzień nie jest pominięty i żaden nie powtarza się
dwa razy. W każdym pasku pierwsza kolumna to numer dnia: czytaj go i przypisuj
godziny do TEGO numeru, nie do pozycji paska.
Paski są przycięte z prawej strony — widać kolumnę „Dzień", całą kolumnę
„Liczba godzin" i POCZĄTEK kolumny podpisu, bo na części kart to właśnie tam
człowiek dopisuje liczbę godzin. Sam podpis (nazwisko) może być ucięty i to jest
w porządku — pole „podpis" wypełnij na podstawie tego, czy w wierszu widać
jakikolwiek ślad pisma w tej kolumnie.`);

module.exports = { SCHEMAT_ZLECENIE, PROMPT_ZLECENIE, PROMPT_ZLECENIE_PASKI };
