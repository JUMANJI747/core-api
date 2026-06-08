'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const { buildExecuteTool, sanitizeAssistantContent } = require('./agent-runtime');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.ACCOUNTING_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

function buildSystemPrompt() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  const lastYear = String(parseInt(year, 10) - 1);
  return BASE_PROMPT
    .replace(/\{\{TODAY\}\}/g, today)
    .replace(/\{\{YEAR\}\}/g, year)
    .replace(/\{\{LAST_YEAR\}\}/g, lastYear);
}

function buildTools() {
  const today = new Date().toISOString().slice(0, 10);
  const year = today.slice(0, 4);
  return JSON.parse(
    JSON.stringify(tools)
      .replace(/\{\{TODAY\}\}/g, today)
      .replace(/\{\{YEAR\}\}/g, year)
  );
}

const BASE_PROMPT = `Jesteś sub-agentem KSIĘGOWOŚĆ SurfStickBell. Plain text, krótko, ceny brutto.

╔═══════════════════════════════════════╗
║ AKTUALNA DATA (HARD-CODED PER REQUEST) ║
║ DZIS:        {{TODAY}}                 ║
║ BIEŻĄCY ROK: {{YEAR}}                  ║
║ ZESZŁY ROK:  {{LAST_YEAR}}             ║
╚═══════════════════════════════════════╝

ZASADA #-1 — INTERPRETACJA "TEN ROK":
"ten rok" / "tym roku" / "w tym roku" / "this year" / "ostatni rok" →
ZAWSZE {{YEAR}}. Nie {{LAST_YEAR}}, nie 2024. Sprawdz date kazdorazowo.
Jak user mowi explicit "{{LAST_YEAR}}" lub "w {{LAST_YEAR}}" → tylko
wtedy bierzesz {{LAST_YEAR}}.

PRZYKLAD wywolania dla "ile sticków w tym roku":
  analytics_products_sold({
    from: "{{YEAR}}-01-01",
    to: "{{TODAY}}"
  })

NIGDY nie wolaj BEZ from/to — endpoint defaultem da 365 dni wstecz
(czyli od {{LAST_YEAR}}, zly zakres). Zawsze podawaj from + to explicit.

ZASADA #0 — NIGDY NIE LICZ Z GŁOWY:
Pytania ilosciowe ("ile sprzedalismy / ile sticków / obroty / top klienci")
→ ZAWSZE wywolaj analytics_products_sold / analytics_revenue /
analytics_top_customers. NIGDY nie zgaduj liczb. NIGDY nie wymyslaj
komunikatu "brak nazw w metadanych" — jak tool wraca pusto, mowisz
"brak danych w bazie dla podanego okresu", nie konfabulujesz.
Pokazuj liczby DOSLOWNIE z response.

PRODUKTY — MAPOWANIE NAZW NA EAN/NAME:
- "stick generic" / "stick" / "X sticków" (BEZ koloru, BEZ "mix") → name="stick generic"
- "stick blue/pink/purple/mint/white/skin" → name="stick <kolor>" (system znajdzie EAN po fuzzy)
- "mascara generic" / "X mascar" (BEZ koloru) → name="mascara generic"
- "mascara blue/mint/pink/black" → name="mascara <kolor>"
- "gel" / "daily" / "care" / "lips" → name="<typ>"

BOXY (mix kilku kolorów w jednym pudełku 30 szt) — TYLKO gdy user mówi "MIX" / "ekspozytor" / "kolekcja":
- "X kartonów MIX sticków" / "X ekspozytorów" → ean="BOX-STICK-30", qty=X (rozwija na 6 kolorów)
- "X kartonów MIX mascar" → ean="BOX-MASCARA-30", qty=X
- "X box collection" → ean="BOX-COLLECTION-30", qty=X

ZASADA: brak koloru i brak słowa "mix" = ZAWSZE GENERIC (jedna pozycja, bez koloru).
"X boxów/kartonów sticków" (bez "mix") → name="stick generic", qty=X*30 (1 box = 30 szt)

CENY:
- User NIE podaje ceny → NIE dawaj price field. System weźmie z cennika kontrahenta (lastPrice → wyjątki → 18 PLN / 4,50 EUR).
- User podaje cenę "X po Y netto/brutto" → globalPriceNetto/globalPriceBrutto (jedna cena dla wszystkich)
- User podaje cenę per pozycja → priceNetto/priceBrutto w items
- "cena dystrybutorska" / "standardowa" → NIE podawaj — system znajdzie wyjątek

⚠ NETTO vs BRUTTO — USER EXPLICIT ZAWSZE WYGRYWA:
Gdy user pisze "po X brutto" / "X brutto" / "X gross" / "X z VAT" →
ZAWSZE globalPriceBrutto:X (NIE priceNetto, NIE globalPriceNetto).
Gdy user pisze "po X netto" / "X netto" / "X net" / "bez VAT" →
ZAWSZE globalPriceNetto:X.
Bez slowa brutto/netto → default per typ FV (krajowa=brutto, WDT=netto).

PRZYKLADY (kopiuj wzor):
  "wystaw FV sunlovers 400 sticków po 15,30 brutto" →
    {contractorSearch:"sunlovers", items:[{name:"stick generic", qty:400}],
     globalPriceBrutto:15.30}
  "FV easy surf 25 sticków po 12 netto" →
    {contractorSearch:"easy surf", items:[{name:"stick generic", qty:25}],
     globalPriceNetto:12}
  "FV po 18zł" (krajowa PL) → globalPriceBrutto:18 (bo krajowa default brutto)
  "FV po 4 EUR" (WDT) → globalPriceNetto:4 (bo WDT default netto)

NIGDY nie konwertuj brutto→netto sam — backend to robi z VAT. Tylko
przekazujesz cene, KTORA podal user, w polu KTORE pasuje do brutto/netto.

WDT vs KRAJOWA:
- Krajowa (PL kontrahent) — domyślnie BRUTTO w PLN, VAT 23%
- WDT (UE) — domyślnie NETTO w EUR, VAT 0%
- System sam dobiera typ na podstawie kontrahenta
- WYJĄTEK: klient z UE bez aktywnego VIES (np. stowarzyszenie) któremu user chce
  wystawiać NORMALNĄ FV z VAT 23% mimo Unii. Gdy user to mówi ("to stowarzyszenie",
  "wystawiaj z VAT 23", "23% mimo UE", "dawaj normalną FV") → najpierw set_vat_mode
  {contractorSearch lub nip, mode:"domestic"}, POTEM invoice_preview. Od tej pory
  system sam wystawia mu krajową 23% w EUR. Cofnięcie: set_vat_mode mode:"auto".
- ⛔ NIE "POPRAWIAJ" CELOWEGO 23%: gdy invoice_preview zwróci vatOverride=true
  (albo pole vatNote), to krajowa 23% dla klienta z UE jest ZAMIERZONA i POPRAWNA.
  NIE zgłaszaj tego jako błędu, NIE pisz że powinno być WDT 0%, NIE proponuj
  "naprawy" na 0%. Po prostu pokaż podgląd i na "tak"/"potwierdź" wystaw 23%.

KRÓTKIE POLECENIA UŻYTKOWNIKA (tak/ok/wyślij/potwierdź) — bez konkretów:
Najpierw wywołaj get_context aby zobaczyć ostatnią akcję (lastAction, lastInvoiceId, lastContractorId).
- lastAction="preview" + user "tak" → invoice_confirm
- lastAction="confirmed" + user "wyślij mailem" → email_draft_with_invoice z invoiceId=lastInvoiceId (KROK 1, czekaj na akcept)
- lastAction="email_draft" + user "tak/wyślij" → email_send_draft z draftId z poprzedniej odpowiedzi
- brak kontekstu → zapytaj usera co konkretnie chce

FLOW PACZKI WDT DLA KSIEGOWEJ (matched CMR + FV):

JEDEN flow: jpk_build_and_send. Build paczki + auto-wysylka do
DEFAULT_ACCOUNTANT_EMAIL w env. ZAWSZE dla:
  "zrob/zbuduj/przygotuj/wyslij paczke wdt"
  "paczka ksiegowej" / "paczka wdt za <miesiac>"

NIE pytaj o email — env decyduje. NIE pytaj o potwierdzenie. NIE dziel
na build+send osobno chyba ze user EXPLICIT podaje inny email
("wyslij paczke za maj na X@..." → wtedy zawolaj jpk_build_and_send
z {to:X}).

Bez year/month default = miesiac poprzedni.

POKAZUJ NIEDOPASOWANE FV:
Response zawiera unmatchedInvoices[] (FV WDT bez CMR — klient odbieral
osobiscie / inny kurier) i unmatchedOrders[] (CMR bez FV). ZAWSZE pokaz
liste user-owi gdy non-empty:
  "Paczka 2026-04 wyslana: 20 FV / 6 CMR / 14 bez listu:
   - 65/2026 Nuno Viegas Costa
   - 64/2026 HOLA OLA
   ..."

⚠ CONTINUATION PO BUDOWIE PACZKI:
Po jpk_build_package backend zapisuje do AgentContext lastAction=
'wdt_package_built' z period/year/month. Gdy kolejna wiadomosc user-a
to "wyslij na <email>" / "na <email>" / "wyslij ksiegowej <email>" BEZ
explicit period — NAJPIERW get_context, sprawdz czy lastAction=
'wdt_package_built' i timestamp <60min. Jak tak → jpk_send_package z
year+month z kontekstu + email z wiadomosci. NIE pytaj usera o jaki
miesiac chodzi, NIE deleguj do innego sub-agenta.

FLOW WYSTAWIENIA FV:
0. NAJPIERW find_contractor z dokładnym fragmentem nazwy którą user podał ("easy
   surf michał lussa" → search="easy surf"; "Awa Surf" → search="awa surf").
   Jak wynik EMPTY → NIE halucynuj danych. Zapytaj usera o NIP+adres,
   potem verify_nip i upsert_contractor żeby dodać do bazy. DOPIERO POTEM
   invoice_preview z contractorSearch=<dokladna nazwa z find_contractor.name>.
   Jak wynik 2+ → POKAŻ liste user-owi i zapytaj "Ktorego masz na mysli?".
1. invoice_preview z items+contractorSearch → response ma previewId, pozycje, suma
   TERMIN PŁATNOŚCI: gdy user poda termin (np. "30 dni", "termin 14 dni", "płatne 21 dni")
   → przekaż paymentDays=<liczba> do invoice_preview. Bez wzmianki → pomiń (backend da 7).
2. POKAŻ user-owi preview DOSŁOWNIE z odpowiedzi + previewId (w tym terminPlatnosci)
3. User mówi "tak"/"ok" → invoice_confirm (bez argumentów — bierze najnowszy preview)
4. Po confirm: response ma invoiceNumber, invoiceId. PDF idzie automatycznie na Telegram.

FLOW WYSYLANIA FV MAILEM (ZAWSZE 2 KROKI — NIGDY BEZPOSREDNIO):
Krok 1: email_draft_with_invoice({invoiceNumber, toEmail?, customNote?})
        → tworzy DRAFT, backend attachuje PDF + tlumaczy body na jezyk
        kontrahenta. Zwraca {draftId, from, to, subject, body, bodyPl,
        lang, langName, attachments:[{filename, sizeKB}]}.
Krok 2: POKAZ user-owi pelen draft DOSLOWNIE:
        "DRAFT MAILA (czeka na akceptacje):
         - Od: <from>
         - Do: <to>
         - Temat: <subject>
         - Zalacznik: <attachments[0].filename> (<attachments[0].sizeKB>KB)
         - Tresc (<langName>):
           <body>
         - Tlumaczenie PL:
           <bodyPl>
         DraftId: <draftId>
         Wyslac?"
Krok 3: User mowi "tak"/"wyslij"/"akceptuje" → email_send_draft({draftId})
        → response.ok=true, mail wyslany. Pokaz confirm blok.

NIGDY NIE WYSYLAJ BEZ KROKU 2+3. NIGDY nie uzywaj invoice_send_email
(tool usuniety). Jak user mowi "wyslij FV 88 mailem" / "zalacz FV 88
i wyslij" → ZAWSZE krok 1 (email_draft_with_invoice), pokaz draft,
czekaj na potwierdzenie. Bez potwierdzenia NIE wolaj email_send_draft.

ATTACH FV NA ZAWOLANIE:
Gdy user mowi "zalacz fakture 88" / "wyslij maila z FV 88" / "FV 88
mailem do klienta" — to wprost oznacza krok 1 z invoiceNumber:"88".
Backend zatachuje PDF do draftu i pokaze blok "Zalacznik:
Faktura_88_2026.pdf" — user widzi ze PDF bedzie w mailu. Po
confirm: draft idzie z attachem.

Gdy FV byla wystawiona przed chwila (lastAction='confirmed' w
get_context), "wyslij to mailem" oznacza krok 1 z invoiceId =
lastInvoiceId.

CUSTOM NOTE W DRAFCIE:
User mowi "wyslij FV 88 i napisz 'zgodnie z naszą rozmową'" → krok 1
z customNote:"zgodnie z naszą rozmową". Note wkleja sie do body
w jezyku kontrahenta. NIE zmieniaj sam body — backend lokalizuje.

CONTACT SEARCH (Marco, Anna, Pedro etc):
Gdy user pisze "wystaw FV dla Marco" / "FV dla Marco ze sklepu":
Marco to imie KONTAKTU (osoby z extras.contacts[].name), NIE nazwa
firmy. find_contractor zwraca tez matche po extras.contacts[].name
(matchedBy='contact'). Jak find_contractor zwroci kilku pasujacych:
  → POKAZ liste numerowana ("1. Sklep X (kontakt Marco), 2. Sklep Y
    (kontakt Marco)") i zapytaj usera ktorego ma na mysli.
  → Gdy user odpowie "1" / "ten pierwszy" / "Sklep X" — uzyj
    contractorId z pozycji 1 z poprzedniej listy.
NIE wybieraj losowo. NIE halucynuj. NIE proponuj nazw firm ktorych
nie ma w find_contractor response.

⚠ DODAWANIE KONTRAHENTA — ZAWSZE PRZEKAZUJ POSTCODE:
Gdy uzywasz upsert_contractor PO verify_nip:
  - verify_nip zwraca PELNY adres np. "Warszawska 5/18, 11-500 Gizycko"
  - WYCIAGNIJ z tego: address="Warszawska 5/18", postCode="11-500", city="Gizycko"
  - PRZEKAZ WSZYSTKO do upsert_contractor (name, nip, address, postCode, city, country)
  - BEZ postCode iFirma odrzuci FV! To NAJCZESTSZA przyczyna bledow.
  - Jak user pisze "tak podaj" / "wpisz sam" / "uzupelnij" → MASZ DANE z verify_nip,
    UZYJ ICH zamiast pytac usera ponownie.

⚠ POTWIERDZENIE = ZAWSZE WYWOŁAJ NARZĘDZIE NA NOWO:
Gdy user potwierdza wystawienie ("tak"/"potwierdź"/"dawaj") — ZAWSZE faktycznie
wywołaj invoice_confirm. NIGDY nie odpowiadaj z pamięci "to się nie uda / było
odrzucone" na podstawie wcześniejszych prób. Wcześniejsze błędy mogły zostać
naprawione (kod pocztowy, typ faktury, waluta) — spróbuj REALNIE jeszcze raz i
dopiero z aktualnej odpowiedzi API mów czy się udało (pokaż invoiceNumber albo
prawdziwy komunikat błędu z tej próby).

⚠ FLOW NAPRAWY KONTRAHENTA W IFIRMIE (auto-recovery):
Gdy invoice_confirm / invoice_preview zwroci blad z iFirmy o danych
kontrahenta — najczesciej "Niepoprawny kod pocztowy" / "Brak ulicy" /
"Niepoprawna nazwa" / "Kod 201" — sekwencja naprawy:

1. find_contractor({search: <NIP albo nazwa>}) — zobacz co my mamy w bazie
2. ifirma_contractor_get({nip: <NIP>}) — zobacz co iFirma ma TERAZ
3. Porownaj polo po polu (Nazwa/NIP/Ulica/KodPocztowy/Miejscowosc/Kraj):
   a) Brakuje pola w iFirmie a my mamy → ifirma_contractor_sync({contractorId})
      → potem RETRY invoice_confirm
   b) My tez nie mamy → ZAPYTAJ user-a o brakujace pole
   c) Mamy oba ale rozne → zaufaj naszej bazie, sync, retry

Pelny przyklad:
  iFirma odrzuca: "Niepoprawny kod pocztowy"
  -> find_contractor("Pozo Winds") -> {id:"abc...", postCode:"11-500"}
  -> ifirma_contractor_get("PL123...") -> {KodPocztowy:""}
  -> ifirma_contractor_sync({contractorId:"abc..."})
  -> invoice_confirm
  -> SUCCESS

NIGDY nie pomijaj tej naprawy ciszej — pokaz user-owi co naprawiles
("dolozylem kod pocztowy 11-500 do iFirmy, ponawiam FV").

ZASADA — NIGDY NIE HALUCYNUJ KONTRAHENTA:
Gdy user pisze "wystaw FV na <X>" a Ty nie wiesz kto to "X" → ZAWSZE
find_contractor. NIGDY nie wybieraj losowo "AWA SURF" jak user pisze "Easy
Surf" — to dwie rozne firmy. Jak find_contractor zwroci 0 → NIE wystawiaj,
zapytaj o NIP.

DOSTAWA / DELIVERY JAKO POZYCJA:
Gdy user mówi "dodaj delivery za 18 EUR" / "doliczy dostawę 25 PLN" / "wysyłka 30 zł":
Dodaj do items kolejną pozycję z type="delivery", name="Delivery" (lub "Dostawa"), qty=1, price=<kwota>.
NIE szukaj "delivery" w katalogu produktów — backend automatycznie obsłuży jako usługę transportową
(no GTU, Jednostka="usł.", standardowy VAT 23% dla krajowej / 0% NP dla WDT).

Przykład: "Wystaw fv dla Nuno 5 boxów sticków i delivery 18 EUR":
  items=[
    { name: "stick box", qty: 5 },
    { name: "Delivery", qty: 1, price: 18, type: "delivery" }
  ]

PONOWNE WYSŁANIE PDF FAKTURY NA TELEGRAM:
SŁOWO "DAJ" = "wyślij PDF na Telegrama" (tu, do mnie). To NIE jest listing/search/preview.
- "daj fv 65" / "daj fakturę 65/2026" / "przyślij fv 65" / "ponownie pdf 64/2026"
  / "wyślij fv 65 tu" / "daj mi pdf faktury X"
  → send_invoice_pdf_telegram z invoiceNumber: "65" (backend automatycznie
    rozszerzy do "65/2026", bieżący rok)
- NIE rób disambiguacji ("Znalazłem 3 faktury z '65'") — backend bierze
  najświeższą z bieżącego roku. Jeśli user wprost chce inną ("daj 65/2025"),
  poda pełen numer.
- Wysłanie mailem do klienta to email_draft_with_invoice + email_send_draft (2 kroki, z akceptacją) — różne od "daj".

ZASADY:
- ZAWSZE wywołuj tool przy nowym żądaniu — nie kopiuj odpowiedzi z historii
- response.error → pokaż DOSŁOWNIE, NIE zgaduj przyczyn
- response.ok=false z suggestions → pokaż user-owi listę żeby wybrał
- NIE zmyślaj wartości / cen / numerów faktur — wszystko z odpowiedzi tool
- response.confirmation → POKAŻ KAŻDE POLE DOSŁOWNIE z API (to jest twardy dowód że akcja się odbyła). Po email_send_draft pokaż blok z faktycznymi wartościami:
  "Wysłane ✓
   - Z: <from>
   - Do: <to>
   - Temat: <subject>
   - DraftId: <emailId>
   - MessageId: <messageId>"
  NIE pisz "wysłałem" bez bloku confirmation. NIE wymyślaj messageId. Jeśli messageId=null napisz "MessageId: brak (SMTP nie zwrócił)".
- Po email_draft_with_invoice ZAWSZE pokaz pelen draft (Od/Do/Temat/Zalacznik/Tresc/Tlumaczenie PL/DraftId) i zapytaj "Wyslac?" — NIGDY nie wolaj email_send_draft samemu.
- Plain text, listy z "-", krótko bez wstępów

╔══════════════════════════════════╗
║ PRZYPOMNIENIE — DZIS: {{TODAY}}    ║
║ "ten rok" / "tym roku" = {{YEAR}}  ║
║ NIE {{LAST_YEAR}}, NIE 2024.       ║
╚═══════════════════════════════════╝`;

const tools = [
  {
    name: 'find_contractor',
    description: 'Wyszukaj kontrahenta w lokalnej bazie po nazwie / fragmencie / NIP. Fuzzy match. ZAWSZE wywołuj PRZED invoice_preview gdy user podaje kontrahenta po nazwie — żeby NIE halucynować danych. Zwraca tablice ContractorList (max 10) — agent wybiera prawdziwy match.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Nazwa, fragment, NIP albo combo. Min 2 znaki.' },
        limit: { type: 'number', description: 'Max wynikow (default 10)' },
      },
      required: ['search'],
    },
  },
  {
    name: 'verify_nip',
    description: 'Sprawdz NIP w GUS/VIES (zwraca status czynny + nazwa firmy + adres). Uzyj przed upsert_contractor gdy user podal NIP nowego klienta. WAZNE: pole status = "valid" (aktywny), "invalid" (NA PEWNO nieaktywny) albo "unknown"/valid=null (VIES kraju chwilowo niedostepny lub limit — to NIE znaczy ze NIP jest bledny). Przy "unknown" NIE pisz ze NIP nieaktywny: przekaz tresc pola message i zaproponuj zapis mimo to lub ponowienie.',
    input_schema: {
      type: 'object',
      properties: {
        nip: { type: 'string' },
        country: { type: 'string', description: 'ISO-2, opcjonalne. Bez = PL.' },
      },
      required: ['nip'],
    },
  },
  {
    name: 'set_vat_mode',
    description: 'Ustaw tryb VAT kontrahenta. UZYJ gdy user mowi ze klient z UE ma byc fakturowany NORMALNA FV z VAT 23% mimo Unii (np. "to stowarzyszenie", "wystawiaj mu z VAT 23", "nie ma aktywnego VIES, dawaj normalna FV", "23% mimo UE"). mode="domestic" -> zawsze krajowa VAT 23% (w EUR). mode="auto" -> przywroc domyslne (WDT 0% gdy UE + aktywny VIES). Podaj contractorSearch (nazwa) albo nip albo contractorId.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string', description: 'Nazwa kontrahenta (lub fragment).' },
        nip: { type: 'string', description: 'NIP/VAT kontrahenta (alternatywa).' },
        contractorId: { type: 'string', description: 'UUID kontrahenta (alternatywa).' },
        mode: { type: 'string', description: '"domestic" (zawsze 23% VAT) albo "auto" (domyslne WDT 0% dla UE).' },
      },
      required: ['mode'],
    },
  },
  {
    name: 'upsert_contractor',
    description: 'Dodaj/zaktualizuj kontrahenta (po NIP lub nazwie). Wywoluj PO verify_nip albo gdy user podaje dane. Sluzy TEZ do: dopisania emaila do istniejacego kontrahenta oraz skojarzenia DOMENY firmowej (gdy user mowi "dodaj adres X i domene" / "maile z tej domeny lacz z tym kontrahentem"). Podaj wtedy name (istniejacego) + email i/lub domain. Domena firmowa (np. euromipe.com) sprawia, ze KAZDY przyszly mail z tej domeny linkuje sie do tego kontrahenta. Gmail/free domeny sa ignorowane (nie kojarzymy). Po zapisie auto-push do iFirmy. Zwraca contractor.id.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' }, nip: { type: 'string' },
        type: { type: 'string', description: 'BUSINESS lub PERSON. Default BUSINESS.' },
        country: { type: 'string', description: 'Kraj (Polska, ES, DE, itd.)' },
        city: { type: 'string', description: 'Miasto (np. "Gizycko")' },
        address: { type: 'string', description: 'Ulica + numer (np. "ul. Jagielly 1A")' },
        postCode: { type: 'string', description: 'Kod pocztowy. PL: format "11-500". ES: "35600". WAZNE: ZAWSZE wyciagnij z wiadomosci user-a jak jest podany — bez kodu pocztowego iFirma odrzuca FV (Pole Kontrahent.KodPocztowy jest wymagane).' },
        email: { type: 'string' }, phone: { type: 'string' },
        domain: { type: 'string', description: 'OPCJONALNE: domena firmowa do skojarzenia (np. "euromipe.com"). Maile z tej domeny beda linkowane do tego kontrahenta. Mozna podac sam adres email — domena zostanie wyciagnieta. Gmail/free sa ignorowane.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'ifirma_contractor_get',
    description: 'Pobierz dane kontrahenta JAK JE WIDZI IFIRMA (po NIP). DIAGNOSTYKA gdy invoice_confirm sie sypie z bledem o brakujacych polach kontrahenta (np. "Niepoprawny kod pocztowy", "Brak ulicy"). Zwraca {Nazwa, NIP, Ulica, KodPocztowy, Miejscowosc, Kraj, Email, Telefon, Identyfikator} jak iFirma trzyma TERAZ. Porownaj z find_contractor zeby zobaczyc czy nasza baza ma to czego brakuje.',
    input_schema: {
      type: 'object',
      properties: {
        nip: { type: 'string', description: 'NIP kontrahenta (z prefiksem ISO PL... lub bez)' },
      },
      required: ['nip'],
    },
  },
  {
    name: 'ifirma_contractor_sync',
    description: 'WYMUS push danych kontrahenta z naszej lokalnej bazy do iFirmy. Czyta Contractor + primary ContractorAddress (billing) + extras.billingAddress, sklada pelen payload i wola PUT iFirma. AUTO-FIX po blędzie wystawiania FV: gdy ifirma_contractor_get pokaze brakujace lub stare pole, ktore my mamy w bazie — wywolaj ten tool, potem RETRY invoice_confirm.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string', description: 'UUID kontrahenta z naszej lokalnej bazy (z find_contractor.id)' },
      },
      required: ['contractorId'],
    },
  },
  {
    name: 'invoice_preview',
    description: 'Podgląd faktury przed wystawieniem. Szuka kontrahenta po nazwie (fuzzy), rozwija boxy MIX, sprawdza ceny z cennika. ZAWSZE użyj gdy user prosi o wystawienie faktury — pokaż preview, czekaj na "tak". UWAGA: PRZED invoice_preview użyj find_contractor żeby zweryfikować że to wlasciwy kontrahent — fuzzy match w invoice_preview moze trafic w nie tego co user mial na mysli.',
    input_schema: {
      type: 'object',
      properties: {
        contractorSearch: { type: 'string', description: 'Nazwa lub fragment nazwy kontrahenta' },
        contractorId: { type: 'string', description: 'UUID kontrahenta (gdy znany dokładnie — pomija fuzzy search)' },
        items: {
          type: 'array',
          description: 'Lista pozycji faktury — każda z {name LUB ean, qty, opcjonalnie priceNetto/priceBrutto}. Dla dostawy/transportu dodaj pozycję z type="delivery" + price (omija lookup w katalogu produktów).',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Nazwa produktu (np. "stick generic", "mascara pink") lub dostawy ("Delivery", "Dostawa")' },
              ean: { type: 'string', description: 'EAN konkretnego produktu lub box (np. "BOX-STICK-30")' },
              qty: { type: 'number', description: 'Ilość sztuk (dla delivery zwykle 1)' },
              priceNetto: { type: 'number', description: 'Cena netto per szt (opcjonalne)' },
              priceBrutto: { type: 'number', description: 'Cena brutto per szt (opcjonalne)' },
              type: { type: 'string', enum: ['delivery', 'shipping', 'dostawa'], description: 'Typ pozycji — gdy "delivery"/"shipping"/"dostawa" backend pomija katalog produktów i dodaje jako usługę transportową (no GTU, Jednostka="usł."). Wymaga price/priceNetto/priceBrutto.' },
            },
          },
        },
        globalPriceNetto: { type: 'number', description: 'Cena netto dla wszystkich pozycji (gdy user mówi "po X netto")' },
        globalPriceBrutto: { type: 'number', description: 'Cena brutto dla wszystkich pozycji' },
        paymentDays: { type: 'number', description: 'Termin płatności w dniach. Default 7. User mówi "30 dni" → 30, "termin 14 dni" → 14. Bez wzmianki — pomiń (backend da 7).' },
      },
      required: ['items'],
    },
  },
  {
    name: 'invoice_confirm',
    description: 'Potwierdza i wystawia ostatnio przygotowaną fakturę z preview. Bez argumentów — bierze najnowszy preview z agentContext (do 30 min).',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'email_draft_with_invoice',
    description: 'KROK 1 wysylki FV mailem. Tworzy DRAFT maila z PDF faktury w zalaczniku + tresc przetlumaczona na jezyk kontrahenta. NIE WYSYLA. Po tym toolu MUSISZ pokazac user-owi pelen draft (Od/Do/Temat/Zalacznik/body w jezyku odbiorcy/tlumaczenie PL) i CZEKAC na potwierdzenie. Zwraca {draftId, from, to, subject, body, bodyPl, lang, langName, attachments}. Akceptuje invoiceNumber ("88", "88/2026") LUB invoiceId (UUID). toEmail opcjonalne (default: contractor.primaryEmail/email). customNote opcjonalne — dodatkowa linia w body (np. "zgodnie z rozmowa").',
    input_schema: {
      type: 'object',
      properties: {
        invoiceNumber: { type: 'string', description: 'Numer faktury, np. "88" (rok dolozy backend) lub "88/2026"' },
        invoiceId: { type: 'string', description: 'UUID faktury (alternatywa do invoiceNumber)' },
        toEmail: { type: 'string', description: 'Email odbiorcy. Opcjonalne — bez = contractor.primaryEmail z bazy.' },
        customNote: { type: 'string', description: 'Dodatkowa tresc do body draftu (np. "Zgodnie z naszą rozmową telefoniczną"). Backend wstawi przed podpisem.' },
      },
    },
  },
  {
    name: 'email_send_draft',
    description: 'KROK 2 wysylki FV mailem. Wysyla wczesniej przygotowany DRAFT (po akceptacji user-a). Argument draftId z email_draft_with_invoice response. Bez akceptacji user-a NIE WOLAJ TEGO TOOL-a.',
    input_schema: {
      type: 'object',
      properties: {
        draftId: { type: 'string', description: 'UUID draftu z email_draft_with_invoice response' },
      },
      required: ['draftId'],
    },
  },
  {
    name: 'list_products',
    description: 'Lista produktów i boxów z cenami i EAN-ami. Użyj gdy user pyta "co mamy w ofercie", "jakie ceny", "lista produktów".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'expand_box',
    description: 'Rozwija box (BOX-STICK-30 / BOX-MASCARA-30 / BOX-COLLECTION-30) na pozycje składowe z ilościami. Użyj gdy user pyta "co jest w boxie X".',
    input_schema: {
      type: 'object',
      properties: {
        ean: { type: 'string', description: 'EAN boxa: BOX-STICK-30, BOX-MASCARA-30, BOX-COLLECTION-30' },
        qty: { type: 'number', description: 'Ile boxów (mnoży skład); domyślnie 1' },
      },
      required: ['ean'],
    },
  },
  {
    name: 'ifirma_sync',
    description: 'Synchronizuj faktury z iFirma za wybrany miesiąc. Pobiera, tworzy brakujących kontrahentów, aktualizuje statusy płatności.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Rok np. 2026 (opcjonalne — domyślnie bieżący)' },
        month: { type: 'number', description: 'Miesiąc 1-12 (opcjonalne — domyślnie bieżący)' },
      },
    },
  },
  {
    name: 'analytics',
    description: 'Uniwersalna analiza danych firmy. Pytaj o cokolwiek: obroty, przeterminowane faktury, statystyki sprzedaży, sumy. Pytanie po polsku.',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'Pytanie po polsku' },
      },
      required: ['question'],
    },
  },
  {
    name: 'create_deal',
    description: 'Utwórz nowy deal/szansę sprzedaży dla kontrahenta. Wymaga contractorId.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string' },
        notes: { type: 'string', description: 'Opis deala' },
        value: { type: 'number' },
        currency: { type: 'string', enum: ['PLN', 'EUR'] },
      },
      required: ['contractorId'],
    },
  },
  {
    name: 'open_consignment',
    description: 'Otwórz nowy komis dla kontrahenta. Wymaga contractorId.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string' },
        notes: { type: 'string' },
      },
      required: ['contractorId'],
    },
  },
  {
    name: 'send_invoice_pdf_telegram',
    description: 'Wyślij PDF faktury na Telegrama. Użyj gdy user prosi "daj mi pdf faktury X na telegram", "wyślij FV X tu", "ponownie pdf 64/2026". Akceptuje invoiceId (UUID), invoiceNumber (np. "64/2026") albo ifirmaId (numer iFirma).',
    input_schema: {
      type: 'object',
      properties: {
        invoiceId: { type: 'string', description: 'UUID faktury w naszej bazie' },
        invoiceNumber: { type: 'string', description: 'Pełny numer faktury, np. "64/2026"' },
        ifirmaId: { type: 'number', description: 'ID faktury w iFirma (gdy znamy)' },
      },
    },
  },
  {
    name: 'get_context',
    description: 'Pobierz kontekst poprzedniej operacji księgowej (lastAction, lastInvoiceId, lastContractorId itp.). Wywołaj gdy dostajesz krótkie polecenie bez konkretu (tak/ok/wyślij/potwierdź) — żeby wiedzieć do czego się odnosi. Wraca {lastAction, savedAt, ...szczegóły}.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'analytics_products_sold',
    description: 'Sprzedaz per produkt w okresie. Bez ean -> top-N EANow w okresie (sort po qty desc). Z ean -> time series. ZAWSZE wywolaj dla pytan "ile sztuk", "ile sprzedalismy X", "top produkty". Currency split PL/ES osobno.',
    input_schema: {
      type: 'object',
      properties: {
        ean: { type: 'string' },
        from: { type: 'string', description: 'YYYY-MM-DD. Bez = rok temu.' },
        to: { type: 'string', description: 'YYYY-MM-DD. Bez = dzisiaj.' },
        country: { type: 'string' }, limit: { type: 'number' },
        source: { type: 'string', description: 'pl|es lub pomin dla obu' },
        granularity: { type: 'string', description: 'day|week|month|quarter|year (tylko z ean)' },
      },
    },
  },
  {
    name: 'analytics_revenue',
    description: 'Obroty per okres+currency+source. ZAWSZE dla "ile zarobilismy / obroty / przychod".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        country: { type: 'string' }, currency: { type: 'string' },
        source: { type: 'string' },
        granularity: { type: 'string' },
      },
    },
  },
  {
    name: 'analytics_top_customers',
    description: 'Top N klientow po total_revenue (sortowanie numeryczne desc). ZAWSZE dla "top klienci / ranking / kto najwiecej".',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string' }, to: { type: 'string' },
        year: { type: 'number' },
        country: { type: 'string' }, limit: { type: 'number' }, source: { type: 'string' },
      },
    },
  },
  {
    name: 'jpk_build_and_send',
    description: 'Paczka WDT za miesiac: matchuje FV WDT z listami GK (CMR), nazwany numerami FV, zbiorczy PDF, wysyla mailem do ksiegowej (DEFAULT_ACCOUNTANT_EMAIL z env). JEDEN call. ZAWSZE uzywaj dla: "zrob/zbuduj/przygotuj/wyslij paczke wdt", "paczka ksiegowej", "paczka wdt za maj/kwiecien". Bez year/month = poprzedni miesiac. BEZ pytania user-a o email — env decyduje.',
    input_schema: {
      type: 'object',
      properties: {
        year: { type: 'number', description: 'Default: rok poprzedniego miesiaca.' },
        month: { type: 'number', description: 'Default: poprzedni miesiac (1-12).' },
        to: { type: 'string', description: 'Override domyslnej ksiegowej (rzadko — user explicit "wyslij na X").' },
      },
    },
  },
  {
    name: 'jpk_list_packages',
    description: 'Lista wszystkich miesiecznych paczek WDT (status: building/ready/sent). Dla "pokaz paczki ksiegowej", "jakie sa paczki".',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'jpk_package_details',
    description: 'Szczegoly konkretnej paczki za miesiac (lista FV, lista CMR, dopasowania, unmatched). period format YYYY-MM np. "2026-04".',
    input_schema: {
      type: 'object',
      properties: {
        period: { type: 'string', description: 'YYYY-MM format' },
      },
      required: ['period'],
    },
  },
];

const ENDPOINT_MAP = {
  invoice_preview: ['POST', '/api/ifirma/invoice-preview'],
  invoice_confirm: ['POST', '/api/ifirma/invoice-confirm-latest'],
  email_draft_with_invoice: ['POST', '/api/emails/draft-with-invoice'],
  email_send_draft: ['POST', '/api/send-email/:draftId/confirm'],
  list_products: ['GET', '/api/products'],
  expand_box: ['GET', '/api/products/expand-box'], // qty/ean as query
  ifirma_sync: ['POST', '/api/ifirma/sync'],
  analytics: ['POST', '/api/analytics'],
  create_deal: ['POST', '/api/deals'],
  open_consignment: ['POST', '/api/consignments/open'],
  send_invoice_pdf_telegram: ['POST', '/api/ifirma/resend-pdf-telegram'],
  get_context: ['GET', '/api/agent-context/ksiegowosc'],
  find_contractor: ['GET', '/api/contractors'],
  verify_nip: ['POST', '/api/contractors/verify-nip'],
  upsert_contractor: ['POST', '/api/contractors/upsert'],
  set_vat_mode: ['POST', '/api/contractors/vat-mode'],
  ifirma_contractor_get: ['GET', '/api/ifirma/contractors/:nip'],
  ifirma_contractor_sync: ['POST', '/api/ifirma/contractors/sync/:contractorId'],
  analytics_products_sold: ['GET', '/api/analytics/products-sold'],
  analytics_revenue: ['GET', '/api/analytics/revenue'],
  analytics_top_customers: ['GET', '/api/analytics/top-customers'],
  jpk_build_and_send: ['POST', '/api/jpk/build-and-send'],
  jpk_list_packages: ['GET', '/api/jpk/packages'],
  jpk_package_details: ['GET', '/api/jpk/package/:period'],
};

const executeTool = buildExecuteTool({
  endpointMap: ENDPOINT_MAP,
  logPrefix: '[accounting-agent]',
});

// Force tool choice when intent is unambiguous to suppress LLM hallucination.
const PREVIEW_INTENT = /\b(wystaw|zr[oó]b|przygotuj) (fakt|fv)|\b(faktur|fv) (dla|na)/i;
const CONFIRM_INTENT = /^\s*(tak|ok|potwierdz|akceptu|zgadzam|jasne|dobra)\b|\bpotwierd[zź]\s+(fakt|fv|ostatni|preview)/i;
const SEND_INVOICE_INTENT = /\bwy[sś]lij (fakt|fv) (mailem|mejlem|do)|\bfakt\w* mailem\b/i;
const PDF_TELEGRAM_INTENT =
  /\btelegram\w*\b[\s\S]*\b(pdf|fakt\w*|fv)\b/i      // explicit "telegram" + invoice keyword
  .source + '|' +
  /\b(pdf|fakt\w*|fv)\b[\s\S]*\btelegram\w*\b/i.source + '|' +
  // "daj fv X" / "daj fakturę X" / "daj mi fv X" — short user phrase meaning
  // "send the invoice PDF here on Telegram" (NOT search, NOT email).
  /\bdaj\s+(?:mi\s+)?(?:pdf\s+)?(?:fv|fakt\w*)\b/i.source;
const PDF_TELEGRAM_INTENT_RE = new RegExp(PDF_TELEGRAM_INTENT, 'i');
const SYNC_INTENT = /\bsynchron|\bsync\b|zsynchronizuj/i;
const ANALYTICS_INTENT = /\bobr[oó]t|przetermin|statystyk|raport|ile (mam|jest|wystawiono)|suma fakt/i;

async function processAccountingQuery(query, ctx = {}) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const yearStr = todayStr.slice(0, 4);
  const dateContextPrefix = `[KONTEKST: Dzisiejsza data: ${todayStr}. Biezacy rok: ${yearStr}. "Tym roku" / "Ten rok" / "This year" = ${yearStr}. Dla analytics ZAWSZE uzyj from=${yearStr}-01-01 to=${todayStr} jak user pyta "tym roku" / "this year".]\n\n`;
  const messages = [{ role: 'user', content: dateContextPrefix + query }];
  let forcedTool = null;
  // Order matters: confirm beats preview when both could match (e.g. "tak wystaw fakturę"
  // is rare; but typical "tak" alone is confirm).
  if (CONFIRM_INTENT.test(query) && !PREVIEW_INTENT.test(query)) forcedTool = 'invoice_confirm';
  else if (PDF_TELEGRAM_INTENT_RE.test(query)) forcedTool = 'send_invoice_pdf_telegram';
  // "wyslij FV X mailem" → ZAWSZE krok 1 (draft), nigdy bezposrednia wysylka.
  // User musi zaakceptowac draft osobnym poleceniem -> dopiero wtedy email_send_draft.
  else if (SEND_INVOICE_INTENT.test(query)) forcedTool = 'email_draft_with_invoice';
  else if (SYNC_INTENT.test(query)) forcedTool = 'ifirma_sync';
  else if (ANALYTICS_INTENT.test(query)) forcedTool = 'analytics';
  else if (PREVIEW_INTENT.test(query)) forcedTool = 'invoice_preview';

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: buildSystemPrompt(),
    tools: buildTools(),
    tool_choice: forcedTool ? { type: 'tool', name: forcedTool } : { type: 'auto' },
    messages,
  });

  let iterations = 0;
  const MAX_ITER = 5;
  while (response.stop_reason === 'tool_use' && iterations < MAX_ITER) {
    iterations++;
    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const toolResultBlocks = [];
    for (const tu of toolUseBlocks) {
      console.log(`[accounting-agent] tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
      const result = await executeTool(tu.name, tu.input, ctx);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'assistant', content: sanitizeAssistantContent(response.content) });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: buildSystemPrompt(),
      tools: buildTools(),
      messages,
    });
  }

  const textBlock = response.content.find(b => b.type === 'text');
  return {
    text: textBlock ? textBlock.text : '',
    iterations,
    stopReason: response.stop_reason,
  };
}

module.exports = { processAccountingQuery };
