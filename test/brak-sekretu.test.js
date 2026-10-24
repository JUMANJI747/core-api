'use strict';

/* Brak sekretu w env = trasa ZAMKNIĘTA (24.10.2026). Wcześniej brak
 * PREPROCESS_TOKEN / API_KEY otwierał trasy bez autoryzacji, więc usunięcie
 * zmiennej w Railway „żeby zablokować" działało odwrotnie. */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const express = require('express');

async function zapytaj(app, metoda, sciezka, naglowki = {}) {
  const serwer = app.listen(0);
  await new Promise(r => serwer.once('listening', r));
  try {
    const res = await fetch(`http://127.0.0.1:${serwer.address().port}${sciezka}`, {
      method: metoda, headers: { 'content-type': 'application/json', ...naglowki },
      body: metoda === 'POST' ? '{}' : undefined,
    });
    return res.status;
  } finally {
    serwer.close();
  }
}

function zRouterem(modul, token) {
  const app = express();
  app.use('/', require(path.join(__dirname, '..', modul)).router(express, token));
  return app;
}

test('trasy z x-token bez PREPROCESS_TOKEN odmawiają, także z dowolnym tokenem', async () => {
  const przypadki = [
    ['src/routes/poczta-zdrowie', 'GET', '/poczta/zdrowie'],
    ['czytnik/src/router', 'POST', '/czytnik/odczytaj'],
    ['czytnik/src/router', 'GET', '/czytnik/pracownicy'],
    ['czytnik/src/router', 'GET', '/czytnik/karty-do-druku.pdf'],
    ['src/karta-pracy', 'POST', '/karta-pracy/crop'],
    ['src/karty-pracy-odczyt', 'POST', '/karty-pracy/odczytaj'],
  ];
  for (const [modul, metoda, sciezka] of przypadki) {
    const app = zRouterem(modul, undefined);
    for (const naglowki of [{}, { 'x-token': '' }, { 'x-token': 'cokolwiek' }]) {
      const status = await zapytaj(app, metoda, sciezka, naglowki);
      assert.ok(status === 401 || status === 503, `${metoda} ${sciezka} ${JSON.stringify(naglowki)} → ${status}`);
    }
  }
});

test('z ustawionym tokenem: zły odrzucony, dobry przechodzi przez bramkę', async () => {
  const app = zRouterem('src/routes/poczta-zdrowie', 'sekret-testowy');
  assert.equal(await zapytaj(app, 'GET', '/poczta/zdrowie', { 'x-token': 'zly' }), 401);
  assert.notEqual(await zapytaj(app, 'GET', '/poczta/zdrowie', { 'x-token': 'sekret-testowy' }), 401);
  const czytnik = zRouterem('czytnik/src/router', 'sekret-testowy');
  assert.equal(await zapytaj(czytnik, 'GET', '/czytnik/pracownicy', { 'x-token': 'sekret-testowy' }), 200);
  assert.equal(await zapytaj(czytnik, 'GET', '/czytnik/pracownicy?token=sekret-testowy'), 401, 'pracownicy tylko z nagłówkiem');
});

test('preprocess-scan bez PREPROCESS_TOKEN odmawia', async () => {
  const przed = process.env.PREPROCESS_TOKEN;
  delete process.env.PREPROCESS_TOKEN;
  try {
    const app = express();
    app.use('/', require(path.join(__dirname, '..', 'src', 'routes', 'preprocess-scan')));
    assert.equal(await zapytaj(app, 'POST', '/preprocess-scan'), 401);
    assert.equal(await zapytaj(app, 'POST', '/preprocess-scan', { 'x-token': '' }), 401);
  } finally {
    if (przed !== undefined) process.env.PREPROCESS_TOKEN = przed;
  }
});

test('mapa bez API_KEY nie oddaje pełnych danych na ?key=', async () => {
  const przed = process.env.API_KEY;
  delete process.env.API_KEY;
  const sciezka = require.resolve(path.join(__dirname, '..', 'src', 'routes', 'map'));
  delete require.cache[sciezka];
  try {
    const src = require('fs').readFileSync(sciezka, 'utf8');
    assert.match(src, /if \(!API_KEY\) return false;/);
  } finally {
    if (przed !== undefined) process.env.API_KEY = przed;
  }
});
