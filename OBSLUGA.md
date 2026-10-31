# OBSŁUGA CRM — przewodnik dla każdej sesji Claude

Gotowe wywołania API do codziennych zadań: faktura, kurier, magazyn, mail, raporty, baza.
**Najpierw tutaj — kod czytaj dopiero, gdy coś nie działa.** Gdzie co leży w kodzie: `MAPA.md`.

## 0. Zasady

- **Dostęp:** backend `https://exquisite-perception-production.up.railway.app`, nagłówek `x-api-key: $CORE_API_KEY` (zmienna środowiska sesji). Brak zmiennej albo 401 → poproś właściciela, żeby dodał `CORE_API_KEY` w ustawieniach środowiska (menu środowiska w pasku sesji → Edit) i otworzył nową sesję. **Nigdy nie proś o wklejenie klucza w czat.**
- Dodawaj nagłówek `x-crm-user: claude` — zostaje ślad, kto złożył zamówienie / wysłał maila.
- **Sekretów nie wypisuj** (czat, logi, commity, pliki w repo). Wartości sekretów do Config tylko przez `params` w `/api/admin/mutate` — params nie trafiają do logu.
- **Akcje na zewnątrz tylko na wyraźne polecenie:** faktura (iFirma + KSeF), kurier (płatny), mail do klienta lub magazynu. Przed wysłaniem maila pokaż treść i poczekaj na „wyślij". Nie rób „testowych" faktur ani kurierów na produkcji — są tryby próbne (`proba`, `podglad`, przegląd strażnika bez `alerty`).
- **Czas w bazie:** kolumny DateTime to UTC bez strefy. Czas polski: `(kol AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Warsaw'` — samo `AT TIME ZONE 'Europe/Warsaw'` przesuwa w złą stronę.
- Właściciel pracuje na iPhonie: odpowiadaj po polsku, krótko, z blokami do skopiowania; zwracając się do właściciela, unikaj form rodzajowych w czasie przeszłym.

## 1. Baza danych

- **Odczyt:** `POST /api/admin/query {"sql": "...", "params": [...]}` — tylko `SELECT`/`WITH`, max 500 wierszy. Słowa INSERT/UPDATE/DELETE/CREATE/DROP… blokują zapytanie nawet w tekście. Liczniki: `count(*)::int` (BigInt nie przejdzie przez JSON). Tabele w cudzysłowach: `"Invoice"`, `"Email"`, `"Contractor"`, `"WarehouseOrder"`, `"Sender"`, `"Config"`.
- **Zapis:** `POST /api/admin/mutate {"sql": "...", "params": [...], "confirm": true}`. Nowe id: `gen_random_uuid()::text`; `"updatedAt"` trzeba podać (`now()`).
- **Config** (`key`, `value` = JSON jako tekst) trzyma ustawienia modułów — klucze wymienione niżej przy modułach.

## 2. Faktura PL (iFirma)

1. **Najpierw historia klienta** (ceny, kolory, termin): `SELECT number, "issueDate", "grossAmount", extras->'items' FROM "Invoice" WHERE "contractorNip" = '...' ORDER BY "issueDate" DESC`. Kontrahent: `"Contractor"` po `nip` albo nazwie.
2. **Podgląd:** `POST /api/ifirma/invoice-preview`
   ```json
   {"contractorId": "…", "items": [{"ean": "5902082556022", "qty": 10}], "globalPriceBrutto": 18, "paymentDays": 7}
   ```
   Zamiast `contractorId` może być `contractorSearch` (nazwa). Pozycje: `{"ean", "qty"}` albo `{"name": "stick blue", "qty"}`; box mix: `{"ean": "BOX-STICK-30", "qty": 2}` rozwija się na 6 kolorów po 5. Cena: krajowa → `globalPriceBrutto` (PLN), WDT → `globalPriceNetto` (EUR). Opcjonalnie `uwagi`. Wynik: `previewId` + `preview` (pozycje, suma). Bez pola `source` podgląd trafia też na Telegram z guzikami, a PDF po wystawieniu — tak ma być.
3. **Wystawienie:** `POST /api/ifirma/invoice-confirm {"previewId": "…"}` → `invoiceNumber`, PDF na Telegram. Ten sam `previewId` nigdy nie da drugiej faktury.
4. **Po błędzie albo przekroczeniu czasu NIE wystawiaj od nowa** — sprawdź, czy faktura nie powstała (`"Invoice"` z ostatnich minut, `"ConfirmLock"`).

Reguły: klient z PL → krajowa, PLN brutto, VAT 23%; klient z UE z aktywnym VIES → WDT, netto EUR (system dobiera sam). „X boxów / paczek / kartonów sticków" = X × 30 szt. Standard: 18 zł brutto albo 4,50 EUR netto za sztukę — ale zawsze sprawdź ostatnią fakturę klienta. Stan magazynu: §5.

## 3. Faktura Kanary (Contasimple, IGIC)

`POST /api/contasimple/invoice-preview {"contractorId" | "contractorCif" | "contractorSearch": "…", "items": [...], "globalPriceNetto" | "globalPriceBrutto": …, "paymentDays": 7}` → `previewId`; `POST /api/contasimple/invoice-confirm {"previewId": "…"}`. Druga faktura dla tego samego klienta w ciągu 2 min → 409 (świadome wymuszenie: `"confirmDuplicate": true`). WZ (albarán): `/api/contasimple/albaran-preview` + `/api/contasimple/albaran-confirm-latest`.

## 4. Kurier (GlobKurier)

1. **Nadawca** z tabeli `"Sender"`: Galiny (domyślny), magazyn w Józefowie (Config `magazyn_sender_id`), inne zapisane adresy. Nowy nadawca:
   `INSERT INTO "Sender" (id, name, street, "houseNumber", "postCode", city, country, "countryId", phone, "isDefault", "createdAt", "updatedAt") VALUES (gen_random_uuid()::text, $1, $2, $3, $4, $5, 'PL', 1, $6, false, now(), now())` (przez `/api/admin/mutate` z `params`). Osobę kontaktową wpisz w `name` („Firma - Imię Nazwisko") — trafia na etykietę.
2. **Wycena:** `POST /api/glob/quote`
   ```json
   {"senderId": "…", "receiverSearch": "Nazwa na etykietę",
    "deliveryAddress": {"street": "Charci Skok", "houseNumber": "1", "apartmentNumber": "", "postCode": "05-822", "city": "Milanówek", "country": "PL", "phone": "+48…", "email": "…", "contactPerson": "…"},
    "weight": 1, "length": 20, "width": 20, "height": 20, "source": "frontend"}
   ```
   → `quoteId`, `offers` (od najtańszej), `pickupDate` (dziś, gdy przed 14:00; inaczej następny dzień roboczy). Kraj jako kod ISO (`DE`, `IT`…).
3. **Zamówienie:** `POST /api/glob/order {"quoteId": "…", "productId": …, "source": "frontend"}` → `orderNumber` (GK…), `hash`, cena. Bierz najtańszą ofertę od drzwi do drzwi, chyba że właściciel powie inaczej.
4. **List przewozowy:** `GET /api/glob/labels/<hash>` (PDF) → wyślij właścicielowi. Szukanie zamówień: `GET /api/glob/orders?search=GK…&limit=100&offset=0` (starsze — kolejne `offset`).

## 5. Magazyn zewnętrzny (Bell, Józefów)

- **Stan i katalog:** `GET /api/magazyn/stan`, `GET /api/magazyn/katalog` (EAN-y, kody fabryczne, skład boxów).
- **Nowe zamówienie:** `POST /api/magazyn/zamowienia`
  ```json
  {"items": [{"ean": "BOX-STICK-30", "qty": 2, "packaging": "karton"}],
   "odbiorca": {"name": "…", "street": "…", "houseNumber": "…", "apartmentNumber": "…", "postCode": "…", "city": "…", "country": "PL", "phone": "+48…", "email": "…"},
   "contractorId": "…", "uwagiNasze": "Sam towar, bez ekspozytorów.", "invoiceNumber": "254/2026", "autoList": true}
  ```
  Bez produktów „generic" — kolory albo box. `packaging`: `karton` albo `ekspozytor` (zatowarowany). `autoList: true` = kurier zamówi się sam, gdy magazyn kliknie „Paczka gotowa" — wymaga pełnego odbiorcy z telefonem. **Odbiorcy nie da się zmienić po złożeniu:** `PATCH /api/magazyn/zamowienia/<id> {"status": "ANULOWANE"}` i złóż nowe.
- **Powiadom magazyn** (mail z delivery@ do magazynu z PDF zamówienia i dokumentami): `POST /api/magazyn/zamowienia/<id>/powiadom` — `{"podglad": true}` pokazuje treść bez wysyłki, `{"ponownie": true}` wysyła drugi raz. Zwykle robi to właściciel guzikiem w panelu.
- PDF zamówienia: `GET /api/magazyn/zamowienia/<id>/pdf`; list: `GET …/<id>/etykieta`; dokument do paczki: `POST …/<id>/dokumenty {"filename", "contentType", "dataBase64", "opis"}`.

## 6. Maile

- **Szukanie:** `SELECT id, inbox, "fromEmail", subject, "createdAt", "bodyFull" FROM "Email" WHERE direction = 'INBOUND' AND …` (`"bodyFull"` ucięte do 2000 znaków, pełny HTML w `"bodyHtml"`). Załączniki: `"EmailAttachment"` (`"emailId"`), plik: `GET /api/attachment/<id>`.
- **Odpowiedź w wątku:** `POST /api/send-email`
  ```json
  {"emailId": "<id maila, na który odpowiadasz>", "body": "tekst", "html": "<p>…</p>",
   "attachments": [{"filename": "katalog.pdf", "contentType": "application/pdf", "contentBase64": "…"}], "draft": false}
  ```
  Nadawca (ta sama skrzynka), odbiorca, temat „Re:" i nagłówki wątku uzupełniają się same. Bez `"draft": false` powstaje szkic (z tłumaczeniem PL do podglądu); wysłanie szkicu: `POST /api/send-email/confirm {"emailId": "…"}`. Limit 20 maili na godzinę.
- **Zawsze najpierw pokaż treść właścicielowi.** Katalog i cennik dla sklepów są w katalogu PDF (ostatnio wysłany jako załącznik z info@ — szukaj w `"EmailAttachment"` po nazwie).

## 7. Raporty kasowe (Pałac Galiny)

Działa samo: skrzynka bota co 3 min, o 4:00 kopia arkusza i zakładka nowego miesiąca. Podgląd i sterowanie: `GET /api/raporty-kasowe/stan` (`?test=1` sprawdza logowanie do skrzynki), `POST /api/raporty-kasowe/sprawdz` (cykl teraz), `POST /api/raporty-kasowe/od {"od": "RRRR-MM-DD"}` (przerób zaległe od daty — dni już wpisane pominie), `POST /api/raporty-kasowe/kopia`, `GET /api/raporty-kasowe/kopie/<id>` (XLSX). Ślad każdego załącznika: tabela `"RaportKasowy"`. Ustawienia: Config `raporty_kasowe`, dane skrzynki: Config `raporty_kasowe_poczta`.

## 8. Faktury dla systemu mailingowego

System mailingowy woła `POST /zewn/faktury` z własnym tokenem (Bearer); CRM wystawia fakturę krajową za usługę i oddaje PDF. **Nowy token:** wylosuj 48 znaków, w Config `faktury_zewn_tokeny` zapisz tylko `[{"nazwa": "mailing", "hash": "<sha256 tokenu>", "od": "<data>"}]` (przez `params`), token daj właścicielowi w pliku — nie w czacie. Limity: Config `faktury_zewn_limity` `{"maxNettoFaktury": 10000, "maxDziennie": 50}`. Faktury z API: `"Invoice".source = 'mailing-api'`.

## 9. Bezpieczeństwo i zdrowie systemu

- **Strażnik:** `GET /api/admin/straznik` (kto woła API w tej godzinie, znane sieci), `POST /api/admin/straznik/przeglad` (bez `"alerty": true` — próbny, nic nie wysyła).
- **Bot Telegram** odpowiada tylko czatom z Config `telegram_dozwolone_czaty` (dopisanie osoby = dopisanie jej chat id); sekret webhooka: Config `telegram_webhook_secret`.
- **Wersja na produkcji:** `GET /czytnik/zdrowie` (publiczne, pole `commit`) albo `GET /api/_version`.
- **Poczta:** `GET /poczta/zdrowie`, `GET /poczta/poller` — nagłówek `x-token` = `PREPROCESS_TOKEN` (jeśli jest w środowisku sesji).

## 10. Zmiany w kodzie

Pracuj na gałęzi sesji, potem `git push origin <gałąź>:main` — Railway (backend) i Vercel (front) wdrażają same. Wdrożenie sprawdzisz po polu `commit` w `GET /czytnik/zdrowie`. Testy backendu: `npm test`. `MAPA.md` (i ten plik, gdy zmienia się sposób obsługi) aktualizuj w tym samym commicie.
