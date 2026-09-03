# Czytnik — serwis odczytu kart ewidencji czasu pracy

Samodzielny serwis OCR (docelowo osobny serwis Railway, dziś także montowany
tymczasowo w core-api pod `/czytnik/*` na czas pomiarów). Odtwarza w API warunki,
w których czat czytał karty bezbłędnie, i dokłada to, czego czat nie miał:
deterministyczną walidację i pomiar na korpusie.

## Silnik (P0)

1. render 300 dpi (pdftoppm) + deskew (imagemagick) **w samym Czytniku** — NIE
   przez `/preprocess-scan` z core-api (tamten endpoint obsługuje raporty kasowe
   w n8n i skaluje wynik do 2000 px, co dla karty byłoby stratą; tu pełną
   rozdzielczość skalujemy sami do budżetu API). Po detekcji siatki działa
   **kontrola geometrii**: wysokość wiersza musi zgadzać się z proporcjami
   formularza (±20%), bo przekrzywiona o 1° strona daje siatkę, która wygląda
   na dobrą — stajnia 8/2026 str. 8 (Wójcik) miała 53,2 px zamiast 84 i `bladSiatki: null`.
   Odrzucona siatka → fallback na ułamki wysokości + ślad w metadanych,
2. 4 obrazy: cała strona (kontekst) + nagłówek + dwie połówki tabeli
   (cięcie TYLKO poziome, wiersze całe, prawa krawędź przycięta do kolumny Chor.;
   ~54 px na wiersz zamiast ~31 przy całej stronie), skalowanie lanczos po naszej
   stronie do budżetu API ~1,15 Mpx,
3. JEDNO wywołanie claude-opus-5: streaming, adaptive thinking (summarized),
   structured outputs (JSON schema), polityka **zapis / wniosek / pewność** —
   transkrypcji nie wolno poprawiać, wnioskowanie po nadmiarowości karty jest
   nakazane, ale tylko w osobnym kanale z obowiązkową uwagą,
4. równolegle drugi, ślepy odczyt nazwiska (sam nagłówek, bez listy w prompcie;
   dopasowanie do zamkniętej listy robi kod — dekorelacja) oraz **ślepa
   transkrypcja kolumn RAZEM, 100% i nocne** — `effort: high`, bo to brama dla
   statusu `auto`: w sierpniu 2026 rozjazd z tą ścieżką wstrzymał **9 z 16**
   kart, czyli słabszy czytelnik (`low`) kłócił się z mocniejszym i remis szedł
   na niekorzyść karty. Kolumny 100% i nocne doszły, bo **doliczają się do
   miesiąca, a nie miały żadnego niezależnego potwierdzenia** (Maląg 8/2026),
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
   wyjątek: osoby z jawną stawką (3/4 etatu) liczone zawsze wg swojej stawki.
   **Kody PZ (praca zdalna) i D (delegacja) to praca, nie nieobecność** — legenda
   na dole karty miesza jedno z drugim, a bez tego rozróżnienia dzień z kodem
   i godzinami dawał fałszywy problem „kod X i jednocześnie N h" (Biziewska
   8/2026: 19 sztuk na jednej karcie),
7. **grafik zmian** (`grafik` albo `grafikArkusze` w wywołaniu — arkusze Google
   działów: bar, kuchnia, recepcja, pokojowi, marketing) — **pomoc, nie źródło**.
   Źródłem prawdy jest karta; grafik odpowiada na trzy pytania, których z karty
   nie widać:
   - **które dni były zmianami** przy nieobecności osób na 12/12 (ptaszek stoi
     przy każdym dniu kalendarzowym, a płatne są tylko zmiany — Korgul 6/2026:
     6 ptaszków, grafik pokazuje 2 zmiany po 12 h),
   - **po ile godzin** liczyć te dni (grafik ma to wpisane wprost),
   - **których dni brakuje na karcie** — grafik ma zmianę, karta pusty wiersz
     (Korgul 6/2026 dzień 17: 12 h w grafiku, na karcie nic). Godzin **nie
     doliczamy** — zgłaszamy do sprawdzenia.
   Dzień oznaczony na karcie, którego grafik nie zna → pytanie, nie zgadywanie.
   Bez grafiku osoby z `grafikZmianowy` mają nieobecności wstrzymywane.
   Grafik podpisuje ludzi **samymi imionami**, więc dopasowanie idzie po zdrobnieniach,
   a tam gdzie imię jest niejednoznaczne — po jawnej mapie `imionaGrafiku`
   (`"Dział/Imię": "Imię Nazwisko"`, rozstrzygnięte porównaniem sum miesięcznych
   grafiku z arkuszem GODZINY dla dwóch miesięcy: Kuchnia/Marzenka = Oszczyk,
   Pokojowi/Marzena = Dąbrowska, Kuchnia/Natalia = Kuleta, Marketing/Natalia =
   Blank‑Kobryń). Bez mapy grafik rozpoznawał 13 osób, z mapą 16,
8. **praca w święto bez wpisu w kolumnie 100%** → pole sporne (nie ostrzeżenie).
   Tędy uciekł jedyny błędny `auto` sierpnia 2026: karta Maląg przeszła z 155,5 h,
   bo silnik zgubił 12,5 h wpisane w 100% przy 15 sierpnia (poprawnie 168 h) —
   niezależne potwierdzenie sprawdza **wyłącznie kolumnę RAZEM i wiersz SUMA**,
   więc zgubiona setka przechodziła bez śladu,
9. **brakujący wpis** (jest godzina rozpoczęcia, nie ma zakończenia ani sumy)
   → pole sporne; taki dzień potrafi ukryć cały dzień pracy (Czuryłowicz 6/2026),
10. status `auto` tylko gdy nazwisko potwierdzone dwoma odczytami ORAZ sumę
   potwierdza ścieżka NIEZALEŻNA od głównego odczytu (ślepa transkrypcja kolumny
   RAZEM albo wiersz SUMA — wiersza SUMA może nie być, to nie blokuje karty)
   ORAZ zero spornych.

ZROBIONE: dogrywka P1 — każde sporne pole jest wycinane ×4 (z kolumną numeru
dnia jako kontrolą tożsamości wiersza) i czytane ponownie neutralnym promptem;
zoom to transkrypcja (wchodzi do obu kanałów), po czym karta przechodzi PEŁNĄ
walidację od nowa. Co zostanie sporne, wraca w `paczkaRewizyjna`
[{dzien, pole, odczyty, obraz base64}] — gotowe do maila z formularzem dla
człowieka. Aliasy nazwisk (Przemek→Przemysław, ANDRICHUK z kart = Andriichuk
z arkusza — jedna osoba) i dopasowanie per słowo.

**Trzeci głos: Google Vision — ZMIERZONE I ODRZUCONE.** Hipoteza była taka, że
OCR znakowy myli się inaczej niż model, więc jego zgoda coś znaczy — a przede
wszystkim, że mechaniczny przepisywacz złapie wpisy, które model **przeoczył**
(jak zgubione 12,5 h w kolumnie 100% u Maląg). Pomiar na tych samych 27 kartach
sierpnia 2026 (`src/ocr-google.js` + `src/ocr-tabela.js`, trasa
`POST /czytnik/ocr-proba`, koszt 0 zł w darmowym progu):

| | wynik |
|---|---|
| pól dziennych porównanych | 437 |
| zgodnych z silnikiem | **297 = 68%** |
| pól, których OCR w ogóle nie odczytał | 113 = 26% |
| realnych rozjazdów | 27 = 6% |
| **wpisów przeoczonych przez model, a złapanych przez OCR** | **0** |

Rozjazdy to w większości artefakty pisma odręcznego: `8 → 88`, `8 → 888888`,
`8,5 → 815`, `12 → 1212`. W kolumnie 100% OCR odezwał się dwa razy i **oba razy
przekręcił wartość, którą silnik miał dobrze** (12 → „128", 9,5 → „915").
Setki u Maląg nie zobaczył w ogóle.

Wniosek: **na piśmie odręcznym Vision nie nadaje się ani na głosującego (68% to
za mało, blokowałby co trzecie pole), ani na wyłapywacza przeoczeń (0 trafień).**
Kod zostaje jako pomiarowy — mógłby się przydać na formularzach **drukowanych** —
ale nie jest i nie ma być wpięty w tor wypłat. Potwierdzeniem zostaje drugi
czytelnik innego dostawcy (98,9% zgodności, patrz niżej).

Przy okazji pomiar potwierdził kontrolę geometrii: przekrzywiona karta Wójcika
została odrzucona z „brak pewnej siatki" zamiast wyprodukować śmieci.

**Drugi czytelnik, innego dostawcy — WPIĘTY jako ścieżka dowodowa E**
(`src/silnik-openai.js`; trasa pomiarowa `POST /czytnik/drugi-odczyt` została).
Zmierzone na sierpniu 2026 (27 kart, **462 pola dzienne): 98,9% zgodności**
z odczytem głównym, a **wszystkie 5 rozjazdów** wypadło dokładnie na polach, które
i tak wymagały człowieka — w tym Wołoch dzień 9, gdzie drugi czytelnik trafił
(9,5), a główny się pomylił (8,5), co potwierdza suma wpisana na karcie.
Koszt: **0,175 USD za cały miesiąc** wobec 8,39 USD za przebieg, czyli 2%
rachunku za najmocniejsze potwierdzenie, jakie mamy. Błąd drugiego czytelnika
NIE przerywa odczytu — to świadek, nie warunek (`drugiOdczyt: false` wyłącza). Powtórka tym samym modelem dziedziczy te same
skłonności — przy niewyraźnym „10 czy 11" oba odczyty ciągną w tę samą stronę,
co widać po przebiegu kontrolnym (inna liczba na 2 z 27 kart). Inny dostawca
ma inny enkoder obrazu i inny trening, więc myli się gdzie indziej. Interfejs
jest identyczny z `silnik.zapytaj`: **ten sam prompt, ten sam JSON Schema, ta
sama walidacja** — zmienia się wyłącznie ten, kto patrzy na obrazek. Domyślnie
`gpt-5.6-luna` (0,20 USD/1M wejścia, 1,20 USD/1M wyjścia — ~25× taniej niż
odczyt główny); `CZYTNIK_MODEL_OPENAI` przełącza na mocniejszy bez zmiany kodu.
Wymaga `OPENAI_API_KEY`. Trasa POMIAROWA — najpierw liczby, potem głosowanie.

Do zrobienia w kolejnych etapach: P2 (drugi pełny odczyt), mail z wycinkiem
+ formularz odpowiedzi dla człowieka (PATCH zatwierdzenia), baza Postgres
(pełny ślad, idempotencja per strona), snapshot-backup tabel Google Sheets.

## Drugi formularz: umowy zlecenie

`POST /czytnik/zlecenia` (`async: true` jak przy kartach pracy) →
`src/zlecenia.js` + `src/prompty-zlecenie.js`. To **osobna ścieżka, nie flaga**,
bo to inny dokument:

| | karta pracy | umowa zlecenie |
|---|---|---|
| kolumny | 15 (RAZEM, 100%, nocne, UW, Chor. …) | 3: Dzień, Liczba godzin, Podpis |
| godziny dnia | liczba w rubryce RAZEM | **przedział** „7:00 – 15:00" — sumę liczy KOD |
| wiersz SUMA | zwykle wypełniony | pusty na **38 z 38** kart sierpnia 2026 |
| nazwiska | zamknięta lista pracowników | pismo odręczne, bez listy |
| urlop/chorobowe/100% | są | nie ma czego doliczać |

Odpadły przez to dwie z trzech ścieżek dowodowych karty pracy, więc
potwierdzeniem jest **drugi czytelnik innego dostawcy**: obaj czytają tę samą
kartę osobno, a kod porównuje dzień po dniu. Priorytet od użytkownika — „literówki
w nazwisku nie są straszne, najważniejsze żeby suma godzin się zgadzała" — więc
bramką `auto` jest **zgodność godzin**, a rozjazd w nazwisku to ostrzeżenie
z obiema wersjami w śladzie.

Geometria wycinków jest stała (tabela y 0,158–0,727, x 0,09–0,79; zmierzone na
wszystkich 38 kartach, rozrzut ±0,002) — `detectGrid` tu nie działa, bo kontrola
proporcji jest skrojona pod kartę pracy i słusznie odrzuciłaby ten formularz.

**Rubryka „Liczba godzin" ma trzy postacie naraz** (policzone na 593 wypełnionych
rubrykach sierpnia 2026, nie wymyślone): 173× sama liczba, ~200× sam przedział,
**211× przedział I wypisana liczba** („15.30 – 24.00 – 8,5h", „14:00-22:30 8h30min",
„11  11-22" — liczba bywa też PRZED przedziałem). Zasada jak przy stajni:
**wypisana przez człowieka liczba jest źródłem, przedział kontrolą**; gdy oba są
i się nie zgadzają, karta przeczy sama sobie i idzie do człowieka.

Sam wzorzec bywa nierozstrzygalny w oderwaniu: „7 00 - 15 00" to godzina 7:00,
ale „11 11-22" to jedenaście godzin i przedział 11–22. Dlatego rozbiór generuje
**warianty i wybiera ten, w którym wypisana liczba zgadza się z przedziałem** —
karta sama odpowiada, która interpretacja jest właściwa. Po tej poprawce suma
miesiąca wzrosła z 5442,66 do 5473 h i **zniknęły wszystkie dziwne ułamki**
(żaden dzień nie wypada poza pełny kwadrans).

### Czego nauczyła ślepa kontrola (38 kart, trzeci czytelnik, 8/2026)

Dwa silniki zgodne ze sobą to jeszcze nie prawda. Trzeci czytelnik przeczytał te
same 38 kart od zera, bez dostępu do naszych wyników: **25 kart co do godziny
identycznych, 13 rozjechanych — w tym 4 karty z etykietą `auto`**, czyli takie,
których nikt by już nie sprawdził. Rozjazdy nie były przypadkowe, złożyły się na
trzy wzorce, których formularz po prostu wymaga, a my ich nie znaliśmy:

| wzorzec | co się działo | przykład |
|---|---|---|
| **wiersz przekreślony** | model czytał cyfry i nie widział kreski; drugi czytelnik miał tę samą ślepotę, więc obaj zgodnie potwierdzali anulowany dzień | Szejerska d2: „11" przekreślone, bez podpisu → +11 h na karcie `auto` |
| **dwie zmiany w jednym dniu** | brany był jeden przedział, drugi przepadał | Fedorstova d10: „6-8³⁰" i „11-22" = 13,5 h, my mieliśmy 5 h; karta zaniżona o 21 h |
| **liczba godzin przy podpisie** | na części kart to JEDYNE miejsce, gdzie człowiek podaje wynik | Stępnowski d17: rubryka „11-19 kl. 11-20", przy podpisie jego „9" — my wpisaliśmy 20 h |

Stąd trzy nowe pola w schemacie: `skreslone`, `zapis2`, `zapisPodpis`. Kod
odlicza przekreślony wiersz (0 h), sumuje dwie zmiany i traktuje dopisek przy
podpisie jako źródło, gdy rubryka milczy — a jako kontrolę, gdy mówi swoje.
Przekreślenie **z nietkniętym podpisem** nie jest rozstrzygane automatem: wtedy
nie wiadomo, czy dzień odwołano, czy poprawiono zapis, i karta idzie do człowieka.
Prompt dostał też regułę na poprawki: przepisujemy **wartość ostateczną**, a nie
skreśloną i poprawioną sklejone w jeden ciąg.

Wniosek na przyszłość, wart więcej niż same łatki: **zgodność dwóch czytelników
wyłapuje błędy odczytu, ale nie wyłapuje wspólnej ślepoty na to, czego prompt nie
opisał.** Ślepa kontrola na losowej próbce kart jest tania i jest jedynym testem,
który to widzi.

Odpowiedź niesie gotową tabelę dla kadr: `osoby: [{imieNazwisko, godziny, status,
strony, naWieluKartach}]` obok pełnego śladu per strona.

## Puste karty do wydruku

Druga strona Czytnika: zanim karty przeczytamy, trzeba je rozdać. Dotąd Ala co
miesiąc otwierała wzór w Excelu, wpisywała ręcznie miesiąc, nazwisko i wymiar
godzin i drukowała — osobno dla każdego pracownika. Teraz robi to jedno
wywołanie: **jedna karta = jedna strona A4, jeden PDF na miesiąc**, cała lista
umów o pracę na 3 miesiące do przodu (3 pliki po 29 stron). Tak karty idą do
obiegu — teczka na miesiąc, drukowana i rozdawana naraz; `podziel: "nie"` skleja
wszystko w jeden plik.

Wypełniamy dokładnie te pola, które i tak były wpisywane ręcznie:

| pole wzoru | co wchodzi |
|---|---|
| `C2` Miesiąc/rok | np. „WRZESIEŃ 2026" |
| `J2` Ilość godzin do przepracowania | wymiar z art. 130 KP (`kalendarz.js`) |
| `G3` Nazwisko i imię | z listy `dane/pracownicy.json`, WIELKIMI LITERAMI |
| `C3` Nr ewd. | tylko gdy podany w wywołaniu |
| `M2` Dział | **domyślnie pusty** — patrz niżej |

Zapis odtwarza to, co stoi na kartach krążących dziś po firmie (sprawdzone na
skanach czerwca i lipca): miesiąc i nazwisko wielkimi literami, wymiar godzin
w ramce, rubryka **Dział pusta na każdej karcie** — dlatego działów nie
wpisujemy, choć mapa `dzialy` czeka w `pracownicy.json` na `zDzialem: true`
(podane wprost pary `dzialy: {osoba: dział}` działają zawsze).
Jedyne odstępstwo: **dopisujemy rok** („WRZESIEŃ 2026" zamiast „CZERWIEC"), bo
bez roku odczyt musi go zgadywać z daty przetwarzania i na przełomie roku trafia
w grudzień poprzedniego.

Reszta zostaje pusta — wypełnia pracownik i przełożony. Dni, których w miesiącu
nie ma (30-dniowy wrzesień, luty), mają pusty numer i szary wiersz, żeby nikt
tam nic nie wpisał. Szare tła pól nagłówka są ze wzoru — pokazują, gdzie coś ma
stanąć.

**Wzór nie jest przepisany z palca.** `assets/karta-wzor.json` powstał z
oryginalnego pliku kadrowego (`Karta_ewid.cz._pr.obowiązuje_OK.xls`, arkusz
„Wzór") przez `narzedzia/wzor-do-json.py` — szerokości kolumn, wysokości wierszy,
scalenia, teksty, czcionki i ramki co do komórki. `src/karta-druk.js` jest małym
silnikiem druku arkusza: liczy geometrię, rysuje krawędzie (grubsza wygrywa,
wnętrza scaleń bez kresek) i składa teksty z wyrównaniem Excela — z przelewaniem
na puste komórki i ucinaniem przed zajętymi. Gdy Ala zmieni wzór, powtarzamy
ekstrakcję i kod zostaje bez zmian. Czcionka (Liberation Sans, metrycznie zgodna
z Arialem ze wzoru) leży w `assets/fonty/` — obraz Dockera nie ma żadnych
czcionek, a PDF bez osadzonego kroju nie zapisze polskich znaków.

Drogę wydruku pilnuje `npm test` (wbudowany `node:test`, bez zależności i bez
wywołań API) — testy idą **przez router**, tak jak n8n, bo pierwsza wersja
przepuściła błąd, którego nie było widać z CLI: router wysyła `dzialy: {}`,
a pusty obiekt jest w JS prawdziwy, więc domyślne działy trafiały na papier
mimo `zDzialem: false`.

## Ewaluacja bez kosztów — `npm run eval`

**Zasada: strojenie REGUŁ nie wymaga czytania kart modelem.** Dopracowanie reguł
(przerwy, stawki nieobecności, bramka auto) kosztowało ~$100, bo po każdej zmianie
przepuszczaliśmy te same karty przez model od nowa — 13 przebiegów, ~380 stron.
Zmieniała się przy tym wyłącznie walidacja.

Od teraz:

1. przebieg z `{"zapiszSurowe": true}` zwraca w każdej karcie pole `surowe`
   (odczyt główny + ślepy odczyt nazwiska + ślepa kolumna RAZEM + użyty okres),
2. zrzucamy je do `korpus/surowe/<okres>-<obiekt>-<strona>.json` — zapisywany
   jest odczyt **po dogrywce zoomem** (ten, z którego naprawdę policzono wynik);
   przed poprawką szedł tam odczyt sprzed zoomu i ewaluacja offline pokazywała
   więcej pól spornych niż produkcja (stajnia 8/2026: Stącel 2 na produkcji, 6
   w ewaluacji), przez co porównania „przed/po zmianie reguły" myliły,
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
- `GET  /czytnik/norma?rok=2026&miesiac=8` — wymiar czasu pracy z art. 130 KP.
  **Nie pobieramy tego z sieci**: wyliczenie zgadza się z 42 z 43 zakładek arkusza
  GODZINY (jedyny wyjątek to Grudzień 2025, gdzie arkusz ma 160, a z Kodeksu
  wychodzi 168 — błąd w arkuszu).
- `POST /czytnik/nowa-zakladka` body: `{poprzedniaSiatka, wyniki, rok, miesiac, wymuszaj?}`
  — buduje siatkę nowej zakładki miesiąca: przenosi **TOTAL → POPRZEDNI OKRES**
  i **NOCNE TOTAL → NOCNE POPRZEDNI**, wstawia normę do A1/I1 i formuły
  (`D = C − $I$1`, `E = B + D`, `H = F + G − I`). Zakłada ją **tylko gdy zamykany
  miesiąc jest kompletny** — brak choćby jednej karty blokuje, żeby saldo nie
  przeszło niepełne. Odtworzenie lipca z czerwca zgadza się z prawdziwą zakładką
  w 26 z 27 wierszy (dwie różnice to ręczne korekty w arkuszu).
- `POST /czytnik/karty-do-druku` body: `{od?: "2026-09", miesiecy?: 3, osoby?: [...],
  podziel?: "miesiac"|"nie", zDzialem?: false, dzialy?: {osoba: dział},
  nrEwid?: {osoba: nr}, kolejnosc?: "osoba"|"miesiac"}`
  → `{stron, okresy, karty, pliki: [{nazwa, mime, okres, stron, data (base64 PDF)}]}`
  (przy jednym pliku dodatkowo `plik`). Bez `od` bierze **następny miesiąc** po
  dzisiejszym, bez `osoby` — całą listę umów o pracę. `kolejnosc` układa strony
  wewnątrz pliku.
- `GET /czytnik/karty-do-druku.zip?od=2026-09&miesiecy=3` — komplet do
  przeglądarki: archiwum z jednym PDF-em na miesiąc (token w nagłówku albo `?token=`).
- `GET /czytnik/karty-do-druku.pdf?od=2026-09&miesiecy=1&osoby=Jan%20Kowalski;...`
  — pojedynczy plik prosto na drukarkę (przy `miesiecy>1` sklei miesiące w jeden PDF).
- `GET /czytnik/pracownicy` — lista i działy używane, gdy nie podamy `osoby`.
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
node cli.js karty karty-IX-XI.pdf 2026-09 3            # puste karty do wydruku (bez klucza)
```

## Korpus

`korpus/*.pdf` — prawdziwe teczki (czerwiec/lipiec 2026: stajnia, hotel, zlecenia),
125 stron. Wzorcowe wartości (ground truth) dojdą do `korpus/wzorce/` po
zatwierdzeniu przez człowieka; każda zmiana promptu/parametrów ma być mierzona
na korpusie, nie strojona na ślepo.
