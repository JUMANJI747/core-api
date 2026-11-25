'use strict';

/* Treść odmowy GlobKuriera przy etykiecie (24.11.2026). Wcześniej każda odmowa
 * kończyła się „Label fetch failed", a panel pokazywał samo „HTTP 400" — nie było
 * wiadomo, czy etykieta jeszcze się generuje, czy zlecenie ma błąd. GK odpowiada
 * JSON-em ({message} / {error} / {errors: {pole: tekst}}) albo tekstem. */
function opisOdmowyGk(body) {
  const surowy = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  let j = null;
  try { j = JSON.parse(surowy); } catch (_) { /* tekst, nie JSON */ }
  const czesci = [];
  const dodaj = (v) => { if (v != null && String(v).trim()) czesci.push(String(v).trim()); };
  if (j && typeof j === 'object') {
    dodaj(j.message); dodaj(typeof j.error === 'string' ? j.error : null);
    const e = j.errors || j.fields;
    if (Array.isArray(e)) e.forEach(x => dodaj(typeof x === 'string' ? x : (x && (x.message || JSON.stringify(x)))));
    // „orderHashes[0]" to nazwa parametru zapytania, nie pole adresu — dla człowieka szum.
    else if (e && typeof e === 'object') for (const [k, v] of Object.entries(e)) dodaj(`${/^orderHashes/.test(k) ? '' : `${k}: `}${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  if (!czesci.length) dodaj(surowy.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 300));
  return [...new Set(czesci)].join('; ').slice(0, 400);
}

module.exports = { opisOdmowyGk };
