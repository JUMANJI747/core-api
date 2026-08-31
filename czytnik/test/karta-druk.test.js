'use strict';
/**
 * Testy drogi wydruku pustych kart — `npm test` (wbudowany node:test, 0 zależności,
 * 0 wywołań API).
 *
 * Powstały po wpadce: sprawdzałem wydruk wywołaniem z CLI, gdzie `dzialy` w ogóle
 * nie ma, a router wysyła `dzialy: {}` — pusty obiekt jest w JS prawdziwy, więc
 * domyślne działy trafiały na papier mimo `zDzialem: false`. Testy idą teraz TĄ
 * SAMĄ drogą co HTTP (przez router z prawdziwym żądaniem), a nie skrótem.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { router } = require('../src/router');
const { planKart } = require('../src/karta-druk');

const TOKEN = 'test-token';

/** stawia router na losowym porcie i woła go jak n8n */
async function przezHttp(sciezka, body) {
  const app = express();
  app.use(router(express, TOKEN));
  const serwer = app.listen(0);
  try {
    const port = serwer.address().port;
    const odp = await fetch(`http://127.0.0.1:${port}${sciezka}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-token': TOKEN },
      body: JSON.stringify(body),
    });
    return { status: odp.status, dane: await odp.json() };
  } finally {
    serwer.close();
  }
}

test('dzial zostaje pusty - tak jak na kartach papierowych', async () => {
  const { dane } = await przezHttp('/czytnik/karty-do-druku', { od: '2026-09', miesiecy: 1 });
  assert.equal(dane.ok, true);
  const zDzialem = dane.karty.filter(k => k.dzial);
  assert.deepEqual(zDzialem, [], 'zadna karta nie moze miec wpisanego dzialu');
});

test('zDzialem: true wlacza mape dzialow z pracownicy.json', async () => {
  const { dane } = await przezHttp('/czytnik/karty-do-druku',
    { od: '2026-09', miesiecy: 1, zDzialem: true });
  assert.ok(dane.karty.filter(k => k.dzial).length > 20);
});

test('dzialy podane wprost dotycza tylko wskazanych osob', () => {
  const { karty } = planKart({ osoby: ['Monika Korgul', 'Tomasz Żuk'],
    od: { rok: 2026, miesiac: 9 }, miesiecy: 1, dzialy: { 'Monika Korgul': 'Kuchnia' } });
  assert.equal(karty.find(k => k.osoba === 'Monika Korgul').dzial, 'Kuchnia');
  assert.equal(karty.find(k => k.osoba === 'Tomasz Żuk').dzial, null);
});

test('komplet dzieli sie na miesiace, po jednym pliku', async () => {
  const { dane } = await przezHttp('/czytnik/karty-do-druku', { od: '2026-09', miesiecy: 3 });
  assert.deepEqual(dane.pliki.map(p => p.nazwa),
    ['karty-2026-09.pdf', 'karty-2026-10.pdf', 'karty-2026-11.pdf']);
  assert.ok(dane.pliki.every(p => p.stron === dane.karty.length / 3));
  assert.ok(dane.pliki.every(p => Buffer.from(p.data, 'base64').subarray(0, 5).toString() === '%PDF-'));
});

test('podziel: "nie" sklei miesiace w jeden plik', async () => {
  const { dane } = await przezHttp('/czytnik/karty-do-druku',
    { od: '2026-09', miesiecy: 3, podziel: 'nie' });
  assert.equal(dane.pliki.length, 1);
  assert.equal(dane.pliki[0].nazwa, 'karty-2026-09_2026-11.pdf');
});

test('norma godzin liczona z art. 130 KP, nie przepisana', () => {
  const { karty } = planKart({ osoby: ['Tomasz Żuk'], od: { rok: 2026, miesiac: 9 }, miesiecy: 3 });
  assert.deepEqual(karty.map(k => k.norma), [176, 176, 160]);   // XI 2026: 11.11 wypada w srode
});

test('nazwisko z karty papierowej wygrywa nad zapisem z arkusza', () => {
  const { karty } = planKart({ osoby: ['Przemek Podolecki'], od: { rok: 2026, miesiac: 9 }, miesiecy: 1 });
  assert.equal(karty[0].osoba, 'Przemysław Podolecki');
});
