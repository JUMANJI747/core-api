# CRM v2 — Plan implementacji

Stan: **draft do akceptacji**. Branch: `claude/setup-core-api-agents-CqQBI`.
Po Twoim OK — lecimy commit po commicie, każdy etap = osobny commit, PR-y w sensownych blokach.

---

## Cele biznesowe

1. **Single source of truth dla kontrahenta** — jeden rekord per realna firma, niezależnie czy widzimy go w iFirmie (PL), Contasimple (ES), GlobKurier (GK), mailingu czy ręcznym kontakcie.
2. **Customer 360** — jeden endpoint i (docelowo) jeden ekran pokazujący: dane firmowe, kontakty, adresy, FV PL+ES, maile, transakcje, przesyłki, oś czasu zdarzeń.
3. **Analityka sprzedaży** — przychody per kraj/okres/produkt, top customers, sprzedaż per EAN. Wymaga znormalizowanych pozycji FV i denormalizowanych snapshotów na FV.
4. **Activity Log** — chronologiczna oś zdarzeń biznesowych (mail wysłany, FV wystawiona, paczka nadana, tracking wysłany), bez konieczności joinowania pięciu tabel przy każdym zapytaniu.

---

## Stan obecny (z czym pracujemy)

Schema kluczowe:
- `Contractor` — PL CRM. Email/phone/address jako pojedyncze pola, multi-kontakty siedzą w `extras.locations[]`/`aliases[]`/`billingAddress`. iFirmaId też w `extras`.
- `EsContractor` — ES CRM. **Brak relacji** do `Contractor` mimo że to mogą być te same firmy.
- `Invoice` — PL FV. Brak `InvoiceLineItem`, pozycje w `extras` lub wcale. Brak snapshotów `contractorName/Country/Nip`.
- `EsInvoice` — analogicznie, pozycje w `extras`.
- `Email`, `Transaction`, `Consignment`, `Deal` — bez zmian strukturalnych w v2.
- `Activity` — **już zajęte** (per `Deal`). Nowa tabela osi czasu nazywa się `ActivityEvent`.
- `AuditLog` — istnieje, ale używana sporadycznie. W v2 zostawiamy ją na admin/security trail (sudo mutate, gk-raw, admin api), a biznesowe zdarzenia idą do `ActivityEvent`.

---

## Etap 1 — Normalizacja Contractor (foundation)

### 1.1 Nowe pola na `Contractor`

```prisma
preferredLanguage   String?   // ISO-2 (pl, en, de, nl, es, fr, it, pt) — używane przez tracking-notify, mailing
primaryEmail        String?   // wskaźnik na "główny" kontakt; redundantny z ContractorContact ale wygodny w listach
externalIds         Json      @default("{}") // { ifirmaId, gkReceiverId, contasimpleId, eContractorId? }
aliases             String[]  @default([])    // alternatywne nazwy ("ACME Sp. z o.o.", "ACME", "ACME Polska")
linkedEsContractorId String?  @unique         // cross-ref PL ↔ ES; @unique żeby nie zlinkować dwóch PL do jednego ES
```

`extras` zostaje dla rzeczy nieustrukturyzowanych. Sukcesywnie wyciągamy z niego wszystko co normalizujemy do osobnych pól/tabel.

Migracja danych: backfill skript wyciąga `extras.aliases → aliases[]`, `extras.ifirmaId → externalIds.ifirmaId`, `email → primaryEmail`.

### 1.2 `ContractorContact` (multi-email/phone)

```prisma
model ContractorContact {
  id            String     @id @default(uuid())
  contractorId  String
  contractor    Contractor @relation(fields: [contractorId], references: [id], onDelete: Cascade)

  type          String     // 'email' | 'phone' | 'mobile' | 'fax' | 'whatsapp'
  value         String     // znormalizowane (email lowercase; tel z prefiksem +48...)
  label         String?    // 'office' | 'sales' | 'accounting' | 'shipping' | 'owner' | 'support' | wolny tekst
  personName    String?    // "Jan Kowalski"
  isPrimary     Boolean    @default(false)
  source        String?    // 'ifirma', 'contasimple', 'gk', 'mailing', 'manual'
  notes         String?
  extras        Json       @default("{}")
  createdAt     DateTime   @default(now())
  updatedAt     DateTime   @updatedAt

  @@index([contractorId])
  @@index([type, value])  // szybkie wyszukiwanie kontrahenta po mailu/telefonie przy auto-matchu
}
```

### 1.3 `ContractorAddress` (multi-adresy)

```prisma
model ContractorAddress {
  id              String     @id @default(uuid())
  contractorId    String
  contractor      Contractor @relation(fields: [contractorId], references: [id], onDelete: Cascade)

  type            String     // 'billing' | 'delivery' | 'office' | 'warehouse' | 'other'
  label           String?    // "główny magazyn", "biuro Madryt"
  isPrimary       Boolean    @default(false)
  recipientName   String?    // dla GK — kogo wpisać jako odbiorcę
  street          String?
  houseNumber     String?
  postalCode      String?
  city            String?
  region          String?    // województwo / provincia / state
  country         String?    // ISO-2 preferowane, ale tolerancyjne
  countryName     String?    // "Niemcy" / "Germany" — co wpisał user, do display
  fullAddress     String?    // znormalizowany jednolinijkowy (do geocode + GK)
  lat             Float?
  lng             Float?
  geocodedAt      DateTime?
  geocodingStatus String?
  source          String?
  extras          Json       @default("{}")
  createdAt       DateTime   @default(now())
  updatedAt       DateTime   @updatedAt

  @@index([contractorId])
  @@index([country])
  @@index([postalCode])
}
```

Stare pola `Contractor.address/city/country/lat/lng` zostawiamy na okres przejściowy (czytane jako fallback). Po backfillu i przepięciu wszystkich call-sites — usuwamy w osobnym PR.

### 1.4 Cross-ref PL ↔ ES

`Contractor.linkedEsContractorId` + `EsContractor.linkedContractorId` (symetrycznie). Auto-link po:
- NIP/NIF identycznym (po normalizacji — usunąć `PL`/`ES` prefix, spacje, kropki),
- normalizowanej nazwie firmy + dopasowanym mailu,
- ręczne potwierdzenie sudo mutate gdy automat się waha.

### 1.5 Sync hooks

| Sync | Działanie po stronie Contractor |
|---|---|
| `ifirma-sync` | upsert Contractor po `nip` → zapisz `externalIds.ifirmaId`; upsert ContractorContact (email z FV) z `source='ifirma'`; upsert ContractorAddress(type=billing) |
| `contasimple-sync` | upsert EsContractor; jeśli NIF == Contractor.nip → ustaw `linkedEsContractorId`; analogiczne contacts/addresses |
| `gk` (po createOrder) | upsert ContractorContact(type=phone, label='shipping') jeśli novel; ContractorAddress(type=delivery) jeśli novel; `externalIds.gkReceiverId` |
| `email-classifier` | upsert ContractorContact(type=email, source='mailing') przy pierwszym kontakcie z nowego adresu |

---

## Etap 2 — Denormalizacja Invoice + InvoiceLineItem

### 2.1 Nowe pola na `Invoice` i `EsInvoice`

```prisma
// Invoice + EsInvoice oba dostają:
contractorName     String?   // snapshot z momentu wystawienia
contractorNip      String?   // snapshot (NIP dla PL, NIF dla ES)
contractorCountry  String?   // ISO-2 snapshot — używany w analytics filtering
contractorCity     String?   // snapshot — przyda się do "sprzedaż per region"
```

Po co snapshot: kontrahent może zmienić adres/nazwę za rok, FV historyczna ma pokazywać prawdę z momentu transakcji. Plus indexy na `(contractorCountry, issueDate)` pozwolą BI queries puścić bez joina.

Indexy:
```prisma
@@index([contractorCountry, issueDate])
@@index([currency, issueDate])
```

### 2.2 `InvoiceLineItem` (PL + ES wspólna tabela albo osobne)

**Decyzja architektoniczna:** osobne `InvoiceLineItem` i `EsInvoiceLineItem` — mirror osobnych tabel `Invoice`/`EsInvoice`. Inny VAT (PL VAT vs IGIC), inny katalog (`Product` vs `EsProduct`), inny system ID. Łączenie ich na poziomie schemy powoduje więcej problemów (nullable referencje) niż daje korzyści.

```prisma
model InvoiceLineItem {
  id               String   @id @default(uuid())
  invoiceId        String
  invoice          Invoice  @relation(fields: [invoiceId], references: [id], onDelete: Cascade)

  // produkt (opcjonalny — niektóre pozycje to "Delivery" lub usługa bez katalogu)
  productId        String?
  product          Product? @relation(fields: [productId], references: [id])
  ean              String?
  name             String
  unit             String   @default("szt")
  qty              Decimal  @db.Decimal(12, 3)
  unitPriceNetto   Decimal  @db.Decimal(12, 2)
  vatRate          String   // "23", "8", "0", "ZW", "NP"
  vatAmount        Decimal  @db.Decimal(12, 2)
  totalNetto       Decimal  @db.Decimal(12, 2)
  totalGross       Decimal  @db.Decimal(12, 2)
  currency         String   @default("PLN")

  // denormalizacja do BI
  contractorId     String?
  contractorCountry String?
  issueDate        DateTime
  ifirmaLineId     Int?

  position         Int      // kolejność na FV (1, 2, 3...)
  extras           Json     @default("{}") // GTU_13, jednostka źródłowa, raw line
  createdAt        DateTime @default(now())

  @@index([invoiceId])
  @@index([productId])
  @@index([ean])
  @@index([contractorId, issueDate])
  @@index([contractorCountry, issueDate])
  @@index([ean, issueDate])
}
```

Analogicznie `EsInvoiceLineItem` (FK do `EsInvoice` i `EsProduct`, vatRate wartości IGIC: `0`, `3`, `7`, `9.5`, `15`, `20`, `EX`).

### 2.3 Backfill pozycji

Skrypt `scripts/backfill-invoice-lines.js`:
1. Iteruj `Invoice` z `extras.lines` — zmapuj na `InvoiceLineItem`.
2. Jeśli FV nie ma `extras.lines`, ale ma `ifirmaId` → zaciągnij z iFirma API i zapisz.
3. FV bez `ifirmaId` (manual) — pomijamy z logiem do przeglądu.
4. Idempotentne: skip gdy `InvoiceLineItem` dla `invoiceId` już istnieje (chyba że flaga `--force`).

Analogicznie `backfill-es-invoice-lines.js` z Contasimple.

---

## Etap 3 — Endpointy

### 3.1 Customer 360

`GET /api/contractors/:id/360`

Bundle:
```json
{
  "contractor": { ...Contractor, contacts: [...], addresses: [...] },
  "linkedEs": { ...EsContractor } | null,
  "invoices": {
    "pl": [{ id, number, issueDate, grossAmount, currency, status, lineCount }],
    "es": [...]
  },
  "emails": [{ id, direction, subject, fromEmail, createdAt, inbox, hasAttachments }],
  "transactions": [{ id, occurredAt, amount, currency, hasOrder, hasInvoice, hasShipped, hasDelivered, hasPayment, shipmentNumber, trackingNumber }],
  "activity": [{ id, type, summary, createdAt, source, actor }],
  "stats": {
    "totalRevenuePLN": "...",
    "totalRevenueEUR": "...",
    "invoiceCount": N,
    "lastContactAt": "...",
    "lastInvoiceAt": "...",
    "lastShipmentAt": "..."
  }
}
```

Query params: `?limitInvoices=20&limitEmails=20&limitTransactions=20&limitActivity=50`.

### 3.2 Analytics

```
GET /api/analytics/revenue?country=ES&from=2026-01-01&to=2026-12-31&granularity=month
GET /api/analytics/top-customers?year=2026&country=PL&limit=20
GET /api/analytics/products-sold?ean=...&from=...&to=...
GET /api/analytics/products-sold?from=...&to=...   // top EAN-y
```

Wszystko leci po denormalizowanych polach na `Invoice`/`InvoiceLineItem` — żadnych N+1.

### 3.3 Sudo / contractor merge

`POST /api/admin/contractors/merge` — `{ keepId, dropId }` — przepina wszystkie Email/Invoice/Transaction/Contact/Address z `dropId` na `keepId`, usuwa `dropId`. Wymaga `confirm: true`. Loguje do ActivityEvent + AuditLog.

`POST /api/admin/contractors/:id/link-es` — `{ esContractorId }` — ustawia cross-ref. Confirm flag.

---

## Etap 4 — ActivityEvent (oś czasu)

### 4.1 Tabela

```prisma
model ActivityEvent {
  id              String   @id @default(uuid())
  type            String   // patrz lista poniżej
  summary         String   // "FV 65/2026 wystawiona dla ACME (1230,00 PLN)"
  source          String   // 'ifirma' | 'contasimple' | 'gk' | 'imap' | 'mailing' | 'agent' | 'sudo' | 'webhook' | 'system'

  contractorId    String?
  emailId         String?
  invoiceId       String?
  esInvoiceId     String?
  transactionId   String?
  shipmentNumber  String?
  trackingNumber  String?

  actorType       String   // 'user' | 'agent' | 'system' | 'webhook'
  actorId         String?  // n8n chatId, agent name ("logistics"), worker id
  payload         Json     @default("{}")  // dodatkowe dane (linki, snapshoty, IDs)

  createdAt       DateTime @default(now())

  @@index([contractorId, createdAt])
  @@index([type, createdAt])
  @@index([source, createdAt])
  @@index([createdAt])
  @@index([invoiceId])
  @@index([transactionId])
  @@index([shipmentNumber])
}
```

### 4.2 Słownik typów (lista zamknięta — stała w `src/services/activity-log.js`)

```
mail.received          mail.sent           mail.sent_external     mail.draft.created
mail.failed            mail.bounce         mail.classified

invoice.created             invoice.sent            invoice.pdf_to_telegram
invoice.paid                invoice.overdue         invoice.canceled
invoice.pdf_downloaded      invoice.reminder_sent

es_invoice.created          es_invoice.sent         es_invoice.pdf_to_telegram
es_invoice.paid             es_invoice.canceled     es_invoice.pdf_downloaded

shipment.quote_requested    shipment.quote_built    shipment.created
shipment.canceled           shipment.label_printed  shipment.delivered
shipment.stale

tracking.checked            tracking.notify.draft   tracking.notify.sent
sync.tracking.poll_batch

contractor.created          contractor.updated      contractor.merged
contractor.linked_es        contractor.geocoded     contractor.geocode_failed

product.created             product.updated

mailing.sent                mailing.bounced         mailing.unsubscribed
mailing.replied

sync.ifirma.started         sync.ifirma.finished    sync.ifirma.failed
sync.contasimple.started    sync.contasimple.finished   sync.contasimple.failed
sync.gk_receivers.started   sync.gk_receivers.finished  sync.gk_receivers.failed
sync.sheets.pushed          sync.sheets.failed
sync.imap.poll              sync.imap.poll_sent

agent.tool_call             agent.confirmation_resolved     agent.recent_activity_pulled

admin.mutate                admin.api_call          admin.gk_raw

telegram.in                 telegram.out            telegram.file_sent

api.error                   api.slow_request         // gated, ACTIVITY_LOG_OBSERVABILITY=1
```

**Filozofia "każda akcja backendu = log":** każdy hot path (sendMail, createInvoice, createOrder, geocode, sync runs, agent tool calls) emituje event. Volumin → wysoki ale akceptowalny dzięki:
- `setImmediate` (zero blokady),
- per-kategoria env gating (patrz 4.2.1),
- partycjonowanie/retention (patrz 4.2.2).

#### 4.2.1 Env gates (per-kategoria opt-out)

Wszystko **default ON** w produkcji, żeby agent miał pełen kontekst. Wyłączane tylko gdy zauważymy szum.

```
ACTIVITY_LOG_MAIL=1
ACTIVITY_LOG_INVOICE=1
ACTIVITY_LOG_SHIPMENT=1
ACTIVITY_LOG_TRACKING=1
ACTIVITY_LOG_CONTRACTOR=1
ACTIVITY_LOG_PRODUCT=1
ACTIVITY_LOG_MAILING=1
ACTIVITY_LOG_SYNC=1
ACTIVITY_LOG_AGENT_CALLS=1
ACTIVITY_LOG_ADMIN=1
ACTIVITY_LOG_TELEGRAM=1
ACTIVITY_LOG_OBSERVABILITY=0     ← default OFF (api.error / api.slow_request — dużo szumu)
```

`logActivity` sprawdza prefix typu (`mail.*` → `ACTIVITY_LOG_MAIL`) i pomija jeśli `0`.

#### 4.2.2 Retention

Tabela rośnie. Cron raz dziennie:
- `agent.tool_call` / `agent.recent_activity_pulled` / `sync.imap.poll*` — **30 dni** (debug, nie biznes),
- `telegram.*` — **90 dni**,
- `admin.*` — **forever** (security trail),
- reszta (`mail.*`, `invoice.*`, `shipment.*`, `contractor.*`, `sync.<system>.{started,finished,failed}`) — **forever** (biznes),
- `api.error` / `api.slow_request` — **14 dni**.

Skrypt `scripts/prune-activity.js` + cron `0 4 * * *`.

### 4.3 Helper

`src/services/activity-log.js`:

```js
const VALID_TYPES = new Set([...]);

async function logActivity(prisma, evt) {
  // walidacja type ∈ VALID_TYPES (warn + skip jeśli nie)
  // setImmediate / fire-and-forget — NIE blokuje hot path
  setImmediate(() => {
    prisma.activityEvent.create({ data: evt }).catch(err => {
      console.warn('[activity-log] failed:', err.message, evt.type);
    });
  });
}

module.exports = { logActivity, VALID_TYPES };
```

### 4.4 Miejsca wstrzyknięcia (mapa hooków — "każda akcja backendu = log")

#### Mail (10)

| Plik / punkt | Typ |
|---|---|
| `mail-sender.sendMail` ok | `mail.sent` |
| `mail-sender.sendMail` fail | `mail.failed` |
| imap consumer INBOX | `mail.received` |
| imap consumer Sent (bez `appendedToSentAt`) | `mail.sent_external` |
| imap consumer Sent (z `appendedToSentAt`) | — (idempotent skip) |
| email classifier (sub-agent) | `mail.classified` |
| bounce parsing (jak dorobimy) | `mail.bounce` |
| draft builder (tracking-notify / agent compose) | `mail.draft.created` |
| imap poll run (per inbox) | `sync.imap.poll` |
| sent-folder poll run (per inbox) | `sync.imap.poll_sent` |

#### Invoice PL (iFirma) (8)

| Plik / punkt | Typ |
|---|---|
| `ifirma-sync.createInvoice` sukces | `invoice.created` |
| invoice-confirm-latest → `sendInvoicePdf` (Telegram) | `invoice.pdf_to_telegram` |
| invoice send to customer (sendMail z PDF) | `invoice.sent` |
| download PDF z iFirma (cache) | `invoice.pdf_downloaded` |
| iFirma payment webhook / status sync flip → paid | `invoice.paid` |
| nightly scan past dueDate, status unpaid | `invoice.overdue` |
| cancel (jak dorobimy) | `invoice.canceled` |
| reminder mail wysłany | `invoice.reminder_sent` |

#### Invoice ES (Contasimple) (6) — mirror PL

| Plik / punkt | Typ |
|---|---|
| `contasimple-helpers.create` sukces | `es_invoice.created` |
| `sendInvoicePdf` (Telegram) — **nowy hook po stronie ES** | `es_invoice.pdf_to_telegram` |
| send to customer (sendMail z PDF) — **nowy hook** | `es_invoice.sent` |
| download PDF z Contasimple | `es_invoice.pdf_downloaded` |
| payment status flip → Payed | `es_invoice.paid` |
| cancel | `es_invoice.canceled` |

#### Shipment / Tracking (8)

| Plik / punkt | Typ |
|---|---|
| `glob-quote` getQuote | `shipment.quote_requested` |
| `glob-quote` buildQuote preview | `shipment.quote_built` |
| `glob-quote` createOrder sukces | `shipment.created` |
| `glob-client` delete-order sukces | `shipment.canceled` |
| `glob-client` print label | `shipment.label_printed` |
| `getOrderTracking` polling (per check) | `tracking.checked` |
| `tracking-notify.js` DRAFT created | `tracking.notify.draft` |
| `tracking-notify.js` confirm-latest → wysyłka | `tracking.notify.sent` |
| (webhook delivery confirmation, jak dorobimy) | `shipment.delivered` |

#### Contractor / CRM (6)

| Plik / punkt | Typ |
|---|---|
| `contractors/upsert` nowy rekord | `contractor.created` |
| `contractors/upsert` update | `contractor.updated` |
| `/api/admin/contractors/merge` | `contractor.merged` |
| `/api/admin/contractors/:id/link-es` | `contractor.linked_es` |
| `geocode-all` / `geocode-llm-fallback` ok | `contractor.geocoded` |
| geocode error | `contractor.geocode_failed` |

#### Product (2)

| Plik / punkt | Typ |
|---|---|
| `Product` / `EsProduct` insert | `product.created` |
| update | `product.updated` |

#### Mailing (4)

| Plik / punkt | Typ |
|---|---|
| mailing campaign sendMail ok | `mailing.sent` |
| bounce detect z IMAP | `mailing.bounced` |
| unsubscribe link clicked / mail | `mailing.unsubscribed` |
| reply detected od `MailingContact` | `mailing.replied` |

#### Sync (cron — patrz Etap 6) (8)

| Job | Typy |
|---|---|
| daily iFirma pull | `sync.ifirma.started` → `finished` / `failed` |
| daily Contasimple pull | `sync.contasimple.started` → `finished` / `failed` |
| daily GK receivers sync | `sync.gk_receivers.started` → `finished` / `failed` |
| Google Sheets push (każdy push) | `sync.sheets.pushed` / `sync.sheets.failed` |

#### Agent (3)

| Plik / punkt | Typ |
|---|---|
| `agent-runtime.js` przed każdym `tool_use` | `agent.tool_call` (z `payload: { agent, tool, input }`, opcjonalnie truncate input >2KB) |
| `/api/agent/resolve-confirmation` rozstrzygnięcie | `agent.confirmation_resolved` |
| `/api/agent/recent-activity` query | `agent.recent_activity_pulled` |

#### Admin / Sudo (3)

| Plik / punkt | Typ |
|---|---|
| `/api/admin/mutate` | `admin.mutate` |
| `/api/admin/call-endpoint` | `admin.api_call` |
| `/api/admin/gk-raw` | `admin.gk_raw` |

#### Telegram (3)

| Plik / punkt | Typ |
|---|---|
| Master → backend (przyjęta wiadomość user-a, jeśli n8n nam ją echo'uje przez webhook lub backend wysyła z agent flow) | `telegram.in` |
| `notify-mail-result` / wszystkie `sendMessage` z `telegram-helper.js` | `telegram.out` |
| wysłany dokument/PDF (sendDocument) | `telegram.file_sent` |

**Łącznie ~57 punktów** (vs 17 w poprzedniej wersji). Każdy = jedno `logActivity(prisma, {...})`. Zero await dzięki `setImmediate`. Gating per-kategoria (4.2.1) pozwala wyciszyć każdą grupę bez deploya kodu.

### 4.5 Backfill historyczny

`scripts/backfill-activity.js`:
- `Email` → klasyfikacja po `direction` + `extras.appendedToSentAt`:
  - `INBOUND` → `mail.received`,
  - `OUTBOUND` z `extras.appendedToSentAt` (nasz sendMail) → `mail.sent`,
  - `OUTBOUND` bez `extras.appendedToSentAt` (Thunderbird / inny zewnętrzny klient — w bazie są bo `backfill-sent`/Sent-poller je zaciągnął) → `mail.sent_external`,
  - `DRAFT` → `mail.draft.created`,
  - `FAILED` → `mail.failed`,
- `Invoice` → `invoice.created` (createdAt jako event time),
- `EsInvoice` → `es_invoice.created`,
- `Transaction` → `shipment.created` jeśli `hasShipped`, `tracking.notify.sent` jeśli mamy `trackingNumber`,
- `Contractor` → `contractor.created`.

Idempotent: usuwamy `ActivityEvent where source='backfill'` przed restartem. Flag `--dry-run` standardowo.

### 4.6 Endpoint

```
GET /api/activity?contractorId=X&type=Y&since=Z&until=...&limit=50&offset=0
```

Limit cap 500. Sortowanie `createdAt desc`.

### 4.7 Sent-folder polling (nowe — Thunderbird capture)

**Problem:** dziś IMAP poller czyta tylko INBOX po `lastUid` z `ImapState`. Maile wysłane przez Thunderbirda (lub Twój telefon, webmail, dowolny klient IMAP) trafiają do Sent foldera ale nie do naszej bazy. Agent ich nie widzi → kontekst niepełny przy następnym pytaniu o klienta.

**Rozwiązanie:** rozszerzyć IMAP poller o drugi worker per inbox, który ciągnie z folderu Sent (folder name detect — patrz `imap-diag` które już mamy).

**Detale:**

1. **`ImapState` rozszerzenie:**
   ```prisma
   model ImapState {
     inbox        String   @id      // np. "info"
     lastUid      Int      @default(0)   // INBOX
     sentFolder   String?              // wykryte: "Sent" | "Sent Items" | "INBOX.Sent" | "[Gmail]/Wysłane" — cache po pierwszym imap-diag
     sentLastUid  Int      @default(0)   // pozycja w Sent folderze
     updatedAt    DateTime @updatedAt
   }
   ```

2. **Worker `pollSentFolder(inbox)`** w tym samym module co INBOX poller (`src/services/imap-poller.js` lub gdzie to siedzi):
   - SELECT `sentFolder`, FETCH UID > `sentLastUid`,
   - Dla każdej wiadomości: parsuj headers + body,
   - **Idempotency check 1:** jeśli `messageId` istnieje w `Email` → już mamy (nasz sendMail zapisał + zrobił APPEND, ten APPEND wraca jako "nowy" z perspektywy Sent UID) → **skip**, tylko bumpuj `sentLastUid`,
   - **Idempotency check 2:** jeśli `messageId` brak → nowy mail z Thunderbirda → INSERT do `Email` z `direction='OUTBOUND'`, `inbox=<konto>`, `extras: { source: 'thunderbird_sent_poller' }` (BEZ `appendedToSentAt` — nas tam nie było),
   - **Po INSERT:** `logActivity('mail.sent_external', { contractorId: <auto-match>, emailId, actorType: 'user', actorId: 'thunderbird', payload: { fromEmail, toEmail, subject } })`,
   - **Auto-match contractor:** odpalamy ten sam classifier co dla INBOUND (po `toEmail` przez `ContractorContact.value` lub fallback do `Contractor.email`/`primaryEmail`).

3. **Częstotliwość:** ten sam interval co INBOX (~30s). Sent folder zwykle ma niski volume, narzut minimalny.

4. **Gating env:**
   - `IMAP_POLL_SENT=1` (default 1) — możliwość wyłączenia per deploy,
   - `IMAP_POLL_SENT_INBOXES=info,niko,delivery` (default = wszystkie z `IMAP_ACCOUNTS`) — żeby na start włączyć tylko na koncie głównym, sprawdzić czy idempotency działa, potem rozszerzyć.

5. **Bootstrap dla istniejących Sent folderów:**
   - `POST /api/emails/backfill-sent-full?inbox=info&since=2026-01-01` — jednorazowy zaciąg historycznych Sent (nie polega na UID, robi SEARCH SINCE date),
   - Idempotent po `messageId`,
   - Każdy nowo zapisany OUTBOUND (bez `appendedToSentAt`) → `mail.sent_external` event dorobi backfill-activity skript w 4.5.

6. **Kontrakt dla agenta po implementacji:**
   - `GET /api/contractors/:id/360` zwraca w `emails[]` zarówno INBOUND, OUTBOUND (nasz), jak i sent_external (Thunderbird) — agent widzi pełną korespondencję,
   - `GET /api/activity?contractorId=X` pokazuje `mail.sent_external` w timeline z `actorId: 'thunderbird'` (lub identyfikatorem klienta jeśli da się wyciągnąć z headera `User-Agent`/`X-Mailer`),
   - Sub-agent `communication` przy generowaniu nowej odpowiedzi widzi co już zostało wysłane ręcznie i nie powtarza tematu / nie kontruje Twojej decyzji.

7. **Edge case — race condition:** Twój `sendMail` robi INSERT do `Email` + IMAP APPEND niemal równocześnie. Sent-poller może zobaczyć ten APPEND zanim baza zaindeksuje `messageId`. Mitygacja: w `pollSentFolder` przed INSERT robimy:
   ```sql
   SELECT id FROM Email WHERE messageId = $1
   ```
   Jeśli pusto → 200ms retry (jednorazowy), potem INSERT. Akceptowalne ryzyko duplikatu marginalne.

**Nowa pozycja w kolejce commitów (między 11 a 12):**

11b. `feat(imap): poll Sent folder per inbox; capture Thunderbird-sent emails as OUTBOUND with source=thunderbird_sent_poller; emit mail.sent_external ActivityEvent`

### 4.8 Kategoryzacja i wyszukiwanie (taxonomy + search UX)

Cel: Ty i agent macie znaleźć "wszystko co dotyczy klienta X w ostatnim miesiącu", "wszystkie tracking notify do Niemiec", "co poszło z konta delivery@ ręcznie z Thunderbirda", bez grzebania w Postgresie.

**4.8.1 Hierarchia typu (`type` jest już namespace'owany)**

Format: `<domain>.<action>[.<modifier>]`. Lista domen zamknięta:

| Domain | Co tam idzie | Przykłady akcji |
|---|---|---|
| `mail` | wszystko email-owe | `received`, `sent`, `sent_external`, `draft.created`, `failed`, `bounce`, `classified` |
| `invoice` | PL FV (iFirma) | `created`, `sent`, `pdf_to_telegram`, `paid`, `overdue`, `canceled` |
| `es_invoice` | ES FV (Contasimple) | `created`, `sent`, `paid` |
| `shipment` | przesyłka GK | `quote_built`, `created`, `canceled` |
| `tracking` | komunikacja śledzenia | `notify.draft`, `notify.sent`, `delivered` |
| `contractor` | CRM | `created`, `updated`, `merged`, `linked_es` |
| `agent` | działania subagentów | `tool_call`, `confirmation_resolved` |
| `admin` | sudo + admin endpoints | `mutate`, `api_call`, `gk_raw` |
| `telegram` | (opt) bridge n8n→backend | `in`, `out` |

Skutek: filtr `type=mail.*` daje wszystko mailowe; `type=tracking.notify.*` daje cały lifecycle tracking notify.

**4.8.2 Tagi (cross-cutting)**

```prisma
// dodajemy do ActivityEvent
tags  String[] @default([])
```

Lista zalecanych tagów (luźna, ale Master prompt powinien znać kanoniczne):

| Tag | Sens |
|---|---|
| `inbox:info` / `inbox:niko` / `inbox:delivery` / ... | konto IMAP którego dotyczy |
| `country:de` / `country:pl` / `country:es` / ... | kraj kontrahenta (ISO-2) |
| `lang:pl` / `lang:en` / `lang:de` / ... | język komunikacji |
| `carrier:dpd` / `carrier:inpost` / `carrier:dhl` / `carrier:gls` / ... | kurier (dla `shipment.*` / `tracking.*`) |
| `manual` | zdarzenie zainicjowane przez Ciebie ręcznie (Thunderbird, sudo, frontend) |
| `automated` | zainicjowane przez webhook/scheduler/agent bez user input |
| `complaint` | reklamacja (klasyfikator maila albo agent oznaczył) |
| `urgent` | termin w 24h / status overdue / blocker |
| `follow_up` | wymaga reakcji z naszej strony |
| `internal` | komunikacja wewnętrzna (np. mail między naszymi kontami) |

Index na `tags`:
```prisma
@@index([tags])  // GIN — Postgres array search
```

Tag-set ustawia każdy hook na podstawie kontekstu (np. `tracking-notify.js` po sukcesie woła `logActivity({ type: 'tracking.notify.sent', tags: ['carrier:dpd', 'country:de', 'lang:de', 'inbox:delivery'] })`).

**4.8.3 Pole `searchText` (denormalizowany blob do full-text)**

```prisma
searchText  String?   // konkatenacja: summary + payload.subject + payload.contractorName + payload.toEmail + payload.fromEmail + payload.invoiceNumber + payload.shipmentNumber + payload.trackingNumber

@@index([searchText(ops: raw("gin_trgm_ops"))], type: Gin)  // pg_trgm dla LIKE/ILIKE
```

(Ekstension `pg_trgm` — Railway Postgres ma go domyślnie. Sprawdzimy `CREATE EXTENSION IF NOT EXISTS pg_trgm` jako pierwszy krok migracji.)

Helper `logActivity` automatycznie buduje `searchText` z `summary` + wybranych pól `payload` żeby hook nie musiał pamiętać.

**4.8.4 Endpoint `/api/activity` rozszerzony filtrami**

```
GET /api/activity
  ?contractorId=...
  &type=mail.*                        ← wildcard z prawej (LIKE 'mail.%')
  &type=tracking.notify.sent          ← albo dokładny match
  &types=mail.sent,mail.sent_external ← albo lista
  &tags=country:de,carrier:dpd        ← AND po tagach
  &tagsAny=urgent,follow_up           ← OR po tagach
  &source=thunderbird_sent_poller
  &actorType=user
  &q=ACME                             ← ILIKE na searchText
  &since=2026-04-01
  &until=2026-05-16
  &limit=50
  &offset=0
  &order=desc                         ← desc default, asc dla "od najstarszego"
```

Response zawiera też `facets` (jak Algolia/Meilisearch):
```json
{
  "items": [...],
  "total": 1247,
  "facets": {
    "type": { "mail.received": 423, "mail.sent": 102, "tracking.notify.sent": 67, ... },
    "tags": { "country:de": 89, "carrier:dpd": 54, "urgent": 12, ... },
    "source": { "imap": 525, "ifirma": 134, "gk": 67, ... }
  }
}
```

Facets pozwalają agentowi (i Tobie) szybko zorientować się "w czym tu szukać dalej" bez odpalania kolejnych queries.

**4.8.5 Wyszukiwanie w stylu agenta**

Dodajemy do `agent-runtime.js` (wszystkie subagenty + sudo) tool `search_activity`:

```js
{
  name: 'search_activity',
  description: 'Search activity events / timeline. Use to recall what happened with a customer, find emails sent manually from Thunderbird, list shipments to a country, etc.',
  input_schema: {
    contractorId, type, tags, q, since, until, limit
  }
}
```

Master prompt update: gdy user pyta "co było z X w ostatnim tygodniu" / "pokaż maile do DE" / "co wczoraj wysłałem ręcznie" → router idzie do agenta który ma `search_activity`. Wstępnie: każdy subagent dostaje narzędzie (czytanie taniego logu), bo każdy może potrzebować historii.

**4.8.6 Skróty wyszukiwania (zapisane filtry — opcjonalne, etap 5b z frontendem)**

Tabela `ActivityFilter` (named queries):
```prisma
model ActivityFilter {
  id        String   @id @default(uuid())
  name      String   // "Maile ręczne ostatnie 7 dni", "Tracking DPD do DE"
  query     Json     // ten sam shape co query params
  pinned    Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

Frontend (NocoDB / Next.js): sidebar z pinned filters → klik → wynik. Agent: tool `list_activity_filters` + `run_activity_filter(name)`.

Decyzja: dorzucamy w etapie 5 razem z UI. Backend gotowy do tego z 4.8.4.

---

**Wpływ na otwarte pytania:** dochodzi pytanie #7 (poniżej).

---

## Etap 6 — Scheduled syncs (cron — automat ≥1×/dzień)

**Cel:** żeby agent miał świeże dane bez pytania user-a "kliknij sync". iFirma i Contasimple ciągniemy z automatu raz dziennie, plus okazjonalne lekkie polly w ciągu dnia.

### 6.1 Stack

Railway nie ma natywnego crona przy Node service. Opcje:
- **A. Railway cron service** (osobny deploy z `cron: "..."` w `railway.json`) — natywne, czysto, każdy job osobny container. **Rekomendacja.**
- **B. `node-cron` w głównym procesie** — prościej, ale śpi razem z deployem przy redeploy i konsumuje pamięć głównego API.
- **C. External (GitHub Actions, cron-job.org)** — uderzają w `/api/cron/<job>?key=...`. Najmniej narzutu na nasz side, ale zewnętrzna zależność.

**Propozycja:** **C** na start (najszybsze do uruchomienia, łatwo zmienić cadence bez deploya), migracja do **A** jak rozbudujemy o ciężkie joby. Endpoint pattern: `POST /api/cron/<job>` z headerem `X-Cron-Key`.

### 6.2 Joby

| Job | Endpoint | Cadence | Co robi | Events |
|---|---|---|---|---|
| iFirma daily pull | `POST /api/cron/sync-ifirma` | `0 3 * * *` (03:00 PL) | pobiera FV od `lastSync` (state w `Config`), upsert `Invoice`, upsert `Contractor`, kontakty/adresy, backfill `InvoiceLineItem`, contractor snapshots | `sync.ifirma.started` → `finished {count, durationMs}` / `failed {error}` |
| Contasimple daily pull | `POST /api/cron/sync-contasimple` | `30 3 * * *` (03:30 PL) | analogicznie dla `EsInvoice` / `EsContractor` / `EsInvoiceLineItem` | `sync.contasimple.started` → `finished` / `failed` |
| GK receivers sync | `POST /api/cron/sync-gk-receivers` | `0 4 * * *` (04:00 PL) | refresh listy odbiorców z GK, upsert do `Contractor` po NIP/mailu, dorzuć `gkReceiverId` do `externalIds` | `sync.gk_receivers.*` |
| Invoice overdue scan | `POST /api/cron/scan-overdue` | `0 7 * * 1` (poniedziałek 07:00) | znajdź `Invoice` `status=unpaid`, `dueDate < now()-3d` → emit `invoice.overdue` + tag `urgent`, opcjonalny Telegram notify | `invoice.overdue` |
| Activity prune | `POST /api/cron/prune-activity` | `0 4 * * *` | retention zgodnie z 4.2.2 | `sync.activity_pruned {deleted}` |
| Tracking batch poll | `POST /api/cron/poll-tracking-batch` | `0 8,16 * * *` (2×/dzień: 08:00 i 16:00 PL) | dla wszystkich `Transaction` z `hasShipped && !hasDelivered && shipmentDate > now()-21d` zbiera `orderNumber[]`, jeden batch call do `GET /v1/order/tracking/list?orderList[][orderNumber]=...`, diff względem `lastKnownStatus` w `extras` → eventy `tracking.checked` (zawsze) + `shipment.delivered` (gdy status terminalny). **2 calle do GK/dzień łącznie**, nie per-shipment | `tracking.checked`, `shipment.delivered`, `sync.tracking.poll_batch` |
| IMAP poll INBOX | already-running interval (nie cron) | co ~30s | jak dziś + `sync.imap.poll` event z `payload: { new: N }` | `sync.imap.poll`, `mail.received` |
| IMAP poll Sent (Thunderbird capture) | already-running interval | co ~30s | jak 4.7 | `sync.imap.poll_sent`, `mail.sent_external` |

### 6.3 Idempotency + lock

Każdy job:
1. Bierze advisory lock (`SELECT pg_try_advisory_lock(<hash(jobName)>)`) — gdyby dwa zewnętrzne triggery uderzyły jednocześnie, tylko jeden leci, drugi loguje skip.
2. Zapisuje `Config.key = 'cron:<job>:lastRunAt'` na koniec.
3. State (cursor / `lastSync`) per job w `Config`.

### 6.4 Health surface

`GET /api/cron/health` zwraca dla każdego znanego joba:
```json
{
  "sync-ifirma": { "lastRunAt": "...", "lastStatus": "ok", "lastDurationMs": 4321, "lastCount": 12, "nextExpected": "..." },
  "sync-contasimple": { ... },
  ...
  "warnings": ["sync-gk-receivers: missed expected run window (>26h since last ok)"]
}
```

Agent (sudo i operations) dostaje tool `cron_status` → "kiedy ostatnio leciał sync iFirmy" bez Railway dashboard.

### 6.5 Telegram notify on failure

Każdy `sync.*.failed` event → `notify-mail-result`-style Telegram do Master chatu z `🔧 backend:<hex>` (już mamy). User wie że trzeba interweniować bez logowania do Railway.

### 6.6 Tracking — strategia hybrydowa (mail-driven + batch poll fallback)

**Założenie:** GK wysyła powiadomienia mailowe na `delivery@` przy każdej zmianie statusu paczki (pickup / in transit / out for delivery / delivered / problem). To darmowy real-time signal — nie ma sensu hammerować ich API jeśli można czytać maile które i tak przychodzą.

**A. Primary: parser maili GK na `delivery@`**

Dodajemy do email-classifier nową regułę:
- `fromEmail` matchuje GK domain (`@globkurier.pl` / `@noreply.globkurier.pl` / inne sprawdzimy w prod inbox-ie),
- Wyciągamy z body: `orderNumber` (GK260...), `status`, opcjonalnie `trackingNumber` jeśli pierwsza paczka,
- Update `Transaction` po `shipmentNumber`: `extras.lastKnownStatus`, ewentualnie `hasDelivered=true` + `deliveredAt`,
- Emit `tracking.checked` (zawsze) + `shipment.delivered` (gdy terminal status) z `source: 'gk_email'`, `actorType: 'webhook'`.

Implementacja: nowy worker `src/services/gk-email-parser.js` wywoływany po zapisie `Email` z `inbox='delivery'` i `fromEmail` matching GK. Zero polling, zero callów do API.

**B. Fallback: batch poll 2×/dzień**

W razie gdyby mail się zgubił / GK go nie wysłał / klasyfikator pominął:

**Endpoint GK:**
```
GET /v1/order/tracking/list
Query: orderList[][orderNumber]=GK260... (array, multi)
       orderList[][carrier]=DPD          (optional, gdy numer ambiguous między kurierami)
Header: Accept-Language: pl
Response: 200, application/json, mapa { [orderNumber]: { status, history[], ... } }
```

**Job:** `POST /api/cron/poll-tracking-batch` (08:00 + 16:00 PL):

1. SELECT `Transaction` WHERE `hasShipped = true AND hasDelivered = false AND occurredAt > now() - interval '21 days'` → lista `shipmentNumber`,
2. Zbuduj query: `orderList[][orderNumber]=GK260...` per shipment (carrier opcjonalnie z `Transaction.extras.carrier`),
3. **Pojedynczy call** do GK z całą listą — limit 50 per call (do potwierdzenia w docs, jak >50 to chunkujemy),
4. Iteruj response, diff vs `Transaction.extras.lastKnownStatus`:
   - Status zmieniony → update + emit `tracking.checked` z `payload: { from: old, to: new }`,
   - Status terminalny (`delivered`/`returned`/`canceled`) → `hasDelivered=true`/`canceled flag` + emit `shipment.delivered` (lub odpowiednio),
   - Bez zmian → bump `extras.lastPolledAt`, **nie emitujemy** (cisza w logach),
5. Emit `sync.tracking.poll_batch` z `payload: { shipmentsChecked, statusChanges, errors }`.

**Koszt:** 2 calle/dzień do GK niezależnie od liczby aktywnych shipments. Bardzo bezpieczne dla rate limita.

**C. User-triggered (już mamy)**

Gdy user / agent prosi o tracking konkretnej paczki, wołamy `getOrderTracking(orderNumber)` (single, używany dziś w tracking-notify flow). To zostaje.

**D. Cleanup po 21 dniach**

Transactions starsze niż 21 dni bez delivery → emit `shipment.stale` + Telegram notify "paczka GK260... nie ma confirmed delivery, sprawdź ręcznie", flag `extras.staleNotified=true` żeby nie spamować. Nie usuwamy z DB.

**Wpływ na słownik typów (4.2):** dorzucam `sync.tracking.poll_batch`, `shipment.stale`. Email-driven update używa istniejących `tracking.checked` / `shipment.delivered` z różnym `source`.

---

## Etap 5 — Frontend (decyzja, nie kod)

**Etap 5a (do uruchomienia w tygodniu CRM v2):** NocoDB jako Railway service nad tym samym Postgres. CRUD nad `Contractor`, `ContractorContact`, `ContractorAddress`, `Invoice`, `Product`, `EsContractor`. Read-only viewy do `ActivityEvent`, `Transaction`, `Email`. Kilka godzin do live.

**Etap 5b (tydzień 2-3, osobna decyzja):** Custom Next.js + shadcn/ui:
- Customer 360 (ten endpoint już mamy z etapu 3.1),
- Timeline (ActivityEvent),
- Dashboard (analytics endpoints),
- Editor manual corrections (merge contractors, link PL↔ES, edit primary fields).

Pytanie do Ciebie po etapie 4: które widoki najpierw?

---

## Kolejność commitów (proponowana)

1. `feat(prisma): add preferredLanguage/primaryEmail/externalIds/aliases/linkedEsContractorId on Contractor` + backfill skript dla extras→pola
2. `feat(prisma): add ContractorContact and ContractorAddress models` + backfill z Contractor.email/phone/address/extras.locations
3. `feat(contractors): /api/contractors/:id/360 endpoint` (jeszcze bez activity)
4. `feat(prisma): denormalize contractor snapshot fields on Invoice + EsInvoice` + backfill
5. `feat(prisma): add InvoiceLineItem + EsInvoiceLineItem` + backfill z extras.lines + iFirma/Contasimple API fallback
6. `feat(analytics): /api/analytics/revenue + top-customers + products-sold endpoints`
7. `feat(sync): ifirma-sync + contasimple-sync + gk hook upsert ContractorContact/Address` + alias matching
8. `feat(admin): contractors/merge + contractors/:id/link-es endpoints`
9. `feat(prisma): add ActivityEvent + tags + searchText (pg_trgm)` + helper `src/services/activity-log.js` z walidacją typów i env gates
10. `feat(activity): inject logActivity per-domain` — podzielony na sub-commity:
    - 10a mail (10 hooków)
    - 10b invoice PL (8 hooków)
    - 10c invoice ES (6 hooków, w tym **nowe** `es_invoice.sent` + `pdf_to_telegram`)
    - 10d shipment + tracking (9 hooków)
    - 10e contractor + product (8 hooków)
    - 10f mailing (4 hooki)
    - 10g agent + admin + telegram (9 hooków)
11. `feat(activity): /api/activity endpoint z filtrami, wildcardami, facets`
11b. `feat(imap): poll Sent folder per inbox; capture Thunderbird-sent → mail.sent_external`
12. `feat(activity): backfill historical events from Email/Invoice/EsInvoice/Transaction/Contractor`
13. `feat(360): include activity timeline in /api/contractors/:id/360`
14. `feat(cron): scheduled syncs — sync-ifirma + sync-contasimple + sync-gk-receivers + scan-overdue + prune-activity + poll-tracking endpoints`
15. `feat(cron): /api/cron/health + agent tool cron_status; Telegram notify on sync.*.failed`
16. `feat(agent): search_activity tool dla wszystkich subagentów + Master prompt update (n8n side oddzielnie)`

Każdy commit z testem ręcznym (curl + opis w body PR-a) i logiem Railway.

---

## Migracje — `db push` vs `migrate`?

Aktualnie repo nie ma katalogu `prisma/migrations`. Deploy idzie przez `db push` (sprawdzimy `package.json`/`nixpacks.toml` przy etapie 1). Sugestia: **zostajemy przy `db push`** dla v2 — szybciej, mniej ceremoniału, branch deploys Railway są ok. Migrations dorzucimy później, jednorazowym snapshotem, jeśli będziemy mieli env staging/prod podział.

Risk: dodawanie kolumn `NOT NULL` bez defaulta wywali `db push`. Więc:
- Wszystkie nowe kolumny **nullable** lub z **default**.
- Backfill osobnym krokiem (skript node), po migracji.
- Po backfillu — opcjonalnie tightening (np. `primaryEmail` zostawiamy nullable na zawsze, bo niektórzy kontrahenci nie mają maila wcale).

---

## Reguły operacyjne dla tej roboty

- Każde dodanie kolumny → **commit z `prisma db push` w description** (żeby było jasne że Railway musi to zrobić przy starcie albo my robimy ręcznie z lokalnego env).
- Backfill skrypty: `--dry-run` standardowo, flaga `--apply` żeby zapisać.
- Confirm flag dla merge / link-es / mass updates.
- 🔧 backend:hex sygnatura już istnieje — nowe destruktywne endpointy też ją przepuszczają.
- Backend logi tylko Railway (60s proxy timeout — backfille długie idą jako background script `node scripts/...` lokalnie z DATABASE_URL z Railway, nie przez HTTP).

---

## Otwarte pytania do Ciebie

1. **InvoiceLineItem dla EsInvoice — osobna tabela czy wspólna?** Proponuję osobną. OK?
2. **Backfill InvoiceLineItem** — gdy FV ma `extras.lines` ale niekompletne (brak vatRate), zaciągamy z iFirma API (rate limit) czy zostawiamy puste pole z flagą `extras.incomplete=true`?
3. **ActivityEvent.payload** — limitować rozmiar (np. truncate >10KB)? Niektóre eventy mogą mieć duży snapshot (cała FV).
4. **NocoDB self-hosted czy płatny SaaS?** Self-hosted Railway = darmowo ale jeden więcej service do utrzymania. SaaS = ~10$/mc.
5. **`Contractor` stare pola (`address`, `city`, `country`, `lat`, `lng`)** — kasować w PR-ze `unlock` po zakończeniu migracji wszystkich call-sites, czy zostawić "na zawsze" jako quick-access denormalized?
6. **`Activity` (per-Deal)** — zostawiamy nietkniętą, czy migrujemy do `ActivityEvent` z `dealId` jako kolejny FK i kasujemy starą? (Wpływ: wszystkie miejsca które piszą do `Activity` w deal flow.)
7. **Tagi — kanoniczna lista czy free-form?** Proponuję: kanoniczna lista (tabela `ActivityTagDictionary` lub stała w kodzie) dla `country:`, `lang:`, `carrier:`, `inbox:` (auto-generowane z danych) + free-form dla biznesowych (`urgent`, `complaint`, `follow_up`). Agent dostaje listę kanonicznych w prompcie, free-form proponuje przy klasyfikacji. OK?
8. **Cron trigger — A (Railway cron service), B (`node-cron` w głównym procesie), czy C (external GH Actions / cron-job.org → POST `/api/cron/<job>`)?** Proponuję **C** na start (1 dzień do uruchomienia, łatwo zmieniać cadence bez deploya, klucz w env). Migracja do A gdy będziemy mieli >5 jobów albo długie (>5min).
9. **`agent.tool_call` volume** — KAŻDE wywołanie tool-a przez subagenta = 1 event. Przy intensywnej rozmowie to setki dziennie. Default ON (żeby debug/audit), retention 30 dni (4.2.2). Akceptujesz, czy wolisz default OFF i włączać ad-hoc gdy debugujesz?
10. **`telegram.in` vs `telegram.out`** — `out` mamy łatwo (każdy `telegram-helper.sendMessage` → log). `in` wymaga: albo n8n echo'uje user-message webhookiem do backendu, albo Master agent przy każdym tool call dorzuca `userMessage` w payload (i wtedy logujemy z tego). Wybierasz: A) tylko `out` na start, B) dorobimy webhook z n8n do backendu, C) Master agent przekazuje user-message?

Po Twoim OK / odpowiedziach → ruszamy od commitu 1.
