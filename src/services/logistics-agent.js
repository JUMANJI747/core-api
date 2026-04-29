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

KIEDY UŻYWAĆ MANUAL weight/length/width/height:
- TYLKO gdy user wprost dyktuje wymiary konkretnej paczki ("paczka 30×25×15 cm 3,5 kg")
- NIGDY nie wymyślaj wagi z liczby produktów — to robi backend (items[])
- NIGDY nie podawaj manual + items razem — backend zignoruje manual

ZASADY:
- ZAWSZE wywołuj tool dla nowej wiadomości
- response.warnings[] → POKAŻ DOSŁOWNIE
- response.needsAddress → POKAŻ message + opcje DOSŁOWNIE i czekaj na decyzję usera. NIE szukaj sam — koszt token. Opcje typowo: 1) szukaj w mailach, 2) podaj ręcznie, 3) VIES, 4) książka GK. User wybiera.
- gdy user wybierze "szukaj w mailach" / "spróbuj z maili" → wywołaj find_delivery_address_in_emails z contractorId z poprzedniego needsAddress; jeśli found=true → ponów quote_shipping z tymi samymi parametrami (adres jest zapisany, wycena teraz powinna pójść). Jeśli found=false → poinformuj usera czego nie znaleziono i zaproponuj inne źródła (VIES, manual).
- response.error → DOSŁOWNIE, NIE zgaduj
- response.ok=true → receiver, package (z response, nie zmyślaj!), 3 najtańsze offers, quoteId
- "tak"/"zamów" po wycenie → order_shipping z quoteId

GDY ORDER_SHIPPING zwraca błąd typu "brak terminów odbioru" / "no pickup":
- NIE pytaj usera ponownie — automatycznie spróbuj order_shipping z DRUGĄ ofertą z poprzedniej wyceny (productId tej drugiej)
- Jeśli druga też zawiedzie, spróbuj trzecią
- Wyjaśnij userowi dosłownie co padło: "FedEx odrzucił (brak terminów), zamówiłem DPD za 66,43 zł"
- NIGDY nie używaj wygasłego quoteId — jeśli wygasł, zrób nowy quote przez quote_shipping

NIE ZMYŚLAJ wartości w odpowiedzi — wszystko pokazuj z response.package i response.offers.
Country ZAWSZE jako ISO-2 (PL, ES, FR, DE, PT, IT, GB).`;

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
    description: 'Szukaj wysyłek w historii GlobKurier po nazwie odbiorcy/mieście/numerze GK.',
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
    description: 'Wysyła PDF list przewozowy na Telegram. WYMAGA hash zamówienia z search_shipments.',
    input_schema: {
      type: 'object',
      properties: { hash: { type: 'string', description: 'hash zamówienia GlobKurier' } },
      required: ['hash'],
    },
  },
  {
    name: 'find_delivery_address_in_emails',
    description: 'Szuka adresu DOSTAWY (street, miasto, kod) w INBOUND mailach od kontrahenta — w stopkach, podpisach, wzmiankach "ship to/dostawa". Kosztuje token (Haiku). Wywołuj TYLKO gdy quote_shipping zwrócił needsAddress=true I user wybrał opcję "z maili" / "szukaj w mailach". Znaleziony adres zostaje zapisany do bazy — nie trzeba go potem podawać ręcznie.',
    input_schema: {
      type: 'object',
      properties: {
        contractorId: { type: 'string', description: 'ID kontrahenta z odpowiedzi needsAddress' },
      },
      required: ['contractorId'],
    },
  },
];

const ENDPOINT_MAP = {
  quote_shipping: ['POST', '/api/glob/quote'],
  order_shipping: ['POST', '/api/glob/order'],
  search_shipments: ['POST', '/api/glob/orders'],
  send_label: ['POST', '/api/glob/send-label'],
  find_delivery_address_in_emails: ['POST', '/api/contractors/:contractorId/find-address-in-emails'],
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
    return encodeURIComponent(val || '');
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
const SEARCH_INTENT = /\b(co z paczk|status|gdzie jest|szukaj wysy[lł]k|histori|lista paczek)/iu;
const LABEL_INTENT = /\b(list przewozowy|cmr|etykiet|daj list|pdf paczki)/iu;

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
  if (LABEL_INTENT.test(query)) forcedTool = 'send_label';
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
