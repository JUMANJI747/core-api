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

async function parseOrderWithLLM(text, contractorName) {
  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    console.log('[order-llm] ANTHROPIC_API_KEY not set');
    return null;
  }

  const prompt = `Przeanalizuj tekst dokumentu i wyciągnij dane zamówienia.

Zwróć TYLKO czysty JSON (bez markdown, bez komentarzy):
{
  "isOrder": true/false,
  "orderNumber": "numer zamówienia lub null",
  "items": [
    {
      "name": "pełna nazwa produktu",
      "qty": liczba_sztuk,
      "ean": "kod EAN 13 cyfr lub null",
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

Produkty SurfStickBell rozpoznaj jako: Surf Stick (kolory: Blue/Pink/Purple/Mint/White/Skin), Surf Girl Mascara (kolory: Blue/Mint/Pink/Black), Surf Gel, Surf Daily, Surf Care, Surf Lip Balm.

Jeśli dokument NIE jest zamówieniem — zwróć {"isOrder": false}.

${contractorName ? `Kontrahent (z nadawcy maila): ${contractorName}\n\n` : ''}TEKST DOKUMENTU:
${text}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await httpsPost('https://api.anthropic.com/v1/messages', {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      }, {
        model: 'claude-sonnet-4-20250514',
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
