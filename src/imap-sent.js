'use strict';

const Imap = require('imap');

const SENT_FOLDER_CANDIDATES = [
  'Sent',
  'Sent Items',
  'INBOX.Sent',
  'INBOX.Wysłane',
  'Wysłane',
  '[Gmail]/Sent Mail',
];

function connect(account) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: account.user,
      password: account.pass,
      host: account.host,
      port: account.port,
      tls: true,
      tlsOptions: { rejectUnauthorized: false },
      connTimeout: 30000,
      authTimeout: 15000,
      // Jednorazowe połączenie do APPEND — bez podtrzymywania sesji (NOOP/IDLE
      // trzymały osierocone połączenia na serwerze bez końca) i z limitem ciszy.
      keepalive: false,
      socketTimeout: 60000,
    });
    imap.once('ready', () => resolve(imap));
    imap.once('error', reject);
    imap.connect();
  });
}

function findSentFolder(imap) {
  return new Promise((resolve, reject) => {
    imap.getBoxes((err, boxes) => {
      if (err) return reject(err);
      function walk(node, prefix = '') {
        for (const [name, box] of Object.entries(node || {})) {
          const fullName = prefix ? prefix + box.delimiter + name : name;
          if (box.attribs && box.attribs.includes('\\Sent')) return fullName;
          if (box.children) {
            const found = walk(box.children, fullName);
            if (found) return found;
          }
        }
        return null;
      }
      const fromFlag = walk(boxes);
      if (fromFlag) return resolve(fromFlag);
      const flat = [];
      function collect(node, prefix = '') {
        for (const [name, box] of Object.entries(node || {})) {
          const fullName = prefix ? prefix + box.delimiter + name : name;
          flat.push(fullName);
          if (box.children) collect(box.children, fullName);
        }
      }
      collect(boxes);
      for (const candidate of SENT_FOLDER_CANDIDATES) {
        const match = flat.find(n => n.toLowerCase() === candidate.toLowerCase());
        if (match) return resolve(match);
      }
      resolve(null);
    });
  });
}

function appendMessage(imap, folder, rawMessage) {
  return new Promise((resolve, reject) => {
    imap.append(rawMessage, { mailbox: folder, flags: ['\\Seen'], date: new Date() }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

// Best-effort APPEND of a raw RFC822 message to the account's Sent folder.
// Designed to be fire-and-forget — failures are logged but never re-thrown,
// because the SMTP send already succeeded and we don't want to mislead
// the caller into thinking the message wasn't delivered.
async function appendToSent(account, rawMessage) {
  if (!account || !account.host || !account.user || !account.pass) {
    console.warn('[imap-sent] missing host/user/pass on account; skipping APPEND');
    return { ok: false, reason: 'account incomplete' };
  }
  let imap;
  // Twardy limit CAŁEJ kopii (22.10.2026): przy wolnym serwerze APPEND potrafił
  // wisieć bez końca, a każda wysyłka (np. 11 kanarków) zostawiała takie wiszące
  // połączenie. Po limicie niszczymy gniazdo — mail i tak już wyszedł SMTP.
  let budzik;
  let porzucone = false;
  const limit = new Promise((_, reject) => { budzik = setTimeout(() => { porzucone = true; reject(new Error('kopia do Wysłanych: przekroczono 90 s')); }, 90000); });
  try {
    return await Promise.race([kopiuj(), limit]);
  } catch (e) {
    console.error(`[imap-sent] APPEND failed for ${account && account.user}:`, e.message);
    try { if (imap) imap.destroy(); } catch (_) {}
    return { ok: false, reason: e.message };
  } finally {
    clearTimeout(budzik);
  }

  async function kopiuj() {
    imap = await connect(account);
    // Połączenie doszło już po limicie — nie kopiujemy, zamykamy od razu.
    if (porzucone) { try { imap.destroy(); } catch (_) {} return { ok: false, reason: 'po limicie' }; }
    const folder = await findSentFolder(imap);
    if (!folder) {
      console.warn(`[imap-sent] no Sent folder for ${account.user}; skipping APPEND`);
      try { imap.end(); } catch (_) {}
      return { ok: false, reason: 'no sent folder' };
    }
    await appendMessage(imap, folder, rawMessage);
    console.log(`[imap-sent] appended to ${folder} for ${account.user}`);
    try { imap.end(); } catch (_) {}
    return { ok: true, folder };
  }
}

module.exports = { appendToSent };
