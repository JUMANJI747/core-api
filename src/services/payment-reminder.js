'use strict';

// 🏏 Przypomnienie o płatności przeterminowanej FV — wspólne szablony dla
// PL (iFirma) i ES (Contasimple). Język: z kraju kontrahenta (pickLang jak
// tracking); Contasimple ZAWSZE 'es'. Treść krótka, zgodnie z życzeniem:
// „przypominamy o płatności za fakturę nr X … pozdrawiamy Surf Stick Bell Team".

const { pickLang } = require('./tracking-notify');

const TEMPLATES = {
  pl: {
    subject: n => `Przypomnienie o płatności — faktura ${n}`,
    body: (n, amt) => `Dzień dobry,\n\nuprzejmie przypominamy o płatności za fakturę nr ${n}${amt ? ` (${amt})` : ''}.\n\nPozdrawiamy,\nSurf Stick Bell Team`,
  },
  en: {
    subject: n => `Payment reminder — invoice ${n}`,
    body: (n, amt) => `Hello,\n\nthis is a friendly reminder about the outstanding payment for invoice ${n}${amt ? ` (${amt})` : ''}.\n\nBest regards,\nSurf Stick Bell Team`,
  },
  de: {
    subject: n => `Zahlungserinnerung — Rechnung ${n}`,
    body: (n, amt) => `Hallo,\n\nwir möchten freundlich an die offene Zahlung der Rechnung ${n}${amt ? ` (${amt})` : ''} erinnern.\n\nViele Grüße,\nSurf Stick Bell Team`,
  },
  fr: {
    subject: n => `Rappel de paiement — facture ${n}`,
    body: (n, amt) => `Bonjour,\n\nnous nous permettons de vous rappeler le paiement en attente de la facture ${n}${amt ? ` (${amt})` : ''}.\n\nBien cordialement,\nSurf Stick Bell Team`,
  },
  es: {
    subject: n => `Recordatorio de pago — factura ${n}`,
    body: (n, amt) => `Hola,\n\nle recordamos amablemente el pago pendiente de la factura ${n}${amt ? ` (${amt})` : ''}.\n\nUn saludo,\nSurf Stick Bell Team`,
  },
  it: {
    subject: n => `Promemoria di pagamento — fattura ${n}`,
    body: (n, amt) => `Buongiorno,\n\nle ricordiamo gentilmente il pagamento in sospeso della fattura ${n}${amt ? ` (${amt})` : ''}.\n\nCordiali saluti,\nSurf Stick Bell Team`,
  },
  nl: {
    subject: n => `Betalingsherinnering — factuur ${n}`,
    body: (n, amt) => `Hallo,\n\ndit is een vriendelijke herinnering aan de openstaande betaling van factuur ${n}${amt ? ` (${amt})` : ''}.\n\nMet vriendelijke groet,\nSurf Stick Bell Team`,
  },
  pt: {
    subject: n => `Lembrete de pagamento — fatura ${n}`,
    body: (n, amt) => `Olá,\n\nlembramos gentilmente o pagamento pendente da fatura ${n}${amt ? ` (${amt})` : ''}.\n\nCom os melhores cumprimentos,\nSurf Stick Bell Team`,
  },
};

// { lang?, country?, number, amount?, currency? } → { lang, subject, text }
function composeReminder({ lang, country, number, amount, currency }) {
  const l = (lang && TEMPLATES[String(lang).toLowerCase()]) ? String(lang).toLowerCase() : pickLang(country || '');
  const t = TEMPLATES[l] || TEMPLATES.en;
  const amt = amount != null && Number.isFinite(Number(amount))
    ? `${Number(amount).toFixed(2)} ${currency || ''}`.trim()
    : null;
  return { lang: l, subject: t.subject(number), text: t.body(number, amt) };
}

module.exports = { composeReminder };
