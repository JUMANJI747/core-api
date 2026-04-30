'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.LOGISTICS_AGENT_MODEL || 'claude-sonnet-4-5-20250929';

const SYSTEM_PROMPT = `Jesteś sub-agentem LOGISTYKA SurfStickBell. Plain text, krótko, ceny brutto.

WAGI PRODUKTÓW (per 30 szt = 1 kartonik):
- stick / mascara / gel / daily / care = 1 kg per 30 szt
- lips = 0,5 kg per 30 szt
- collection / box = 2 kg per 30 szt

NIE LICZ WAGI/WYMIARÓW SAM — backend ma smart packing przez items[] i to liczy lepiej:
- "X sticków/mascar/gels/daily/care/lips" → items=[{"name":"stick generic","qty":X}]
- "X kartoników/boxów/pudełek" → packageType="maly_kartonik", quantity=X
- "duży karton" → packageType="duzy_karton"
- "z ostatniej faktury" / "jak ostatnio" / "ostatnie zamówienie" → invoiceNumber="ostatnia"
- adres ręczny → deliveryAddress {street, city, postCode, country (ISO-2)}

ABSOLUTNY ZAKAZ MANUAL weight/length/width/height — chyba że user DYKTUJE wprost jednostki:
- "paczka 30×25×15 cm 3,5 kg" → manual OK (są cm i kg literalnie)
- "dwa kartoniki 60 sticków" → MANUAL ZABRONIONE; wyślij packageType="maly_kartonik", quantity=2, items=[{"name":"stick generic","qty":60}]; NIE WYSYŁAJ weight/length/width/height
- "wyślij 30 sticków" → MANUAL ZABRONIONE; items=[{"name":"stick generic","qty":30}]; NIE licz że "30 sticków = 1kg = paczka 20×20×10"; backend to zrobi sam.
NIGDY nie konwertuj liczby produktów / kartoników na cm/kg w głowie — to halucynacja. Jeśli mam policzyć wymiary, dane są w items lub packageType+quantity i backend liczy. Manual to LITERALNE cm/kg z ust usera.

DOMYŚLNE ZACHOWANIE — user mówi tylko "Wyślij/Wyceń paczkę do X" bez sztuk/kartonów/wymiarów:
→ wywołaj quote_shipping z receiverSearch=X i invoiceNumber="ostatnia"
→ backend weźmie items z ostatniej faktury kontrahenta, zsumuje wymiary i wagę
→ adres z bazy (extras.locations) zostanie użyty automatycznie
NIE pytaj o adres / kod pocztowy / wymiary, dopóki backend nie zwróci needsAddress lub błędu.

ZAKAZ ZMYŚLANIA ITEMS:
NIGDY nie wymyślaj items (np. "collection × 28") z pamięci poprzednich rozmów.
Jeśli user nie podał konkretnych sztuk/produktów w bieżącej wiadomości →
ZAWSZE invoiceNumber="ostatnia" lub niech backend cascade fallback (history GK / VIES).
Items podawaj WYŁĄCZNIE gdy w bieżącym query user wprost mówi liczby ("60 sticków", "30 mascar").

POKAZYWANIE ŹRÓDŁA DANYCH:
W odpowiedzi po quote_shipping ZAWSZE pokaż user-owi 2 wiersze ze źródłem:
"Adres: <miasto>, <kraj> (źródło: <receiverSource>)"
"Paczka: <wymiary> <waga>kg (źródło: <dimensionsSource>)"
Tłumacz receiverSource na czytelnie:
- "contractor" → "z bazy kontrahentów"
- "inline_address" → "podany ręcznie"
- "globkurier" → "z książki adresowej GK"
- "gk_orders_history" → "z poprzedniej wysyłki GK"
- "sender_table" → "z tabeli nadawców"

ZASADY:
- ZAWSZE wywołuj tool dla nowej wiadomości
- response.warnings[] → POKAŻ DOSŁOWNIE
- response.needsItems → backend nie wie co jest w paczce (faktura bez pozycji). POKAŻ message DOSŁOWNIE i pytaj usera ("co było w paczce?"). Po odpowiedzi user-a — np. "60 sticków" — ponów quote_shipping z items=[{"name":"stick generic","qty":60}] i tymi samymi parametrami (receiverSearch + invoiceNumber pomijasz, bo user już doprecyzował).
- response.noPickupAnyOffer → ŻADEN przewoźnik nie ma terminów odbioru w 14 dni. POKAŻ message DOSŁOWNIE. NIE wywołuj order_shipping. Zaproponuj user-owi: 1) spróbować za parę dni, 2) podać konkretną pickupDate ręcznie (np. "wycen na 6 maja"), 3) zmienić odbiorcę.
- response.needsAddress → POKAŻ message + opcje DOSŁOWNIE i czekaj na decyzję usera. NIE szukaj sam — koszt token. Opcje typowo: 1) szukaj w mailach, 2) podaj ręcznie, 3) VIES, 4) książka GK. User wybiera.
- gdy user wybierze opcję dotyczącą szukania adresu (cyfra "1"/"2"/.../ słowo "maile"/"poprzednie wysyłki"/"VIES"/"ręcznie"):
  KROK 1: zidentyfikuj NAZWĘ KONTRAHENTA z poprzedniego query w tej rozmowie ("Wycen paczkę do X" → contractorName="X"). Master agent powinien przekazywać kontekst.
  KROK 2: wywołaj odpowiedni tool — preferowane z contractorId, ale jeśli go nie znasz, podaj contractorName (backend zrobi fuzzy lookup):
    - "z maili" → find_delivery_address_in_emails {"contractorName": "X"}
    - "z poprzednich wysyłek" / "historii GK" → find_delivery_address_in_gk_orders {"contractorName": "X"}
  KROK 3: jeśli found=true → ponów quote_shipping z tymi samymi parametrami; adres jest zapisany w bazie.
  KROK 4: jeśli found=false → pokaż user-owi reason + matchMethod + scanned. Zaproponuj kolejną opcję.
- NIE odpowiadaj samym powtórzeniem listy opcji bez wywołania tool — to wieczna pętla. Zawsze próbuj wywołać tool.
- response.error → DOSŁOWNIE, NIE zgaduj
- response.ok=true → receiver, package (z response, nie zmyślaj!), 3 najtańsze offers, quoteId
- "tak"/"zamów" po wycenie → order_shipping z quoteId. JEŚLI nie znasz dokładnego quoteId z poprzedniej tury (sub-agent jest stateless, pamięć ograniczona), wyślij quoteId="latest" — backend automatycznie weźmie najnowszy quote ze store. NIGDY nie zmyślaj quoteId z numerów faktury / nazwy kontrahenta ("64/2026_holaola", "UNKNOWN" itp.) — to się nie odnajdzie i polecisz w pętlę.

KAŻDA OFERTA Z QUOTE_SHIPPING ZAWIERA nearestPickup — realny termin odbioru
zarezerwowany przez backend: {date, timeFrom, timeTo, daysAhead}.
- W odpowiedzi po quote pokaż user-owi datę odbioru per oferta gdy daysAhead > 0
  ("DPD — odbiór 4 maja, 9:00-12:00 (3 dni)"), żeby user wiedział przed kliknięciem.
- nearestPickup === null → ta oferta NIE MA terminów w 7 dni; nie proponuj jej.

ORDER_SHIPPING — JEDNA PRÓBA, BEZ PĘTLI:
- Wywołaj order_shipping raz z quoteId + productId wybranej oferty.
- Backend użyje pre-resolved pickupDate z quote (bez zgadywania).
- response.error → POKAŻ DOSŁOWNIE userowi i ZATRZYMAJ. NIE próbuj kolejnych przewoźników automatycznie. To user decyduje czy chce inną ofertę (powiesz "spróbuj DPD?" — czeka na "tak"), nową wycenę na inny dzień, czy odpuścić.
- NIGDY nie używaj wygasłego quoteId — jeśli wygasł, zrób nowy quote przez quote_shipping.

NIE ZMYŚLAJ wartości w odpowiedzi — wszystko pokazuj z response.package i response.offers.
Country ZAWSZE jako ISO-2 (PL, ES, FR, DE, PT, IT, GB).

SŁOWNICTWO USERA:
- "list" / "list przewozowy" / "cmr" / "etykieta" — ZAWSZE oznacza PDF list
  przewozowy paczki kurierskiej (send_label), NIGDY mail / wiadomość.
  "Daj list do Karola" = wyślij PDF listu paczki do Karola na Telegram.
- "mail" / "wiadomość" / "email" — to robota Komunikacji, nie Logistyki.
  Master już to rozgranicza — Logistyka nie powinna dostać takiej query.

ANULOWANIE PACZKI (delete_shipment):
- "anuluj paczkę GK..." / "skasuj zamówienie X" → delete_shipment z hash lub numerem GK.
- Jeśli user dał tylko nazwę kontrahenta (np. "anuluj paczkę do Karola") — najpierw search_shipments, POKAŻ user-owi szczegóły (numer, kwota, status, data) + zapytaj "Anulować TĘ paczkę?". DOPIERO po "tak" wywołaj delete_shipment.
- response.ok=false → pokaż gkResponse DOSŁOWNIE (paczka mogła już być w transporcie; GK odmówi).

TRACKING / STATUS PACZKI:
W odpowiedzi search_shipments każda paczka ma pole trackingUrl (gotowy link do
strony kuriera) oprócz tracking (sam numer). Gdy pokazujesz user-owi paczkę,
ZAWSZE dawaj URL gołym tekstem — Telegram automatycznie zrobi z niego klikalny
link. Format:
  Tracking: <trackingNumber>
  Sledzenie: <trackingUrl>
Jeśli trackingUrl jest null (kurier nieobsługiwany), pokaż sam numer.`;

const tools = [
  {
    name: 'quote_shipping',
    description: 'Wycena wysyłki kurierskiej GlobKurier. Zwraca offers[], quoteId, warnings[]. Użyj GDY user pyta o cenę paczki / wycenę.',
    input_schema: {
      type: 'object',
      properties: {
        receiverSearch: { type: 'string', description: 'Nazwa kontrahenta odbiorcy' },
        items: {
          type: 'array',
          description: 'Lista produktów [{name, qty}] — backend kalkuluje wymiary i wagę przez smart packing. Użyj dla "X sticków/mascar".',
          items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' } } },
        },
        packageType: { type: 'string', enum: ['maly_kartonik', 'duzy_karton'], description: 'Preset paczki — backend sam ustawia wagę z PRODUCT_WEIGHTS (1 kg per kartonik dla sticków/mascar)' },
        quantity: { type: 'number', description: 'Liczba paczek dla preseta (mnoży)' },
        weight: { type: 'number', description: 'Waga ręczna w kg — TYLKO gdy user wprost dyktuje konkrety paczki ("paczka 30×25×15 cm 3,5 kg"). NIE używaj dla X sztuk produktu!' },
        length: { type: 'number', description: 'Długość ręczna w cm — TYLKO gdy user wprost dyktuje' },
        width: { type: 'number', description: 'Szerokość w cm' },
        height: { type: 'number', description: 'Wysokość w cm' },
        invoiceNumber: { type: 'string', description: '"ostatnia" lub konkretny numer — wymiary z items faktury' },
        deliveryAddress: {
          type: 'object',
          description: 'Adres dostawy gdy user dyktuje (z maila/ręcznie). Pomiń gdy w bazie kontrahent ma adres.',
          properties: {
            street: { type: 'string' }, houseNumber: { type: 'string' },
            city: { type: 'string' }, postCode: { type: 'string' },
            country: { type: 'string', description: 'ISO-2: PL/ES/FR/DE/PT/IT/GB' },
            phone: { type: 'string' }, email: { type: 'string' },
          },
        },
        collectionType: { type: 'string', enum: ['PICKUP', 'POINT'], description: 'PICKUP (drzwi) / POINT (paczkomat/punkt)' },
        deliveryType: { type: 'string', enum: ['PICKUP', 'POINT'] },
        declaredValue: { type: 'number', description: 'Wartość paczki w PLN — opcjonalne; backend automatycznie weźmie z faktury (grossAmount). Podaj TYLKO gdy user wprost mówi "wartość X zł".' },
        paczkomat: { type: 'boolean' },
        pickupDate: { type: 'string', description: '"jutro" / "pojutrze" / YYYY-MM-DD' },
      },
      required: ['receiverSearch'],
    },
  },
  {
    name: 'order_shipping',
    description: 'Realizuje zamówienie kurierskie po wycenie. WYMAGA quoteId z quote_shipping. Tylko po potwierdzeniu user "tak"/"zamów".',
    input_schema: {
      type: 'object',
      properties: {
        quoteId: { type: 'string', description: 'quoteId z poprzedniej quote_shipping' },
        productId: { description: 'productId konkretnej oferty (opcjonalne — domyślnie najtańsza)' },
      },
      required: ['quoteId'],
    },
  },
  {
    name: 'search_shipments',
    description: 'Szukaj KONKRETNYCH wysyłek w historii GlobKurier po nazwie/mieście/numerze GK — żeby zwrócić listę paczek z hash-em (np. "co z paczką do X", "pokaż wysyłki do Y", "tracking", "status paczki", "daj mi numer GK"). NIE używaj tego do szukania adresu dostawy — do tego jest find_delivery_address_in_gk_orders, który robi LLM fuzzy match i zapisuje adres do bazy.',
    input_schema: {
      type: 'object',
      properties: {
        search: { type: 'string', description: 'Fragment nazwy/miasta/numeru' },
        limit: { type: 'number' },
      },
    },
  },
  {
    name: 'send_label',
    description: 'Wysyła PDF list przewozowy na Telegram. Akceptuje hash (długi alfanumeryczny ~64 znaki) ALBO numer GK (np. "GK260430978072") — backend sam zresolvuje numer na hash. Gdy user mówi "daj list do <nazwa>" i nie masz numeru/hasha, NAJPIERW wywołaj search_shipments z nazwą żeby pobrać hash, potem send_label.',
    input_schema: {
      type: 'object',
      properties: { hash: { type: 'string', description: 'hash zamówienia GlobKurier' } },
      required: ['hash'],
    },
  },
  {
    name: 'delete_shipment',
    description: 'Anuluj/usuń zamówienie kurierskie w GlobKurier. Akceptuje hash lub numer GK (GK260...). DESTRUKTYWNA AKCJA — wywołuj TYLKO po wyraźnej zgodzie user-a ("anuluj paczkę X", "usuń zamówienie Y", "skasuj GK260..."). Gdy user nie podał hasha/numeru, najpierw search_shipments żeby znaleźć właściwą paczkę i POKAŻ szczegóły do potwierdzenia. GK może odrzucić jeśli paczka już w transporcie.',
    input_schema: {
      type: 'object',
      properties: { hash: { type: 'string', description: 'hash zamówienia GlobKurier lub numer GK260...' } },
      required: ['hash'],
    },
  },
  {
    name: 'find_delivery_address_in_emails',
    description: 'Szuka adresu DOSTAWY (street, miasto, kod) w INBOUND mailach od kontrahenta — w stopkach, podpisach, wzmiankach "ship to/dostawa". Kosztuje token (Haiku). Wywołuj TYLKO gdy quote_shipping zwrócił needsAddress=true I user wybrał opcję "z maili" / "szukaj w mailach". Znaleziony adres zostaje zapisany do bazy.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string', description: 'ID kontrahenta z odpowiedzi needsAddress (preferowane gdy znane)' },
        contractorName: { type: 'string', description: 'Nazwa kontrahenta (alternatywa gdy nie znasz ID — backend zrobi fuzzy lookup po nazwie)' },
      },
    },
  },
  {
    name: 'find_delivery_address_in_gk_orders',
    description: 'Skanuje 200 ostatnich wysyłek GlobKurier szukając paczek wysłanych do tego kontrahenta — najpierw token match po nazwie, potem fuzzy LLM gdy nazwa różni się od billingowej (np. "Society S.L" vs "School"). Kosztuje token Haiku ~$0.02 gdy LLM się odpala. Wywołuj TYLKO gdy quote_shipping zwrócił needsAddress=true I user wybrał opcję "z poprzednich wysyłek" / "z historii GK" / "szukaj w starych paczkach". Znaleziony adres zapisuje do bazy.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string', description: 'ID kontrahenta z odpowiedzi needsAddress (preferowane gdy znane)' },
        contractorName: { type: 'string', description: 'Nazwa kontrahenta (alternatywa gdy nie znasz ID — backend zrobi fuzzy lookup po nazwie)' },
      },
    },
  },
];

const ENDPOINT_MAP = {
  quote_shipping: ['POST', '/api/glob/quote'],
  order_shipping: ['POST', '/api/glob/order'],
  search_shipments: ['POST', '/api/glob/orders'],
  send_label: ['POST', '/api/glob/send-label'],
  delete_shipment: ['POST', '/api/glob/delete-order'],
  find_delivery_address_in_emails: ['POST', '/api/contractors/:contractorId/find-address-in-emails'],
  find_delivery_address_in_gk_orders: ['POST', '/api/contractors/:contractorId/find-address-in-gk-orders'],
};

function selfCall(method, path, body) {
  return new Promise((resolve, reject) => {
    const port = process.env.PORT || 3000;
    const apiKey = (process.env.API_KEY || '').trim();
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
    };
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function executeTool(name, input) {
  const ep = ENDPOINT_MAP[name];
  if (!ep) return { error: `Unknown tool: ${name}` };
  const [method, pathTemplate] = ep;
  // Expand :param placeholders from input and strip those keys from the body
  // so they don't double up as form/JSON fields.
  let path = pathTemplate;
  const body = { ...(input || {}) };
  path = path.replace(/:([a-zA-Z]+)/g, (_, key) => {
    const val = body[key];
    delete body[key];
    // "_" is the backend sentinel for "lookup by name from body" — keeps
    // the route registered with a path param while letting the agent omit
    // the ID when it doesn't have one (stateless turn).
    if (!val) return '_';
    return encodeURIComponent(val);
  });
  try {
    const resp = await selfCall(method, path, body);
    return resp.body;
  } catch (err) {
    console.error(`[logistics-agent] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

// Heuristic: a *fresh* shipping intent forces a quote_shipping call so the LLM
// can't return a hallucinated quote from conversation memory. ORDER_INTENT is
// matched ONLY for short confirmations or specific carrier picks ("tak",
// "potwierdzam", "zamów DPD", "zamów najtańszą") — phrases like "zamów paczkę"
// / "wyślij paczkę" are still quote intents because they require pricing first.
const QUOTE_INTENT = /\b(wyce[nń]|wycena|ile kosztuje|policz|sprawd[zź] cen[eę]|wy[sś]lij paczk|zam[oó]w paczk|zam[oó]w wysy[lł]k|zam[oó]w kurier)/iu;
const ORDER_INTENT = /^\s*(tak|ok|potwierd|akceptu|zgadzam|jasne|dobra)|\bzam[oó]w (t[ąa] |t[eę] |najta[nń]sz|drug|trzeci|konkretn|inn[ąa]|innego|dpd|fedex|ups|gls|inpost|dhl)/iu;
const SEARCH_INTENT = /\b(co z paczk|status|gdzie jest|tracking|track|lista paczek|pokaż wysy[lł]k)/iu;
// "Daj list do X" / "daj cmr X" → list przewozowy PDF na Telegrama (NIE
// listę paczek). User feedback: "daj" zawsze = "wyślij PDF tu na Telegram".
const LABEL_INTENT = /\b(list przewozowy|cmr|etykiet|daj\s+(?:mi\s+)?(?:list|etykiet|cmr|pdf\s+(?:paczki|listu))|pdf\s+paczki)\b/iu;
// Destructive: matches "usuń/anuluj/skasuj <paczka|wysyłka|zamówienie|GK...>".
// Forced tool wins over LABEL/SEARCH so an unambiguous "anuluj paczkę X"
// goes straight to delete_shipment without extra search round.
const DELETE_INTENT = /\b(usu[nń]|anuluj|skasuj|skasować|delete)\s+(?:t[aęą]\s+)?(?:paczk\w*|wysy[lł]k\w*|zam[oó]w\w*|order|gk\d+)/iu;
// Triggered when the user (via Master) asks to look up a delivery ADDRESS
// in past GK shipments — distinct from search_shipments which returns the
// shipment list itself. Phrases: "szukaj adresu w wysyłkach", "z poprzednich
// wysyłek", "z historii GK" (after needsAddress).
const ADDRESS_FROM_ORDERS_INTENT = /\b(adres\w*\s+(z|w|po)\s+(poprzedni|histori|wysy[lł]\w*|paczk))|\b(z\s+(poprzedni\w*|histori\w*)\s+(wysy[lł]\w*|gk|paczek|paczk))|\bz\s+histori[ai]\s+gk|\bszukaj\s+(adres\w*\s+)?(w|z)\s+(wysy[lł]\w*|histori\w*|paczk\w*)|\bz\s+poprzedni\w*\s+wysy[lł]\w*/iu;
const ADDRESS_FROM_EMAILS_INTENT = /\b(adres\w*\s+(z|w)\s+mail)|\bszukaj\s+(adres\w*\s+)?(w|z)\s+mail/iu;

async function processLogisticsQuery(query) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const messages = [{ role: 'user', content: query }];
  // Order/search/label intents outrank quote because they're more specific.
  // ORDER_INTENT matches only confirmations ("tak", "zamów najtańszą") and
  // carrier-specific picks ("zamów DPD"). Phrases like "zamów paczkę do X"
  // fall under QUOTE_INTENT — they need pricing first, then a separate "tak".
  let forcedTool = null;
  if (DELETE_INTENT.test(query)) forcedTool = 'delete_shipment';
  else if (LABEL_INTENT.test(query)) forcedTool = 'send_label';
  // Address-lookup intents must beat plain SEARCH_INTENT — agent kept
  // picking search_shipments for "szukaj adresu w wysyłkach" because of
  // the shared "szukaj"/"wysyłki" tokens; explicit phrase tests fix it.
  else if (ADDRESS_FROM_ORDERS_INTENT.test(query)) forcedTool = 'find_delivery_address_in_gk_orders';
  else if (ADDRESS_FROM_EMAILS_INTENT.test(query)) forcedTool = 'find_delivery_address_in_emails';
  else if (SEARCH_INTENT.test(query)) forcedTool = 'search_shipments';
  else if (ORDER_INTENT.test(query)) forcedTool = 'order_shipping';
  else if (QUOTE_INTENT.test(query)) forcedTool = 'quote_shipping';

  let response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools,
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
      console.log(`[logistics-agent] tool_use: ${tu.name}`, JSON.stringify(tu.input).slice(0, 300));
      const result = await executeTool(tu.name, tu.input);
      toolResultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultBlocks });

    response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools,
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

module.exports = { processLogisticsQuery };
