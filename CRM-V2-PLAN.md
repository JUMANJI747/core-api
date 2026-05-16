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

invoice.created        invoice.sent        invoice.pdf_to_telegram
invoice.paid           invoice.overdue     invoice.canceled

es_invoice.created     es_invoice.sent     es_invoice.paid

shipment.quote_built   shipment.created    shipment.canceled
tracking.notify.draft  tracking.notify.sent tracking.delivered

contractor.created     contractor.updated  contractor.merged
contractor.linked_es

agent.tool_call                    // opcjonalne, gated env ACTIVITY_LOG_AGENT_CALLS=1
admin.mutate           admin.api_call     admin.gk_raw

telegram.in            telegram.out       // opcjonalne, ACTIVITY_LOG_TELEGRAM=1
```

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

### 4.4 Miejsca wstrzyknięcia (mapa hooków)

| Plik | Punkt | Typ ActivityEvent |
|---|---|---|
| `src/services/mail-sender.js` (lub gdzie sendMail) | po `sendMail` ok | `mail.sent` |
| ten sam plik | po sendMail fail | `mail.failed` |
| imap consumer (INBOX) | po zapisie INBOUND email | `mail.received` |
| imap consumer (Sent folder, **nowy poller**) | po zapisie OUTBOUND email **bez** `extras.appendedToSentAt` → wysłany ręcznie z Thunderbirda/innego klienta | `mail.sent_external` |
| imap consumer (Sent folder) | po zapisie OUTBOUND **z** `extras.appendedToSentAt` → nasz `sendMail` już to zalogował, **skip** (idempotent — patrz 4.7) | — |
| `tracking-notify.js` | po stworzeniu DRAFT | `tracking.notify.draft` |
| `tracking-notify.js` | po `confirm-latest` → wysyłka | `tracking.notify.sent` |
| `ifirma-sync.js` createInvoice | sukces | `invoice.created` |
| invoice-confirm-latest | po `sendInvoicePdf` (telegram) | `invoice.pdf_to_telegram` |
| invoice send to customer | po sendMail z PDF | `invoice.sent` |
| iFirma payment webhook (jak będzie) | | `invoice.paid` |
| `contasimple-helpers.js` create | sukces | `es_invoice.created` |
| `glob-quote` createOrder | sukces (już istnieje matcher Transaction — dorzucamy log) | `shipment.created` |
| glob `delete-order` | sukces | `shipment.canceled` |
| `contractors/upsert` | nowy rekord | `contractor.created` |
| `contractors/upsert` | update istniejącego | `contractor.updated` |
| `/api/admin/contractors/merge` | sukces | `contractor.merged` |
| `/api/admin/mutate` | sukces | `admin.mutate` |
| `/api/admin/call-endpoint` | sukces | `admin.api_call` |
| `/api/admin/gk-raw` | sukces | `admin.gk_raw` |

Łącznie **~17 punktów**. Każdy = jedno wywołanie `logActivity(prisma, {...})`. Zero await.

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

1. `feat(prisma): add preferredLanguage/primaryEmail/externalIds/aliases/linkedEsContractorId on Contractor` + migration + backfill skript dla extras→pola
2. `feat(prisma): add ContractorContact and ContractorAddress models` + backfill z Contractor.email/phone/address/extras.locations
3. `feat(contractors): /api/contractors/:id/360 endpoint` (jeszcze bez activity)
4. `feat(prisma): denormalize contractor snapshot fields on Invoice + EsInvoice` + backfill
5. `feat(prisma): add InvoiceLineItem + EsInvoiceLineItem` + backfill z extras.lines + iFirma/Contasimple API fallback
6. `feat(analytics): /api/analytics/revenue + top-customers + products-sold endpoints`
7. `feat(sync): ifirma-sync + contasimple-sync + gk hook upsert ContractorContact/Address` + alias matching
8. `feat(admin): contractors/merge + contractors/:id/link-es endpoints`
9. `feat(prisma): add ActivityEvent model` + helper `src/services/activity-log.js` z walidacją typów
10. `feat(activity): inject logActivity in 17 hot paths` (jeden commit lub podzielony per-domain: mail / invoice / shipment / contractor / admin)
11. `feat(activity): /api/activity endpoint`
12. `feat(activity): backfill historical events from Email/Invoice/Transaction/Contractor`
13. `feat(360): include activity timeline in /api/contractors/:id/360`

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

Po Twoim OK / odpowiedziach → ruszamy od commitu 1.
