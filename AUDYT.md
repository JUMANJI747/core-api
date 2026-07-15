# AUDYT KODU — core-api (backend)

Pełny audyt wykonany na Fable 5 (11 agentów, każdy plik czytany w całości).
Legenda statusu: ✅ zrobione · ⬜ SAFE do zrobienia · ⚠️ RISKY (wymaga decyzji/testów).
Legenda wagi: 🔴 HIGH · 🟠 MED · 🟡 LOW.

> Mapa frontu: `../core-crm-frontend/AUDYT.md`. Aktualizuj statusy po każdej poprawce.

---

## glob-quote.js / glob-orders.js / glob-sync.js / glob-client.js (kurier)
- ✅🔴 glob-quote /glob/order: `contractor` niezadeklarowana (jest `contractorForReceiver`) → ReferenceError PO utworzeniu paczki gdy receiver bez contractorId → retry = DUPLIKAT listu. **NAPRAWIONE** (3× rename).
- ⬜🔴 glob-quote ~1443: retry terminu odbioru czyta `list[0].from/.to`, GK zwraca `timeFrom/timeTo` → zawsze "brak terminów odbioru w 7 dni". Użyć `extractPickupSlots`.
- ⬜🔴 glob-quote/glob-sync ~2181/171: async handlery bez try/catch (Express 4) → błąd Anthropic/Prisma = crash procesu. Owinąć `asyncHandler`.
- ⬜🟠 glob-quote ~1756: `getOrders({search})` — getOrders nie zna `search`, fallback `||items[0]` → cudzy tracking do maila. Usunąć fallback / dodać filtr.
- ⚠️🟠 glob-quote 17-19: dedup zamówień tylko in-memory → multi-instance = duplikat listu. Lock w DB (jak confirm-lock).
- ⚠️🟠 glob-quote 980-1038: nieznany/przeterminowany quoteId po cichu → NAJNOWSZA wycena → kurier na złego odbiorcę. Przy jawnym quoteId zwracać błąd.
- ⚠️🟠 glob-sync 105-117: match odbiorcy po `contains` pierwszego słowa → dane GK u złego kontrahenta. Użyć `findBestContractors`.
- ⬜🟠 glob-sync 88-127: `findMany` całej tabeli kontrahentów w pętli po odbiorcach (N+1). Pobrać raz.
- ⬜🟠 glob-client 104: `getOrderLabels` bez timeoutu (GK wisi 40s+). Dodać timeout.
- ⬜🟡 glob-quote 871: `quoteId=Date.now()` — kolizja równoległych wycen. Dodać losowy sufiks.
- ⬜🟡 glob-quote 244: preset×qty capuje wysokość do 60 bez korekty → zaniżona wycena. Pakować siatką.
- ⬜🟡 glob-quote 1315: martwy ternary `receiverHouse||('1':'1')`; placeholder "1". Wyczyścić.
- ⬜🟡 glob-quote 1570: martwa gałąź `quoteParams.items` (nigdy nie zapisywane) → itemsSummary zawsze null.
- ⬜🟡 glob-orders: zdublowany multipart Telegram, resolucja numer→hash (limity 50 vs 100), inline extract wyników. Wspólne helpery.
- ⬜🟡 glob-orders 223: `/glob/tracking/:hash` wymaga numeru nie hasha → puste bez błędu.

## invoices.js
- ✅🔴 /ifirma/invoice-confirm 1183: parsował `ifirmaResp.response.Wynik` (nie istnieje) → FV z Telegrama zapisywana jako 'UNKNOWN' + PDF 500. **NAPRAWIONE**.
- ✅ 132-138: cena brutto zapisywana jako netto → NAPRAWIONE (pkt 24: trueUnitNetto + fix-brutto-as-netto backfill endpoint).
- ⬜🟠 556: auto-persist kraju zapisuje domyślne 'PL' (nie tylko wykryte) → UE bez adresu dostaje 'PL' na stałe → 23% zamiast WDT. Warunek `if (derived.country && ...)`.
- ⬜🟠 941/1087/1274: `releaseConfirm` gdy request nie zajął klucza → może skasować cudzy lock → duplikat FV. Flaga `claimed`.
- ⚠️🟠 924→986: błąd DB PO createInvoice → release locka mimo że FV powstała → duplikat przy retry. W catchu completeConfirm gdy ifirmaResult istnieje.
- ⬜🟠 675/2776: `resolvePrice`/last-price ignoruje `lastPriceTyp`(netto) i `lastPriceCurrency` → zła cena/waluta. Honorować typ+walutę.
- ⚠️🟠 1890-1941 /payments/match: `paid` w DB przed iFirmą, minScore 40 (prefiks 4 znaki), sprawdza tylko HTTP 200. Podnieść próg, weryfikować Kod, update po iFirmie.
- ⬜🟠 814-1279: ~200 linii duplikatu confirm vs confirm-latest (źródło buga UNKNOWN). Wspólny `issueFromPreview`.
- ⬜🟠 1717: /extract-prices — sekwencyjnie po wszystkich kontrahentach ×2 wywołania iFirma, bez limitu. Paginacja+okno dat.
- ⬜🟡 1059: confirm-latest — błąd fetchInvoicePdf → 500 mimo wystawienia. Objąć try/catch, zwracać ok.
- ⬜🟡 631: pozycje z szablonu z `itemCena:null` → override ceny ignorowany dla komponentów.
- ⬜🟡 2294: `autoPairInBackground` na każdym GET /invoices — throttle 60s.
- ⬜🟡 13/193: martwe importy (computeSyncWindow, EU_VAT_PREFIXES, ...).
- ⬜🟡 102: `addGkOrderToCache` bez `hash`/`receiver` → link-shipment nie zapisze adresu świeżej paczki.

## emails.js
- ⬜🔴 812-897: ścieżka draft (DOMYŚLNA) nie zapisuje EmailAttachment ani bodyHtml → confirm wysyła mail BEZ załączników i HTML. Zapisywać jak draft-with-invoice.
- ⬜🔴 890: `bodyFull.slice(0,2000)` → confirm wysyła treść uciętą do 2000 znaków. Usunąć slice.
- ⚠️🔴 60-71: dedup ignoruje treść (param `body` martwy) + oznacza niewysłany draft jako OUTBOUND → mail nie wychodzi, w CRM "wysłany". Hash body + nie przestawiać na OUTBOUND.
- ⬜🔴 283-328: reply-lookup w GET /emails ładuje wszystkie OUTBOUND/DRAFT z 3 lat, O(n²). Filtr IN + take + indeks.
- ✅🟠 2362: catch `res.json(result)` — `result` z try (ReferenceError). **NAPRAWIONE** (`{error}`).
- ⬜🟠 388-439/107-167/959/719/1350: async handlery bez asyncHandler → wiszące requesty. Owinąć.
- ⬜🟠 1352: /leads/analyze `daysBack` bez walidacji + findMany bez take. Clamp+take.
- ⚠️🟠 1993-2004: preview trackingu ≠ faktyczna wysyłka (brak sortowania/locka numeru). Wspólna logika z send.
- ⬜🟠 2000: fałszywe `alreadySent` gdy brak numeru (`contains:''`). Pomijać gdy brak trackingu.
- ⚠️🟠 1730: match kontrahenta po pierwszym słowie → tracking do złego klienta. `scoreContractor`+próg.
- ⚠️🟠 93: `email.create({data:req.body})` — mass-assignment. Whitelist pól.
- ⬜🟠 1569: `/imap-diag` `rejectUnauthorized:false`. Usunąć/env.
- ⬜🟠 2253-2319: N+1 cleanup-empty-dupes + pełne tabele Contractor bez take. groupBy/deleteMany.
- ⬜🟡 807: `replyTo` destrukturyzowane, nieużyte → nagłówek ginie.
- ⬜🟡 1063: `smtpConfirmed` zawsze true (fallback messageId) → gałąź FAILED martwa, Telegram myli.

## inbox-poller.js
- ✅🔴 1328: parseWebOrder na bodyFull(2000) → długie zamówienia gubiły pozycje/Total/adres. **NAPRAWIONE** (mail.bodyText).
- ✅🟠 634: parseEuroAmount separator tysięcy ("1.234,56"→1.234). **NAPRAWIONE**.
- ✅🟠 597: gałąź invalid bez `status:'invalid'` → Telegram "nie zweryfikowano" zamiast "NIEWAŻNY". **NAPRAWIONE**.
- ✅🔴 1683: brak guardu re-entrancy w pollAll → nakładające się cykle. **NAPRAWIONE** (flaga pollInFlight).
- ⚠️🔴 1660/1720: godzinny rescan omija filtr newslettera+AI → odfiltrowany spam wraca do CRM. Wywołać filtry w rescanie.
- ⚠️🔴 487-516: prompt injection z treści maila → summary_pl wklejane nad `[ctx:]` do agenta z akcjami. Wycinać `[ctx:`/`[MAIL]` z summary.
- ⬜🟠 986/1055/1426: `maxUid` podbijany PRZED sukcesem → błąd AI = mail bez klasyfikacji/notyfikacji. Nie podbijać przy błędzie.
- ⬜🟠 430-477: httpsGet/Post bez timeoutu → wiszący poller. + martwy import fetchWithTimeout. Dodać timeout.
- ⚠️🟠 221: `rejectUnauthorized:false` IMAP → MITM haseł skrzynek. Usunąć/CA pinning.
- ⬜🟠 1529-1541: bootstrap SENT ściąga pełne treści całego folderu by policzyć maxUID. Użyć uidnext.
- ⚠️🟠 232-246: UIDVALIDITY ignorowane → po reorganizacji skrzynki główna ścieżka nie pobiera nic. Zapisywać+resetować.
- ⬜🟠 1730: rescan bez dedupu dla maili bez Message-ID → wielokrotne wstawianie. Fallback dedup.
- ⬜🟡 708: VIES nigdy dla CIF (regex). ⬜🟡 731/756: dedup po surowym nipRaw (duplikaty). ⚠️🟡 1084: pozycyjne tags[1]/[2] psują się bez country.

## contractors.js
- ⬜🔴 970-971: `orderBy:[{type:'asc'}]` przy "shipping>billing" → alfabetycznie billing pierwszy → auto-fill wysyłki bierze adres FAKTUROWY. `desc`/ranking.
- ⬜🔴 2003-2019: /backfill-location-last-used — pobieranie orderów GK w pętli po kontrahentach → do 300k wywołań. Wyciągnąć przed pętlę.
- ⬜🔴 889-892: GET /?search — `findMany take:2000` pełnych wierszy przy każdym wyszukiwaniu. Filtr JSONPath / select.
- ⬜🔴 969-1051: N+1 enrichWithShippingAddress (findFirst per wiersz). Jeden findMany + mapa.
- ⬜🟠 geocode.js:20: `c.postalCode` — model ma `postCode` → kod PL nigdy do Nominatim. Poprawić pole+selecty.
- ⬜🟠 22-28: scheduleGeocode nie re-geokoduje po zmianie adresu (blokada lat/lng). Porównać pola, czyścić.
- ⚠️🟠 1478-1515: /structured-address — częściowy billing nadpisuje istniejące pola nullem. Tylko nie-null do flatData.
- ⬜🟠 859-1119: GET / i GET /:id bez try/catch (Express 4). Owinąć.
- ⬜🟠 456-499: /import-addresses-ifirma non-force nadpisuje billingAddress. Pomijać istniejące.
- ⬜🟠 1035: fuzzy fallback `take:500` bez orderBy. Użyć findBestContractors.
- ⚠️🟠 263-288: upsert nadpisuje flat `nip` innym → P2002 (nip @unique) → 500. Sprawdzać kolizję.
- ⬜🟠 1719: resolveContractorFromRequest — pełny skan tabeli. findBestContractors.
- ⬜🟡 12: podwójny require geocode. ⬜🟡 711: verify-nip `nip.trim()` bez String(). ⚠️🟡 788: /vat-mode match po `contains` NIP → zły kontrahent (23% zamiast WDT 0%).

## contasimple.js (Kanary/ES)
- ⬜🔴 helpers 22-58: martwy fast-path (select bez contasimpleId) → każde wyszukiwanie klienta ES ciągnie pełną listę z wolnego API CS. Dodać do select.
- ⬜🔴 3237: /local-invoices owner=nikodem OR-uje z search → search ignorowany. `where.AND`.
- ⬜🟠 616-634: /contractors owner=nikodem `NOT` wyklucza owner=null → kontrahenci bez ownera znikają. Jawne OR.
- ⬜🟠 1210: anti-duplikat po invoiceDate nie createdAt → FV z datą przyszłą blokuje preview. Po createdAt.
- ⬜🟠 3020: race confirmAlbaran (upsert bez await, natychmiast findUnique) → albaranNumber null. Await.
- ⚠️🟠 3059: albaran po `includes(number)` → "1" trafia w "AL-...0014"; /albaran-delete kasuje zły. matchNumber ogon.
- ⚠️🟠 1627-1708: /delete-preview bez filtra → kasowanie całego kwartału po jednym "tak". Wymagać kontrahent/numer/daty.
- ⚠️🟠 1907-1929: /delete-confirm bez idempotencji → równoległe tapnięcia. confirm-lock.
- ⬜🟠 2950: fallback duplicate confirmAlbaran zwraca numer cudzego WZ. Sprawdzać previewId.
- ⬜🟡 1938: resolve po id bez period tylko bieżący kwartał. ⬜🟡 seed-boxes niekompletny skład ciche `continue`. ⬜🟡 2060 3× lookup klienta w jednym handlerze. ⚠️🟡 2338 ładowanie całej tabeli Email.

## Pozostałe route'y
- ⬜🔴 config.js: async handlery bez asyncHandler (audit, events, memory, mailing, products) → crash procesu. **(GET /config secrets już ✅)**.
- ✅🔴 config.js GET /config zwracał sekrety. **NAPRAWIONE** (filtr).
- ⬜🔴 cron.js 41-52: advisory-lock na puli połączeń → sync iFirma/CS może zablokować się na stałe. $transaction / xact_lock.
- ⚠️🟠 admin.js 638: stary /merge-contractors bez confirm, gubi kontakty/adresy (cascade), dangling InvoiceLineItem. Usunąć.
- ⬜🟠 transactions.js 578: rematch `amount=null` paruje komis z dowolną FV. Pomijać manual/commission.
- ⬜🟠 admin.js 957: contractor-cleanup krok 4 bezwarunkowy fuzzy-link po słowie ≥4 znaki. Flaga.
- ⬜🟠 costs.js 150: findDuplicate ładuje całą tabelę przy każdym POST. Filtr SQL.
- ⬜🟠 jpk.js 710: delete-invoices kasuje lokalnie mimo błędu iFirma → rozjazd. Pomijać przy błędzie.
- ⚠️🟠 config.js 299: /confirm-latest globalny (bez chatId/scope) → race PL/Kanary multi-user. Filtr scope.
- ⬜🟡 admin.js 28 /query przepuszcza SELECT INTO/pg_sleep. ⬜🟡 map.js bez auth + API_KEY w query. ⬜🟡 parse-document SSRF. ⚠️🟡 jpk seed-sofarma nadpisuje. ⬜🟡 transactions 869 timestamps. ⬜🟡 jpk-package martwe importy.

## Serwisy + klienty
- ⬜🔴 communication-agent-es.js 271: CONFIRM_INTENT "wyślij" bez `$` → każde "wyślij X" wysyła stary draft. Regex jak PL.
- ⚠️🔴 sudo-agent/operations-agent: prompt injection z treści maili → mutate_db/call_endpoint (confirm ustawia model). Confirm out-of-band, allowlista.
- ✅🔴 ifirma-sync.js 149-179: FAZA 2.5 kasowała lokalne FV przy niepełnej odpowiedzi iFirmy. **NAPRAWIONE** (guard: pomiń gdy iFirma=0 a lokalne są, lub gdy skasowałoby >50% z ≥5).
- ⬜🟠 ifirma-sync 184: N+1 email.updateMany per kontrahent (full scan). Batch/świeże.
- ⬜🟠 auto-pair-shipments 33: `used` bez okna → pełny skan Invoice na każdym GET. Okno lookback.
- ⬜🟠 contractor-match 62: pusty/krótki search → `nip.includes('')`=true → score 50 losowy. Wymagać len≥5.
- ⬜🟠 wdt-pairing 116: verifyPass fail → fallback auto-ok wszystkich → zła para (kraj). Odrzucać przy błędzie.
- ⬜🟠 transaction-tracker 127: resolveContractorFromShipment pełny skan tabeli. findBestContractors.
- ⬜🟠 confirm-lock 30: completeConfirm update `.catch(()=>{})` gdy klucz skasowany → numer nie zapisany → duplikat. Upsert.
- ⬜🟠 tracking-notify 117: dopasowanie odbiorcy `slice(0,5)` → fałszywe pozytywy. Dłuższy próg/tokeny.
- ⬜🟡 auto-pair 74 addrKey samo miasto. ⬜🟡 logistics-agent 394 quotedThisTurn.

---

## Zrobione w tej sesji (wdrożone na main)
SAFE:
1. ✅ kurier: ReferenceError `contractor` w /glob/order (duplikaty listów).
2. ✅ FV z Telegrama nie zapisuje 'UNKNOWN' (parsowanie odpowiedzi iFirmy).
3. ✅ GET /config nie wycieka sekretów (tokeny Telegram, Web Push).
4. ✅ poller: pełna treść zamówień, kwoty EU z tysiącami, status invalid, catch sent-rescan.

RISKY (za zgodą usera):
5. ✅ AUTH: proxy + middleware weryfikują seal sesji (koniec „zmyślone cookie = dostęp"). [frontend]
6. ✅ ifirma-sync: guard anty-masowe-kasowanie FV.
7. ✅ poller: guard re-entrancy (koniec nakładających się cykli).
8. ✅ maile draft→wyślij: zachowuje załączniki + HTML + pełną treść (był mail bez PDF, ucięty).
9. ✅ communication-agent-es: regex „wyślij" kotwiczony (nie wysyła starego draftu).
10. ✅ geocode: `postCode` zamiast `postalCode` + selecty (poprawne piny na mapie).

## Zrobione — sesja 2 (Fable, wdrożone na main)
11. ✅ Kanary: filtr owner=nikodem (null-included) + AND z search — /contractors i /local-invoices.
12. ✅ contractors enrich: orderBy type 'desc' (shipping>billing) — auto-fill wysyłki brał billing.
13. ✅ contasimple-helpers fast-path: select +contasimpleId (przestaje ciągnąć pełną listę CS).
14. ✅ kurier: terminy odbioru (extractPickupSlots + timeFrom/timeTo), tracking tylko exact, quoteId bez kolizji, getOrderLabels timeout.
15. ✅ index.js: globalny guard unhandledRejection/uncaughtException (koniec crashy z async-handlerów).
16. ✅ emails: dedup po bodyFull (koniec „wysłany" bez wysyłki).
17. ✅ poller: anty-injection — czyszczenie [ctx:]/[MAIL]/[ALERT] z summary_pl.
18. ✅ invoices: utrwalanie tylko WYKRYTEGO kraju (nie 'PL' na siłę → WDT działa).
19. ✅ verify-nip String(nip); jeden require geocode.
20. ✅ Kanary: /delete-preview guard (koniec kasowania kwartału), confirmAlbaran await.
21. ✅ transactions rematch wymaga zgodnej kwoty (komis nie łapie cudzej FV).

22. ✅ confirm-lock: claimed + ifirmaCreated — koniec okien na duplikat FV.
23. ✅ /payments/match: iFirma-first + Kod + próg 70 — koniec fałszywego 'paid'.

24. ✅ cena brutto zapisywana jako netto — FIX forward (`trueUnitNetto`:
    krajowa brutto/1.23, WDT bez zmian, jawne netto nietknięte) w confirm
    (extras.pozycje/items, InvoiceLineItem, tracker) + `inferVatRatePl` liczy
    VAT z Invoice.type (WDT-PLN=0%, krajowa-EUR=23%), nie z waluty.
    Backfill istniejących: **POST /invoices/fix-brutto-as-netto** (dryRun
    domyślnie, {"confirm":true} naprawia) — detekcja po Σ totalGross ≈
    gross×1.23. WYKONANO 2026-07-13: naprawiono 13 FV / 100 pozycji
    (52,54,56,63,83,96,99,100,146,157,164,166,168/2026).

POZOSTAJE (wymaga DECYZJI/backfillu lub większego refaktoru):
25. ✅ poller rescan wpuszczał odfiltrowany spam — decyzje pominięcia trwałe
    w modelu `EmailSkip` (newsletter/AI-SPAM/AUTO_REPLY zapisują messageId);
    rescan stosuje newsletterFilter + sprawdza EmailSkip przed dodaniem.

26. ✅ UIDVALIDITY — poller zapisuje uidValidity w ImapState; przy zmianie
    (reset skrzynki u dostawcy) resetuje lastUid do nowej numeracji
    (uidNext-1) i nadrabia treść rescanem SINCE 3 dni (dedup+EmailSkip).

27. ✅ glob-sync: match odbiorcy po 1. słowie ZASTĄPIONY scorerem
    (findBestContractors, minScore 75) — koniec nadpisywania
    globKurierReceiverData złemu kontrahentowi. Stary /merge-contractors
    przepięty na wspólny services/contractor-merge (kontakty/adresy/FK/audit),
    stara słabsza kopia logiki usunięta.

28. ✅ perf: contractors GET/search — enrich adresów JEDNYM zapytaniem
    (prefetchBestAddresses) zamiast findFirst per wiersz (N+1). Scan
    take:2000 pod contact-match zostaje (tylko przy search, select wąski).

- ⬜ perf: backfill-location do 300k wywołań GK; duplikat confirm/
  confirm-latest → wspólny issueFromPreview.
- ⬜ drobne: async-handlery bez asyncHandler (guard globalny już łapie crash),
  martwe importy/gałęzie, timeouty httpsGet w pollerze.
