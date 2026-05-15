'use strict';

const { sendMail, findAccount, getAccounts } = require('../mail-sender');
const { buildTrackingUrl } = require('./tracking-urls');

const DEFAULT_FROM = process.env.TRACKING_NOTIFY_FROM || 'delivery@surfstickbell.com';

// Country → email language. Falls back to EN.
const LANG_BY_COUNTRY = {
  PL: 'pl', DE: 'de', AT: 'de', CH: 'de',
  FR: 'fr', BE: 'fr', LU: 'fr',
  ES: 'es', NL: 'nl', PT: 'pt', IT: 'it',
};

// Short friendly tracking-notification copy per language. User-facing tone
// is intentionally casual (Surf Stick Team brand voice) — no formal sign-off.
const TEMPLATES = {
  pl: {
    subject: 'Twoje Surf Sticki są już w drodze',
    body: (link, carrier, number) =>
`Cześć!

Twoja paczka jest już w drodze. Możesz ją śledzić tutaj:
${link || '(link niedostępny)'}
Kurier: ${carrier || '—'}${number ? ', numer: ' + number : ''}

Słonecznego dnia,
Surf Stick Team`,
  },
  en: {
    subject: 'Your Surf Sticks are on their way',
    body: (link, carrier, number) =>
`Hey!

Your package is on its way. You can track it here:
${link || '(tracking link unavailable)'}
Carrier: ${carrier || '—'}${number ? ', tracking #: ' + number : ''}

Sunny days,
Surf Stick Team`,
  },
  de: {
    subject: 'Deine Surf Sticks sind unterwegs',
    body: (link, carrier, number) =>
`Hi!

Dein Paket ist unterwegs. Du kannst es hier verfolgen:
${link || '(Tracking-Link nicht verfügbar)'}
Kurier: ${carrier || '—'}${number ? ', Sendungsnummer: ' + number : ''}

Sonnige Tage,
das Surf Stick Team`,
  },
  fr: {
    subject: 'Tes Surf Sticks sont en route',
    body: (link, carrier, number) =>
`Salut !

Ton colis est en route. Tu peux le suivre ici :
${link || '(lien de suivi indisponible)'}
Transporteur : ${carrier || '—'}${number ? ', numéro : ' + number : ''}

Belle journée ensoleillée,
l'équipe Surf Stick`,
  },
  es: {
    subject: 'Tus Surf Sticks están en camino',
    body: (link, carrier, number) =>
`¡Hola!

Tu paquete está en camino. Puedes seguirlo aquí:
${link || '(enlace de seguimiento no disponible)'}
Transportista: ${carrier || '—'}${number ? ', número: ' + number : ''}

Día soleado,
el equipo Surf Stick`,
  },
  it: {
    subject: 'I tuoi Surf Stick sono in viaggio',
    body: (link, carrier, number) =>
`Ciao!

Il tuo pacco è in viaggio. Puoi tracciarlo qui:
${link || '(link di tracciamento non disponibile)'}
Corriere: ${carrier || '—'}${number ? ', numero: ' + number : ''}

Buona giornata di sole,
il Surf Stick Team`,
  },
  nl: {
    subject: 'Je Surf Sticks zijn onderweg',
    body: (link, carrier, number) =>
`Hoi!

Je pakket is onderweg. Je kunt het hier volgen:
${link || '(volglink niet beschikbaar)'}
Vervoerder: ${carrier || '—'}${number ? ', volgnummer: ' + number : ''}

Zonnige dag,
het Surf Stick Team`,
  },
  pt: {
    subject: 'Os teus Surf Sticks estão a caminho',
    body: (link, carrier, number) =>
`Olá!

A tua encomenda está a caminho. Podes segui-la aqui:
${link || '(link de seguimento indisponível)'}
Transportadora: ${carrier || '—'}${number ? ', número: ' + number : ''}

Dia ensolarado,
a equipa Surf Stick`,
  },
};

function pickLang(country) {
  if (!country) return 'en';
  return LANG_BY_COUNTRY[String(country).toUpperCase()] || 'en';
}

// Compose subject + body for the given delivery context.
function compose({ country, trackingNumber, carrier, trackingUrl }) {
  const t = TEMPLATES[pickLang(country)] || TEMPLATES.en;
  return { subject: t.subject, body: t.body(trackingUrl, carrier, trackingNumber) };
}

// Send the notification. Best-effort — caller should not await unless the
// reply depends on it. Returns { ok, error?, sent? } so the orchestrator
// (e.g. /api/send-tracking-email) can surface details.
async function sendTrackingNotification({ toEmail, country, trackingNumber, carrier, from, prisma }) {
  if (!toEmail) return { ok: false, error: 'no recipient email' };
  if (!trackingNumber) return { ok: false, error: 'no tracking number' };
  const trackingUrl = buildTrackingUrl(carrier, trackingNumber);
  const { subject, body } = compose({ country, trackingNumber, carrier, trackingUrl });

  // Sender: explicit override → delivery@ if configured in IMAP_ACCOUNTS →
  // first account. We accept that delivery@ might not exist on every setup.
  let fromEmail = from || DEFAULT_FROM;
  if (!findAccount(fromEmail)) {
    const accounts = getAccounts();
    fromEmail = (accounts[0] && accounts[0].user) || fromEmail;
  }

  try {
    const saved = await sendMail({ from: fromEmail, to: toEmail, subject, body });
    return { ok: true, sent: { from: fromEmail, to: toEmail, subject, messageId: saved && saved.messageId, trackingUrl } };
  } catch (e) {
    console.error('[tracking-notify] send failed:', e.message);
    return { ok: false, error: e.message };
  }
}

module.exports = { compose, pickLang, sendTrackingNotification };
