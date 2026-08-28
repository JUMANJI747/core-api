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
5. walidacja w kodzie: od/do↔RAZEM, Σdni↔wiersz SUMA, kolumny 100%/UW/Chor.,
   norma z art. 130 KP, święta, zakresy; **C liczy wyłącznie kod**,
6. status `auto` tylko gdy nazwisko potwierdzone dwoma odczytami ORAZ C potwierdzają
   ≥2 niezależne ścieżki (zapisy dni / wiersz SUMA / czasy od/do) ORAZ zero spornych.

Do zrobienia w kolejnych etapach: drabina eskalacji (P1 zoom spornych pól,
P2 drugi pełny odczyt), mail z wycinkiem + formularz odpowiedzi dla człowieka
(PATCH zatwierdzenia), baza Postgres (pełny ślad, idempotencja per strona),
snapshot-backup tabel Google Sheets, eval-runner na korpusie.

## HTTP

- `GET  /czytnik/zdrowie`
- `POST /czytnik/odczytaj`  body: `{data: base64 pdf, strony?, rok?, miesiac?, nazwiska?, rownolegle?, model?, dpi?, async?}`
  - bez `async`: wynik w odpowiedzi (małe porcje stron),
  - z `async: true`: `202 {przebiegId}` → `GET /czytnik/przebieg/:id` (może liczyć się całą noc),
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
