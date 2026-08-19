'use strict';

// Stopki per nadawca. Doklejane CENTRALNIE w mail-sender.sendMail — dzięki
// temu działają wszędzie: kompozytor CRM, windykacja (🔪), agent, każda inna
// ścieżka wysyłki z danej skrzynki. Marker chroni przed podwójnym doklejeniem
// (np. gdy user sam wpisał podpis albo mail to odpowiedź z cytatem stopki).

const NIKODEM_SIGNATURE = `--
Z Poważaniem/Kind Regards/Saludos

Nikodem Merlak Surf Stick Bell

WhatsApp/tel. +48 504 417 136
WhatsApp/tel. +34 624 46 48 33

Av. Magellanes 6 porta 2 piso 3 puerta 4
El Médano, Granadilla de Abona, Santa Cruz de Tenerife

https://surfstickbell.com/
FB: http://fb.com/surfstickbell
IG: @surfstickbell`;

const SIGNATURE_MARKER = 'Nikodem Merlak';

function getSignatureForFrom(from) {
  const f = String(from || '').toLowerCase().trim();
  if (f.startsWith('nikodem@') || f.startsWith('niko@')) return NIKODEM_SIGNATURE;
  return null;
}

module.exports = { getSignatureForFrom, SIGNATURE_MARKER };
