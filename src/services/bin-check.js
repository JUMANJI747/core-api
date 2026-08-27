'use strict';

// Realny test obecności binariów systemowych — ODPALA proces i patrzy, czy wstał.
// Świadomie NIE czyta nixpacks.toml ani żadnego configu: config może być
// ignorowany przez builder (inny mechanizm buildu, pakiety tylko w warstwie
// build zamiast w runtime, zła nazwa pakietu) i wtedy kłamie. Liczy się
// wyłącznie to, czy `pdfinfo` da się uruchomić w kontenerze produkcyjnym.
//
// Powód powstania: /karta-pracy/crop i /karty-pracy/odczytaj wywalały się na
// produkcji z „spawn pdfinfo ENOENT", mimo że poppler-utils był w aptPkgs.
// Braku nie było widać do pierwszego żądania użytkownika, bo nic nie
// sprawdzało binariów przy starcie.

const { execFile } = require('child_process');

const BINARIA = [
  { nazwa: 'pdfinfo', args: ['-v'], pakiet: 'poppler-utils', wymagane: true,
    do: 'liczba stron PDF (karta-pracy, karty-pracy-odczyt)' },
  { nazwa: 'pdftoppm', args: ['-v'], pakiet: 'poppler-utils', wymagane: true,
    do: 'render stron PDF do obrazu (karta-pracy, preprocess-scan)' },
  { nazwa: 'convert', args: ['-version'], pakiet: 'imagemagick', wymagane: true,
    do: 'prostowanie skanu (-deskew)' },
  { nazwa: 'tesseract', args: ['--version'], pakiet: 'tesseract-ocr', wymagane: false,
    do: 'wykrycie obrotu strony (preprocess-scan OSD)' },
  { nazwa: 'gs', args: ['--version'], pakiet: 'ghostscript', wymagane: false,
    do: 'scalanie PDF (jpk-package; ma fallback na qpdf/pdfunite)' },
];

function sprawdzJedno(b, timeoutMs) {
  return new Promise((resolve) => {
    execFile(b.nazwa, b.args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      // Część narzędzi (poppler) wypisuje wersję na stderr — bierzemy oba strumienie.
      const out = `${stdout || ''}\n${stderr || ''}`.split('\n').map(s => s.trim()).filter(Boolean)[0] || null;
      const brak = err && (err.code === 'ENOENT' || /ENOENT|not found/i.test(err.message || ''));
      resolve({
        nazwa: b.nazwa,
        pakiet: b.pakiet,
        wymagane: b.wymagane,
        do: b.do,
        jest: !brak && !!out,
        wersja: brak ? null : (out ? out.slice(0, 80) : null),
        blad: brak ? 'BRAK W OBRAZIE (ENOENT)' : (err && !out ? String(err.message).slice(0, 120) : null),
      });
    });
  });
}

/** @returns {Promise<{ok:boolean, brakujaceWymagane:string[], binaria:object[]}>} */
async function sprawdzBinaria({ timeoutMs = 5000 } = {}) {
  const binaria = await Promise.all(BINARIA.map(b => sprawdzJedno(b, timeoutMs)));
  const brakujaceWymagane = binaria.filter(b => b.wymagane && !b.jest).map(b => b.nazwa);
  return { ok: brakujaceWymagane.length === 0, brakujaceWymagane, binaria };
}

/**
 * Głośne ostrzeżenie przy starcie procesu — braki mają być widoczne w logu
 * deployu, a nie dopiero gdy użytkownik dostanie 500 z ENOENT.
 * Nieblokujące i best-effort: własny błąd nie może wstrzymać startu serwera.
 */
function ostrzezOBrakachPrzyStarcie() {
  sprawdzBinaria().then(({ ok, binaria }) => {
    const brak = binaria.filter(b => !b.jest);
    if (ok && !brak.length) {
      console.log('[startup] binaria OK: ' + binaria.map(b => `${b.nazwa}=${(b.wersja || '?').split(' ').pop()}`).join(' '));
      return;
    }
    const linia = '='.repeat(72);
    console.error(`\n${linia}`);
    console.error('[startup] BRAKUJE BINARIÓW SYSTEMOWYCH W OBRAZIE PRODUKCYJNYM');
    for (const b of brak) {
      console.error(`  ${b.wymagane ? 'KRYTYCZNE' : 'opcjonalne'}: ${b.nazwa} (pakiet ${b.pakiet}) — ${b.do}`);
    }
    const pakiety = [...new Set(brak.map(b => b.pakiet))].join(' ');
    console.error(`  Napraw obraz: apt-get install -y ${pakiety}  (Dockerfile w repo)`);
    console.error('  Diagnostyka w runtime: GET /api/_version → pole "binaria"');
    console.error(`${linia}\n`);
  }).catch(e => console.error('[startup] test binariów nieudany:', e.message));
}

module.exports = { sprawdzBinaria, ostrzezOBrakachPrzyStarcie, BINARIA };
