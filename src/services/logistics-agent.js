'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const http = require('http');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = process.env.LOGISTICS_AGENT_MODEL || 'claude-sonnet-4-20250514';

const SYSTEM_PROMPT = `Jesteś sub-agentem LOGISTYKA SurfStickBell. Plain text, krótko, ceny brutto.

JAK MAPOWAĆ POLECENIA NA quote_shipping:
- "X sticków/mascar/gels" → items=[{"name":"stick generic","qty":X}] — backend smart-packing
- "X kartoników/boxów/pudełek" → packageType="maly_kartonik", quantity=X
- "duży karton" → packageType="duzy_karton"
- "z ostatniej faktury" / "ostatnie zamówienie" → invoiceNumber="ostatnia"
- "wymiary 30x20x20 2kg" → weight, length, width, height (TYLKO gdy user wprost dyktuje)
- adres ręczny → deliveryAddress {street, city, postCode, country (ISO-2)}

NIGDY nie wysyłaj manual weight/length/width/height GDY user mówi o sztukach produktów lub kartonikach — backend sam policzy lepiej.

ZASADY:
- ZAWSZE wywołuj tool dla nowej wiadomości — nigdy nie kopiuj odpowiedzi z historii
- response.warnings[] → POKAŻ WSZYSTKIE DOSŁOWNIE
- response.needsAddress → pokaż message + options[] DOSŁOWNIE, czekaj na wybór
- response.error → pokaż DOSŁOWNIE, NIE zgaduj przyczyn
- response.ok=true → pokaż receiver, package, 3 najtańsze offers, quoteId, "zamówić najtańszą?"
- "tak"/"zamów" po wycenie → order_shipping z quoteId

Country ZAWSZE jako ISO-2 (PL, ES, FR, DE, PT, IT, GB).
Mieszanie trybów (items + packageType + manual dims) → wybierz JEDEN.`;

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
        packageType: { type: 'string', enum: ['maly_kartonik', 'duzy_karton'], description: 'Preset paczki' },
        quantity: { type: 'number', description: 'Liczba paczek dla preseta (mnoży)' },
        weightPerPackage: { type: 'number', description: 'Waga per paczka w kg dla preseta' },
        weight: { type: 'number', description: 'Waga ręczna w kg — TYLKO gdy user wprost dyktuje wymiary' },
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
];

const ENDPOINT_MAP = {
  quote_shipping: ['POST', '/api/glob/quote'],
  order_shipping: ['POST', '/api/glob/order'],
  search_shipments: ['POST', '/api/glob/orders'],
  send_label: ['POST', '/api/glob/send-label'],
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
  const [method, path] = ep;
  try {
    const resp = await selfCall(method, path, input);
    return resp.body;
  } catch (err) {
    console.error(`[logistics-agent] tool ${name} error:`, err.message);
    return { error: err.message };
  }
}

// Heuristic: a *fresh* quote intent forces a quote_shipping call so the LLM
// can't return a hallucinated quote from conversation memory. We deliberately
// EXCLUDE order/search/label intents — those have their own dedicated tools
// and forcing quote_shipping would be wrong.
const QUOTE_INTENT = /\b(wycen|wycena|ile kosztuje|policz|sprawdź cenę)/i;
const ORDER_INTENT = /\b(zam[oó]w|potwier|tak,? wyślij|tak,? zam[oó]w)/i;
const SEARCH_INTENT = /\b(co z paczk|status|gdzie jest|szukaj wysy[lł]k|histori|lista paczek)/i;
const LABEL_INTENT = /\b(list przewozowy|cmr|etykiet|daj list|pdf paczki)/i;

async function processLogisticsQuery(query) {
  if (!process.env.ANTHROPIC_API_KEY) {
    return { text: 'ANTHROPIC_API_KEY nie skonfigurowany.', error: 'no_api_key' };
  }
  if (!query || typeof query !== 'string') {
    return { text: 'Brak query.', error: 'no_query' };
  }

  const messages = [{ role: 'user', content: query }];
  // Force a specific tool when the intent is unambiguous to suppress
  // memory-based hallucination. Order/search/label outrank quote because
  // "zamów" usually follows a quote and shouldn't re-quote.
  let forcedTool = null;
  if (ORDER_INTENT.test(query)) forcedTool = 'order_shipping';
  else if (LABEL_INTENT.test(query)) forcedTool = 'send_label';
  else if (SEARCH_INTENT.test(query)) forcedTool = 'search_shipments';
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
