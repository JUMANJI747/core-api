'use strict';

const https = require('https');

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const data = JSON.stringify(body);
    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: JSON.parse(text) }); }
        catch (e) { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function parseOrderWithLLM(text, contractorName, catalog) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.log('[order-llm] ANTHROPIC_API_KEY not set');
    return null;
  }

  // Lista NASZYCH produktów (ean | nazwa wariant) — model ma mapować pozycje
  // zamówienia na nasz katalog (jak klikanie naszych guzików), a nie przepisywać
  // nazwy z zamówienia. Bez tego preview zwracał "product not found".
  const catalogText = Array.isArray(catalog) && catalog.length
    ? catalog.map(p => `- ${p.ean} | ${[p.name, p.variant].filter(Boolean).join(' ')}`).join('\n')
    : '';

  const prompt = `Przeanalizuj tekst dokumentu i wyciągnij dane zamówienia.

Zwróć TYLKO czysty JSON (bez markdown, bez komentarzy):
{
  "isOrder": true/false,
  "orderNumber": "numer zamówienia lub null",
  "items": [
    {
      "name": "NASZA nazwa z katalogu (nazwa + wariant), NIE nazwa z zamówienia",
      "ean": "EAN z NASZEGO katalogu (dokładnie jak niżej) lub null gdy brak dopasowania",
      "qty": liczba_sztuk,
      "priceNetto": cena_jednostkowa_netto_lub_null,
      "totalNetto": wartosc_netto_pozycji_lub_null,
      "totalBrutto": wartosc_brutto_pozycji_lub_null
    }
  ],
  "totalNetto": suma_netto_lub_null,
  "totalBrutto": suma_brutto_lub_null,
  "currency": "PLN/EUR",
  "vatRate": stawka_vat_lub_null,
  "buyerName": "nazwa zamawiającego lub null",
  "buyerNip": "NIP zamawiającego lub null",
  "notes": "uwagi, termin realizacji itp. lub null"
}

WAŻNE — mapuj na NASZ katalog (tak jakbyś klikał nasze guziki, NIE przepisuj nazw z zamówienia):
- Każdą pozycję zamówienia dopasuj do DOKŁADNIE JEDNEGO produktu z katalogu poniżej — po znaczeniu/kolorze/typie, nie po dosłownej nazwie (np. "Surf Extreme Waterproof Gel" → nasz Surf Gel; "Lip Balm SPF 50" → nasz Surf Lip Balm; kolory sticków/mascary dopasuj do wariantu).
- Zwróć NASZ "ean" i NASZĄ nazwę z katalogu (nazwa + wariant).
- NIGDY nie łącz dwóch różnych produktów w jedną pozycję. "X & Y", "X + Y", "X i Y" to DWIE osobne pozycje.
- Ilości i ceny bierz z zamówienia. Jeśli pozycji NIE da się dopasować do katalogu — ustaw ean=null i zostaw oryginalną nazwę (użytkownik poprawi ręcznie).
- Jeśli tekst zawiera sekcję "[AKTUALNY MAIL — POZYCJE BIERZ STĄD]": pozycje bierz WYŁĄCZNIE z niej. Sekcje "[KONTEKST]" służą tylko do rozszyfrowania skrótów/cen — pozycje z kontekstu bierz TYLKO, gdy aktualny mail nie zawiera ŻADNYCH pozycji.
- CYTOWANA starsza korespondencja wewnątrz maila (fragmenty po "Am ... schrieb", "W dniu ... napisał(a)", "On ... wrote", linie zaczynające się od ">") to NIE jest aktualne zamówienie — pozycji z niej NIE bierz.

NASZ KATALOG (ean | nazwa wariant):
${catalogText || '(katalog niedostępny — rozpoznaj: Surf Stick Blue/Pink/Purple/Mint/White/Skin, Surf Girl Mascara Blue/Mint/Pink/Black, Surf Gel, Surf Daily, Surf Care, Surf Lip Balm)'}

Jeśli dokument NIE jest zamówieniem — zwróć {"isOrder": false}.

${contractorName ? `Kontrahent (z nadawcy maila): ${contractorName}\n\n` : ''}TEKST DOKUMENTU:
${text}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await httpsPost('https://api.anthropic.com/v1/messages', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }, {
        model: process.env.ORDER_PARSER_MODEL || 'claude-sonnet-4-5-20250929',
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }],
      });

      const isOverloaded = resp.body && resp.body.error && resp.body.error.type === 'overloaded_error';
      if (isOverloaded && attempt < 2) {
        console.log('[order-llm] Overloaded, retrying in 3s...');
        await new Promise(r => setTimeout(r, 3000));
        continue;
      }

      if (resp.status !== 200) {
        console.log('[order-llm] API error:', resp.status, JSON.stringify(resp.body).slice(0, 200));
        return null;
      }

      const content = (resp.body.content && resp.body.content[0] && resp.body.content[0].text) || '';
      const clean = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const parsed = JSON.parse(clean);
      if (parsed && parsed.isOrder && Array.isArray(parsed.items) && parsed.items.length > 0) {
        return { ...parsed, hasItems: true, parsedBy: 'llm' };
      }
      return parsed && parsed.isOrder === false ? null : (parsed || null);
    } catch (err) {
      console.log('[order-llm] Error attempt', attempt, ':', err.message);
      if (attempt >= 2) return null;
    }
  }
  return null;
}

module.exports = { parseOrderWithLLM };
