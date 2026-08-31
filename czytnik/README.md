# Czytnik — serwis odczytu kart ewidencji czasu pracy

Samodzielny serwis OCR (docelowo osobny serwis Railway, dziś także montowany
tymczasowo w core-api pod `/czytnik/*` na czas pomiarów). Odtwarza w API warunki,
w których czat czytał karty bezbłędnie, i dokłada to, czego czat nie miał:
deterministyczną walidację i pomiar na korpusie.

## Silnik (P0)

1. render 300 dpi (pdftoppm) + deskew (imagemagick),
2. 4 obrazy: cała strona (kontekst) + nagłówek + dwie połówki tabeli
   (cięcie TYLKO poziome, wiersze całe, prawa krawędź przycięta do kolumny Chor.;
   ~54 px na wiersz zamiast ~31 przy całej stronie), skalowanie lanczos po naszej
   stronie do budżetu API ~1,15 Mpx,
3. JEDNO wywołanie claude-opus-5: streaming, adaptive thinking (summarized),
   structured outputs (JSON schema), polityka **zapis / wniosek / pewność** —
   transkrypcji nie wolno poprawiać, wnioskowanie po nadmiarowości karty jest
   nakazane, ale tylko w osobnym kanale z obowiązkową uwagą,
4. równolegle drugi, ślepy odczyt nazwiska (sam nagłówek, bez listy w prompcie;
   dopasowanie do zamkniętej listy robi kod — dekorelacja),
5. walidacja w kodzie; **źródło godzin zależy od obiektu** (`zrodloGodzin`):
   - **stajnia** → wpisane RAZEM (tam ludzie odliczają przerwy), a czas między
     wejściem a wyjściem jest tylko SUFITEM,
   - **reszta** (hotel, kuchnia, bar) → **godziny wejścia/wyjścia są źródłem
     prawdy**, a rozjazd z kolumną RAZEM to błąd w sumowaniu → do raportu
     (`bledySumowania`); różnica ponad 2 h to raczej źle odczytana godzina niż
     pomyłka w dodawaniu, więc idzie jako pole sporne,
   - wpisane więcej niż wynika z obecności → zawsze alarm i karta do człowieka,
6. urlop i chorobowe: **godziny wpisane przy dniach są wiążące** (dzień
   nieobecności = długość zmiany danej osoby); sam ptaszek → dni × stawka;
   wyjątek: osoby z jawną stawką (3/4 etatu) liczone zawsze wg swojej stawki,
7. **grafik zmianowy 12/12** (`grafikZmianowy` w `korpus/pracownicy.json`):
   ptaszek stoi przy każdym dniu kalendarzowym nieobecności, a płatne są tylko
   dni, w których osoba miała zmianę — tego z karty nie widać, więc system
   **nie zgaduje, tylko wstrzymuje kartę i pyta, ile z tych dni to zmiany**,
8. **brakujący wpis** (jest godzina rozpoczęcia, nie ma zakończenia ani sumy)
   → pole sporne; taki dzień potrafi ukryć cały dzień pracy (Czuryłowicz 6/2026),
9. status `auto` tylko gdy nazwisko potwierdzone dwoma odczytami ORAZ sumę
   potwierdza ścieżka NIEZALEŻNA od głównego odczytu (ślepa transkrypcja kolumny
   RAZEM albo wiersz SUMA — wiersza SUMA może nie być, to nie blokuje karty)
   ORAZ zero spornych.

ZROBIONE: dogrywka P1 — każde sporne pole jest wycinane ×4 (z kolumną numeru
dnia jako kontrolą tożsamości wiersza) i czytane ponownie neutralnym promptem;
zoom to transkrypcja (wchodzi do obu kanałów), po czym karta przechodzi PEŁNĄ
walidację od nowa. Co zostanie sporne, wraca w `paczkaRewizyjna`
[{dzien, pole, odczyty, obraz base64}] — gotowe do maila z formularzem dla
człowieka. Aliasy imion (Przemek→Przemysław) i dopasowanie nazwisk per słowo.

Do zrobienia w kolejnych etapach: P2 (drugi pełny odczyt), mail z wycinkiem
+ formularz odpowiedzi dla człowieka (PATCH zatwierdzenia), baza Postgres
(pełny ślad, idempotencja per strona), snapshot-backup tabel Google Sheets.

## Ewaluacja bez kosztów — `npm run eval`

**Zasada: strojenie REGUŁ nie wymaga czytania kart modelem.** Dopracowanie reguł
(przerwy, stawki nieobecności, bramka auto) kosztowało ~$100, bo po każdej zmianie
przepuszczaliśmy te same karty przez model od nowa — 13 przebiegów, ~380 stron.
Zmieniała się przy tym wyłącznie walidacja.

Od teraz:

1. przebieg z `{"zapiszSurowe": true}` zwraca w każdej karcie pole `surowe`
   (odczyt główny + ślepy odczyt nazwiska + ślepa kolumna RAZEM + użyty okres),
2. zrzucamy je do `korpus/surowe/<okres>-<obiekt>-<strona>.json`,
3. `npm run eval` przepuszcza zapisane odczyty przez **aktualną** walidację
   i porównuje z `korpus/wzorce/<okres>.json` — **zero wywołań API**.
   Kod wyjścia 1, gdy jakakolwiek karta weszłaby jako `auto` z błędną liczbą.

Model wołamy dopiero wtedy, gdy zmieniamy sposób **czytania** (prompty, cięcie
obrazów, model). `node eval/z-wynikow.js <katalog>` odtwarza korpus ze starych
wyników — wiernie poza kartami, gdzie nieobecności oznaczono ptaszkiem
(w wyniku zapisują się jako null); takie karty eval oznacza jako
`niepełna rekonstrukcja` i nie liczy ich jako różnic.

## HTTP

- `GET  /czytnik/zdrowie`
- `POST /czytnik/odczytaj`  body: `{data: base64 pdf, strony?, rok?, miesiac?, nazwiska?, rownolegle?, model?, dpi?, async?}`
  - bez `async`: wynik w odpowiedzi (małe porcje stron),
  - z `async: true`: `202 {przebiegId}` → `GET /czytnik/przebieg/:id` (może liczyć się całą noc),
Każda odpowiedź niesie `tokeny: {we, wy}` i `kosztUSD` (realne zużycie przebiegu).
- `POST /karty-pracy/odczytaj` (tylko serwis samodzielny) — alias zgodny z kontraktem
  core-api: przełączenie n8n = zmiana samego URL-a.

Auth: nagłówek `x-token` = `CZYTNIK_TOKEN` (lub `PREPROCESS_TOKEN`).

## Uruchomienie na Railway (osobny serwis)

1. New Service → GitHub repo `jumanji747/core-api`,
2. Settings → **Root Directory: `czytnik`**, **Watch Paths: `czytnik/**`**,
3. Variables: `ANTHROPIC_API_KEY`, `CZYTNIK_TOKEN` (ten sam co PREPROCESS_TOKEN w core-api),
4. deploy zbuduje `czytnik/Dockerfile`; zdrowie: `GET /zdrowie`.

## CLI

```
node cli.js obrazy korpus/2026-06-stajnia.pdf 1 out/   # zrzut 4 obrazów, bez modelu
node cli.js odczyt korpus/2026-06-stajnia.pdf 1,2      # pełny odczyt (wymaga klucza)
```

## Korpus

`korpus/*.pdf` — prawdziwe teczki (czerwiec/lipiec 2026: stajnia, hotel, zlecenia),
125 stron. Wzorcowe wartości (ground truth) dojdą do `korpus/wzorce/` po
zatwierdzeniu przez człowieka; każda zmiana promptu/parametrów ma być mierzona
na korpusie, nie strojona na ślepo.
