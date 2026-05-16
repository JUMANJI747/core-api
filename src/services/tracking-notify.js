'use strict';

const { sendMail, findAccount, getAccounts } = require('../mail-sender');
const { buildTrackingUrl } = require('./tracking-urls');
const { notifyMailResult } = require('./notify-mail-result');

const DEFAULT_FROM = process.env.TRACKING_NOTIFY_FROM || 'delivery@surfstickbell.com';

// Country → email language. Falls back to EN.
const LANG_BY_COUNTRY = {
  PL: 'pl', DE: 'de', AT: 'de', CH: 'de',
  FR: 'fr', BE: 'fr', LU: 'fr',
  ES: 'es', NL: 'nl', PT: 'pt', IT: 'it',
};

// Short friendly tracking-notification copy per language. User-facing tone
// is intentionally casual (Surf Stick Team brand voice) — no formal sign-off.
// Each entry returns BOTH plain text (text) and HTML (html with clickable
// <a href>). Clients that don't render HTML fall back to text automatically.
const TEMPLATES = {
  pl: {
    subject: 'Twoje Surf Sticki są już w drodze',
    intro: 'Cześć!',
    paragraph: 'Twoja paczka jest już w drodze. Możesz ją śledzić tutaj:',
    carrierLabel: 'Kurier',
    numberLabel: 'numer',
    signOff: 'Słonecznego dnia,\nSurf Stick Team',
  },
  en: {
    subject: 'Your Surf Sticks are on their way',
    intro: 'Hey!',
    paragraph: "Your package is on its way. You can track it here:",
    carrierLabel: 'Carrier',
    numberLabel: 'tracking #',
    signOff: 'Sunny days,\nSurf Stick Team',
  },
  de: {
    subject: 'Deine Surf Sticks sind unterwegs',
    intro: 'Hi!',
    paragraph: 'Dein Paket ist unterwegs. Du kannst es hier verfolgen:',
    carrierLabel: 'Kurier',
    numberLabel: 'Sendungsnummer',
    signOff: 'Sonnige Tage,\ndas Surf Stick Team',
  },
  fr: {
    subject: 'Tes Surf Sticks sont en route',
    intro: 'Salut !',
    paragraph: 'Ton colis est en route. Tu peux le suivre ici :',
    carrierLabel: 'Transporteur',
    numberLabel: 'numéro',
    signOff: "Belle journée ensoleillée,\nl'équipe Surf Stick",
  },
  es: {
    subject: 'Tus Surf Sticks están en camino',
    intro: '¡Hola!',
    paragraph: 'Tu paquete está en camino. Puedes seguirlo aquí:',
    carrierLabel: 'Transportista',
    numberLabel: 'número',
    signOff: 'Día soleado,\nel equipo Surf Stick',
  },
  it: {
    subject: 'I tuoi Surf Stick sono in viaggio',
    intro: 'Ciao!',
    paragraph: 'Il tuo pacco è in viaggio. Puoi tracciarlo qui:',
    carrierLabel: 'Corriere',
    numberLabel: 'numero',
    signOff: 'Buona giornata di sole,\nil Surf Stick Team',
  },
  nl: {
    subject: 'Je Surf Sticks zijn onderweg',
    intro: 'Hoi!',
    paragraph: 'Je pakket is onderweg. Je kunt het hier volgen:',
    carrierLabel: 'Vervoerder',
    numberLabel: 'volgnummer',
    signOff: 'Zonnige dag,\nhet Surf Stick Team',
  },
  pt: {
    subject: 'Os teus Surf Sticks estão a caminho',
    intro: 'Olá!',
    paragraph: 'A tua encomenda está a caminho. Podes segui-la aqui:',
    carrierLabel: 'Transportadora',
    numberLabel: 'número',
    signOff: 'Dia ensolarado,\na equipa Surf Stick',
  },
};

function pickLang(country) {
  if (!country) return 'en';
  return LANG_BY_COUNTRY[String(country).toUpperCase()] || 'en';
}

// Pre-send validation: confirm the shipment is actually trackable by the
// customer before we send them a link. Three checks:
//   1) trackingNumber must NOT be a GK internal id (GK260... → carrier
//      portals don't know it, page would say "no data").
//   2) Status must indicate the parcel is with the carrier (in transit,
//      delivered). 'Registered'/'awaiting pickup' means the courier hasn't
//      picked it up yet — link returns no data, customer gets confused.
//   3) Recipient name should match expected (best-effort substring check).
// Returns { ok: true } or { ok: false, reason } so the caller can log /
// surface a clear error instead of sending a broken link.
function validateShipmentReady({ trackingNumber, status, recvName, expectedName }) {
  if (!trackingNumber) return { ok: false, reason: 'no carrier tracking number assigned yet' };
  if (/^GK\d{9,}/i.test(String(trackingNumber).trim())) {
    return { ok: false, reason: `tracking number "${trackingNumber}" looks like a GK internal id, not a carrier tracking — wait for GK to populate the real number` };
  }
  const s = String(status || '').toLowerCase();
  const NOT_READY = ['register', 'zarejestrow', 'awaiting', 'pickup', 'oczek', 'nowe', 'new ', 'pre-shipment'];
  if (NOT_READY.some(t => s.includes(t))) {
    return { ok: false, reason: `status "${status}" indicates parcel is registered but not yet picked up by carrier — tracking page will show no data` };
  }
  if (expectedName && recvName) {
    const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
    if (!norm(recvName).includes(norm(expectedName).slice(0, 5)) && !norm(expectedName).includes(norm(recvName).slice(0, 5))) {
      return { ok: false, reason: `recipient mismatch — GK receiver "${recvName}" doesn't match expected "${expectedName}"` };
    }
  }
  return { ok: true };
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function compose({ country, trackingNumber, carrier, trackingUrl }) {
  const t = TEMPLATES[pickLang(country)] || TEMPLATES.en;
  const linkOrFallback = trackingUrl || '(tracking link unavailable)';
  const text = [
    t.intro,
    '',
    t.paragraph,
    linkOrFallback,
    `${t.carrierLabel}: ${carrier || '—'}${trackingNumber ? ', ' + t.numberLabel + ': ' + trackingNumber : ''}`,
    '',
    t.signOff,
  ].join('\n');

  const linkHtml = trackingUrl
    ? `<a href="${escapeHtml(trackingUrl)}">${escapeHtml(trackingUrl)}</a>`
    : escapeHtml(linkOrFallback);
  const htmlLines = [
    `<p>${escapeHtml(t.intro)}</p>`,
    `<p>${escapeHtml(t.paragraph)}<br>${linkHtml}</p>`,
    `<p>${escapeHtml(t.carrierLabel)}: ${escapeHtml(carrier || '—')}${trackingNumber ? `, ${escapeHtml(t.numberLabel)}: ${escapeHtml(trackingNumber)}` : ''}</p>`,
    `<p style="white-space:pre-line">${escapeHtml(t.signOff)}</p>`,
  ];
  const html =
    '<!doctype html><html><body style="font-family:-apple-system,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#222">'
    + htmlLines.join('\n') +
    '</body></html>';

  return { subject: t.subject, text, html };
}

// Send the customer-facing tracking email AND notify our Telegram with a
// confirmation that includes the active link, so we can see exactly what
// went out. Best-effort — caller doesn't need to await unless it cares.
async function sendTrackingNotification({
  toEmail, country, trackingNumber, carrier, from, prisma, reqChatId,
}) {
  if (!toEmail) return { ok: false, error: 'no recipient email' };
  if (!trackingNumber) return { ok: false, error: 'no tracking number' };
  const trackingUrl = buildTrackingUrl(carrier, trackingNumber, country);
  const { subject, text, html } = compose({ country, trackingNumber, carrier, trackingUrl });

  let fromEmail = from || DEFAULT_FROM;
  if (!findAccount(fromEmail)) {
    const accounts = getAccounts();
    fromEmail = (accounts[0] && accounts[0].user) || fromEmail;
  }

  try {
    const saved = await sendMail({ from: fromEmail, to: toEmail, subject, body: text, html });
    const messageId = saved && saved.messageId;

    // CRM v2 Etap 4.4 — tracking.notify.sent activity event.
    if (prisma) {
      try {
        const { logActivity } = require('./activity-log');
        logActivity(prisma, {
          type: 'tracking.notify.sent',
          summary: `Tracking ${trackingNumber} → ${toEmail}`,
          source: 'system',
          contractorId: (saved && saved.contractorId) || null,
          emailId: saved && saved.id,
          trackingNumber,
          actorType: 'user',
          actorId: reqChatId ? String(reqChatId) : null,
          payload: { toEmail, fromEmail, subject, trackingNumber, trackingUrl, carrier, country, messageId },
          tags: [carrier ? `carrier:${String(carrier).toLowerCase()}` : null, country ? `country:${String(country).toLowerCase()}` : null].filter(Boolean),
        });
      } catch (_) {}
    }

    // Telegram confirmation to the operator (us). Reuses the same helper
    // used everywhere else for "mail sent" notifications so the format
    // is identical. We append the tracking URL line so the operator can
    // see/click what was sent without opening webmail.
    if (prisma) {
      try {
        await notifyMailResult(prisma, {
          reqChatId,
          ok: true,
          to: toEmail, from: fromEmail,
          subject: `${subject}\n- Tracking: ${trackingUrl || '(no link)'}`,
          messageId,
        });
      } catch (e) {
        console.error('[tracking-notify] tg confirm failed:', e.message);
      }
    }

    return { ok: true, sent: { from: fromEmail, to: toEmail, subject, messageId, trackingUrl } };
  } catch (e) {
    console.error('[tracking-notify] send failed:', e.message);
    if (prisma) {
      try {
        await notifyMailResult(prisma, {
          reqChatId, ok: false, to: toEmail, from: fromEmail, subject,
          error: e.message,
        });
      } catch (_) {}
    }
    return { ok: false, error: e.message };
  }
}

module.exports = { compose, pickLang, sendTrackingNotification, validateShipmentReady };
