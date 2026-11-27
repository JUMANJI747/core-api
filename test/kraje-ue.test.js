'use strict';
// Wymóg deklaracji celnej (27.11.2026): poza obszar celny UE tylko z deklaracją.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { obszarCelny, wymogDeklaracji, maDeklaracje } = require(path.join(__dirname, '..', 'src', 'services', 'kraje-ue'));

const PL = { iso: 'PL', kod: '05-410' };

test('obszar celny: kraje UE, kraje spoza UE i terytoria UE poza obszarem (po kodzie pocztowym)', () => {
  assert.equal(obszarCelny('DE', '10115'), 'UE');
  assert.equal(obszarCelny('es', '11140'), 'UE', 'Conil — Hiszpania kontynentalna');
  assert.equal(obszarCelny('ES', '38001'), 'ES: Wyspy Kanaryjskie');
  assert.equal(obszarCelny('ES', '35 100'), 'ES: Wyspy Kanaryjskie');
  assert.equal(obszarCelny('ES', '51001'), 'ES: Ceuta / Melilla');
  assert.equal(obszarCelny('FR', '97400'), 'FR: terytoria zamorskie Francji');
  assert.equal(obszarCelny('FR', '75001'), 'UE');
  assert.equal(obszarCelny('FI', '22100'), 'FI: Wyspy Alandzkie');
  assert.equal(obszarCelny('MC', '98000'), 'UE', 'Monako w obszarze celnym UE');
  assert.equal(obszarCelny('CH', '4532'), 'CH');
  assert.equal(obszarCelny('GB', 'SW1A 1AA'), 'GB');
  assert.equal(obszarCelny('', '4532'), null);
});

test('wymóg deklaracji: z Polski do CH/GB/NO i na Kanary — tak; po UE — nie; nieznany kraj odbiorcy — zgłoszony', () => {
  assert.equal(wymogDeklaracji(PL, { iso: 'DE', kod: '10115' }), null);
  assert.equal(wymogDeklaracji(PL, { iso: 'ES', kod: '11140' }), null);
  assert.equal(wymogDeklaracji({}, { iso: 'CZ', kod: '38801' }), null, 'nadawca bez kraju = Polska');
  assert.deepEqual(wymogDeklaracji(PL, { iso: 'CH', kod: '4532' }), { nieznany: false, powod: 'CH — poza obszarem celnym UE' });
  assert.match(wymogDeklaracji(PL, { iso: 'GB', kod: 'SW1A 1AA' }).powod, /^GB/);
  assert.match(wymogDeklaracji(PL, { iso: 'NO', kod: '0150' }).powod, /^NO/);
  assert.match(wymogDeklaracji(PL, { iso: 'ES', kod: '38001' }).powod, /Wyspy Kanaryjskie/);
  assert.match(wymogDeklaracji({ iso: 'CH', kod: '8001' }, PL).powod, /^CH/, 'z CH do Polski też');
  assert.equal(wymogDeklaracji({ iso: 'CH', kod: '8001' }, { iso: 'CH', kod: '4532' }), null, 'w obrębie jednego kraju spoza UE — nie');
  assert.equal(wymogDeklaracji(PL, { iso: '', kod: '4532' }).nieznany, true);
});

test('deklaracja w zleceniu = sekcja customs z co najmniej jedną pozycją towaru', () => {
  assert.equal(maDeklaracje(undefined), false);
  assert.equal(maDeklaracje({}), false);
  assert.equal(maDeklaracje({ commodities: [] }), false);
  assert.equal(maDeklaracje({ commodities: [{ description: 'Lip balm', quantity: 24 }] }), true);
});
