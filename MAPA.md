# MAPA — core-api (backend)

> **Drogowskaz aplikacji.** Tu jest zapisane CO i GDZIE jest. Każdy nowy element
> (endpoint, serwis, model, integracja) **musi** zostać tu dopisany, a każda
> istotna zmiana — zaktualizowana. To jedyne źródło prawdy o strukturze.
>
> **ZASADA UTRZYMANIA:** dodajesz/zmieniasz kod → w tym samym commicie aktualizujesz MAPĘ.
> Mapa frontu: `core-crm-frontend/MAPA.md`.

---

## 1. Czym jest aplikacja

CRM + automatyzacja księgowo-logistyczna dla **Surf Stick Bell** (kosmetyki/surf
sticki). Obsługuje dwa rynki:
- **PL** — faktury przez **iFirma**, KSeF, JPK.
- **Kanary/ES** — faktury przez **Contasimple** (IGIC 7%), WZ (albaran).

Plus: wysyłki kurierskie **GlobKurier**, odbiór i klasyfikacja maili (IMAP),
agenci AI (Anthropic) sterowani z **Telegrama** (master w n8n) i z panelu CRM.

Stack: Node/Express + Prisma/Postgres. Deploy: `npx prisma db push && node src/index.js`
(nowe modele/pola wchodzą same). Auth: nagłówek `x-api-key` (`src/index.js` → `auth`).

---

## 2. Punkt wejścia i montaż tras

`src/index.js` — bootstrap, middleware auth (`/api`), montaż tras, start `inbox-poller`.

| Prefix URL | Plik | Obszar |
|---|---|---|
| `/` | `routes/map.js` | health/landing |
| `/api/contractors` | `routes/contractors.js` | kontrahenci PL: upsert, 360, **adresy (structured-address / delivery-address)**, merge, geocode, find-address (maile/GK) |
| `/api/deals` | `routes/deals.js` | deale |
| `/api/consignments` | `routes/consignments.js` | komisy/konsygnacje |
| `/api` | `routes/emails.js` | maile: lista, wątki, send-email, translate, read, bulk |
| `/api/mailing` | `routes/mailing.js` | kampanie mailingowe |
| `/api/products` | `routes/products.js` | produkty (katalog PL) |
| `/api` | `routes/config.js` | Config (klucze konfiguracyjne w DB) |
| `/api` | `routes/invoices.js` | **FV PL (iFirma)**: invoice-preview / invoice-confirm(-latest), pay, ksef-status, shipment-doc, last-price, link/unlink-shipment, **invoice-draft-from-email** (prefill formularza FV z maila), cache zamówień GK |
| `/api/jpk` | `routes/jpk.js` | JPK + dopasowanie WDT (`performWdtMatching`) |
| `/api/jpk` | `routes/jpk-package.js` | paczka WDT/eksport (CMR) — build/send do księgowej |
| `/api` | `routes/parse-document.js` | parsowanie dokumentów |
| `/api` | `routes/analytics.js` | analityka sprzedaży |
| `/api` | `routes/glob.js` → `glob-sync`, `glob-orders`, `glob-quote` | **GlobKurier**: senders, orders, **quote**, **order**, send-label, delete-order, presets, calculate-package |
| `/api` | `routes/agent.js` | **agenci AI**: /agent/{logistics,accounting,accounting-es,communication,communication-es,operations,sudo}, /agent/assistant (router Haiku), /agent/email-context |
| `/api` | `routes/upload.js` | upload plików |
| `/api` | `routes/telegram-callback.js` | **tapnięcia guzików Telegram** (zatwierdź FV, zamów kuriera, odrzuć) |
| `/api` | `routes/ksef.js` | KSeF: sync sprzedaży (status) i kosztów |
| `/api` | `routes/costs.js` | faktury kosztowe |
| `/api` | `routes/accounting.js` | **„Dodatkowa księgowość"**: monthly-report, send-month-to-ksef, pair-wdt, pair-wdt-one |
| `/api` | `routes/admin.js` | **contractor-cleanup** (edycja kontrahenta), vies-check, backfille |
| `/api` | `routes/activity.js` | oś zdarzeń (ActivityEvent) |
| `/api` | `routes/cron.js` | zadania cykliczne (raport miesięczny, sync) |
| `/api` | `routes/transactions.js` | transakcje (deal cycle) |
| `/api` | `routes/push.js` | web push (PWA) |
| `/api/contasimple` | `routes/contasimple.js` | **FV ES/Kanary**: invoice-preview/confirm(-latest), albaran (WZ), delete, products/contractors ES |
| `/api` | `routes/mk.js` | **Mała Księgowość (mk.app)** — ETAP 0: `mk/ping`, `mk/ksef-fetch` (wyzwól pobranie z KSeF: buy/sell), `mk/ksef-fetch/:ref` (status), `mk/cost-invoices`, `mk/sales-invoices`, `mk/new-ledger-entries`. Reconciliation MK↔baza↔iFirma↔KSeF = ETAP 2 |

---

## 3. Klienci zewnętrznych API (`src/*.js`)

- `ifirma-client.js` — iFirma (HMAC). `createInvoice`, `upsertContractor`, `registerPayment` (Opłacono), pobranie listy FV i PDF.
- `contasimple-client.js` — Contasimple (ES): faktury, WZ, formaty numeracji.
- `glob-client.js` — GlobKurier: getQuote, getOrders, createOrder, labels, receivers, countries, pickupTimeRanges.
- `ksef-client.js` — KSeF (token RO): pobieranie faktur sprzedaż (Subject1) / koszty (Subject2).
- `mk-client.js` — **Mała Księgowość (mk.app)**: auth (X-API-Key / login→JWT / data-sharing-key, env `MK_*`), wyzwolenie pobrania z KSeF (`ksefFetch` buy/sell), odczyt ledger (vat-purchase/vat-sales/new-ledger-entries/invoices).
- `mail-sender.js` — SMTP (wysyłka maili).
- `vies.js` — walidacja VAT UE (VIES).
- `telegram-utils.js` — `sendTelegram` / `sendTelegramDocument` / `sendTelegramPhoto`, `answerCallbackQuery`, `editMessageReplyMarkup`.
- `http.js` — `fetchWithTimeout`. `asyncHandler.js` — opakowanie błędów Express. `db.js` — klient Prisma.

### Odbiór maili
- `inbox-poller.js` — IMAP co 5 min: filtry (spam/bounce/newsletter), klasyfikacja AI (Haiku), zapis Email + załączniki, **powiadomienie Telegram**; ścieżki specjalne: **web-order** (`isWebOrder`) i **attachment-order** (PDF → `order-llm-parser.js` → „📋 ZAMÓWIENIE Z ZAŁĄCZNIKA"). Health-alert skrzynki.
- `imap-sent.js` — skan folderu Wysłane.
- `order-llm-parser.js` — LLM parser zamówień z tekstu PDF (model `ORDER_PARSER_MODEL`).

### Stany podglądów (in-memory, TTL 30 min)
- `stores.js` — podglądy FV PL (`invoicePreviews`). `es-stores.js` — podglądy FV/WZ ES.
  Trwała idempotencja wystawiania: **`services/confirm-lock.js`** (model `ConfirmLock`).

---

## 4. Serwisy (`src/services/`)

### Agenci AI
- `agent-loop-base.js` — pętla narzędzi, prompt caching, obsługa overloaded (`OVERLOAD_TEXT`).
- `agent-runtime.js` — `buildExecuteTool`, `selfCall` (wewn. HTTP), sanitizacja.
- `logistics-agent.js` — kurier (quote/order/track/label/delete, szukanie adresu). Model `LOGISTICS_AGENT_MODEL`.
- `accounting-agent.js` — FV PL, NIP/VIES, **upsert_contractor** (rozbija adres na pola).
- `accounting-agent-es.js` — FV ES/Kanary.
- `communication-agent.js` / `communication-agent-es.js` — maile/odpowiedzi/tłumaczenia.
- `operations-agent.js` — deale, transakcje, matching FV↔wysyłka, Google Sheets.
- `sudo-agent.js` — administracyjny (call_endpoint).

### Faktury / księgowość
- `ifirma-payload.js` — **`buildIfirmaContractorPayload`**: składa Kontrahenta do iFirmy; postCode z kolumny → ContractorAddress(billing) → extras → regex.
- `ifirma-sync.js`, `ifirma-pdf-parser.js` — sync i parsowanie PDF iFirma.
- `monthly-accounting.js` — zakres miesiąca + `buildReport` (pokrycie KSeF + WDT sparowane/niesparowane).
- `wdt-pairing.js` — **`pairWdtSmart`** (Opus): dopasowanie FV WDT↔wysyłki + weryfikacja kraju (`isToPoland`); **`suggestForInvoice`** — podpowiedzi LLM dla DOWOLNEJ faktury (parowanie „LLM" przy fakturze, bez reguły zagranicy).
- `confirm-lock.js` — atomowa blokada duplikatów wystawiania (DB).
- `contasimple-helpers.js` — pomocnicze ES.
- `invoice-backfill.js`, `invoice-lines-backfill.js`, `invoice-lines-from-ifirma-backfill.js`, `invoice-snapshot-backfill.js`, `es-invoices-backfill.js` — migracje/uzupełnianie pozycji FV.

### Kontrahenci / CRM
- `contractor-match.js` — `findBestContractors`, `sameContractorName` (fuzzy).
- `contractor-sync-helpers.js`, `contractor-contacts-backfill.js`, `contractor-v2-backfill.js` — normalizacja CRM v2.
- `match-gk-order-to-contractor.js`, `find-address-in-gk-orders.js`, `address-from-emails.js` — szukanie adresu dostawy.
- `dedup-locations.js`, `country-helper.js`, `owner-derive.js`.
- `geocode.js`, `llm-geocode.js` — geokodowanie adresów.

### Logistyka / wysyłki
- `tracking-notify.js`, `tracking-urls.js` — powiadomienia trackingu do klienta.
- `auto-pair-shipments.js` — **auto-parowanie FV↔wysyłka po TOŻSAMOŚCI kontrahenta** (dokładna nazwa / zapisany adres kod+miasto) + data ±7 dni; zapisuje jawny link (fire-and-forget z GET /invoices i /glob/orders).
- `transaction-tracker.js` — `trackInvoice`/`trackShipment` (deal cycle).
- `shipping-backfill-from-gk.js`, `match-shipments-by-query.js`.

### Infrastruktura
- `activity-log.js` / `activity-backfill.js` / `activity-prune.js` — oś zdarzeń.
- `telegram-helper.js` — `resolveTelegram` (token+chatId per scope pl/kanary).
- `product-catalog.js`, `sheets-sync.js`, `notify-mail-result.js`, `email-translate.js`.
- `utils/address.js` — `extractPostCode`, `extractCityAfterPostCode`. `utils/email-domain.js` — `companyDomain`.

---

## 5. Modele danych (`prisma/schema.prisma`)

- **Kontrahenci:** `Contractor` (PL, flat + `extras`, **`postCode`**), `ContractorContact` (multi email/tel), `ContractorAddress` (strukturalne adresy: `billing`/`delivery`, ulica/numer/**apartment**/postalCode/miasto), `EsContractor` (ES).
- **Faktury:** `Invoice` + `InvoiceLineItem` (PL), `EsInvoice` + `EsInvoiceLineItem` (ES), `KsefCostInvoice`, `CostInvoice` (koszty manualne/upload).
- **Sprzedaż/logistyka:** `Deal`, `Transaction`, `Consignment` + `ConsignmentItem` + `ConsignmentReturn`, `Sender`, `Quote` (trwałe wyceny GK), `MonthlyPackage` (paczka WDT), `Document` (CMR/PDF).
- **Maile:** `Email`, `EmailAttachment`, `MailingContact`.
- **Produkty:** `Product` (PL), `EsProduct` (ES).
- **Infra:** `Config`, `Memory`, `ImapState`, `AgentContext` (ostatni preview/draft per agent), `Activity`/`ActivityEvent`, `SystemEvent`, `AuditLog`, **`ConfirmLock`** (idempotencja wystawiania).

---

## 6. Kluczowe przepływy

- **Wystawienie FV (PL):** preview → `stores.js` + `AgentContext` → guzik/„tak" → `invoice-confirm(-latest)` → `confirm-lock` (atomowa blokada duplikatów, między instancjami) → `ifirma-client.createInvoice` → zapis `Invoice` → PDF na Telegram. ES: analogicznie przez `contasimple.js` + `es-stores.js`.
- **Wycena/zamówienie kuriera:** `/glob/quote` (z `chatId` → backend SAM pcha 1 wiadomość z guzikami; `telegramPushed`) → tap guzika → `telegram-callback.js` → `/glob/order` (dedup po quoteId) → CMR + tracking. Agent przy `telegramPushed=true` milczy (`suppressReply`).
- **Mail → Telegram:** `inbox-poller` → klasyfikacja → web-order/attachment-order/standard → Telegram + web push.
- **WDT dla księgowej:** `accounting.js` pair-wdt(/-one) → `wdt-pairing.pairWdtSmart` (Opus + weryfikacja kraju) → `jpk-package.js` build/send CMR.
- **Adres kontrahenta → iFirma:** UI/agent → `contractors.js upsert` / `structured-address` lub `admin.js contractor-cleanup` → kolumna `postCode` + `ContractorAddress(billing)` + `extras.billingAddress` → `ifirma-payload.js` czyta przy FV.

---

## 7. Konwencje

- Modele/pola Prisma wchodzą przez `prisma db push` na starcie — nie trzeba migracji ręcznych.
- Sekrety/konfiguracja: env (Railway) + tabela `Config`.
- Modele Anthropic przez env (`LOGISTICS_AGENT_MODEL`, `ORDER_PARSER_MODEL`, `WDT_MATCH_MODEL`, …); działające: `claude-opus-4-8`, `claude-sonnet-4-5-20250929`, `claude-haiku-4-5-20251001`.
- Idempotencja wystawiania FV/WZ: zawsze przez `services/confirm-lock.js`.
- Powiadomienia Telegram per scope: `services/telegram-helper.resolveTelegram` (`pl` / `kanary`).
