'use strict';

function normalizeText(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const PACKAGE_PRESETS = {
  // Domyślny karton (user: „jak nic nie podałem to 30/20/10, 1 kg").
  maly_kartonik: { name: 'Mały kartonik (30 szt)', weight: 1, length: 30, width: 20, height: 10 },
  duzy_karton: { name: 'Duży karton (40×40×40)', weight: 10, length: 40, width: 40, height: 40 },
  paczkomat_a: { name: 'Paczkomat A (mały)', weight: 1, length: 38, width: 64, height: 8 },
  paczkomat_b: { name: 'Paczkomat B (średni)', weight: 2, length: 38, width: 64, height: 19 },
  paczkomat_c: { name: 'Paczkomat C (duży)', weight: 5, length: 38, width: 64, height: 41 },
};

const PRODUCT_WEIGHTS = {
  stick: 1, mascara: 1, gel: 1, daily: 1, care: 1, lips: 0.5, collection: 2,
  'box-stick': 1, 'box-mascara': 1, 'box-collection': 2,
};

function calculatePackageFromItems(items) {
  let totalWeight = 0;
  let kartonikCount = 0;
  for (const item of (items || [])) {
    const name = (item.name || item.productName || item.productEan || '').toLowerCase();
    const qty = item.qty || item.quantity || 1;
    let productType = 'stick';
    if (name.includes('box') && name.includes('stick')) productType = 'box-stick';
    else if (name.includes('box') && name.includes('mascara')) productType = 'box-mascara';
    else if (name.includes('box') && name.includes('collection')) productType = 'box-collection';
    else if (name.includes('box') && name.includes('ekspozytor')) productType = 'box-stick';
    else if (name.includes('box')) productType = 'box-stick';
    else if (name.includes('mascara') || name.includes('girl')) productType = 'mascara';
    else if (name.includes('gel')) productType = 'gel';
    else if (name.includes('daily')) productType = 'daily';
    else if (name.includes('care')) productType = 'care';
    else if (name.includes('lip')) productType = 'lips';
    else if (name.includes('collection')) productType = 'collection';
    const weightPer30 = PRODUCT_WEIGHTS[productType] || 1;
    // Jednostka pozycji: BOX/kartonik (qty = liczba boxów, każdy 30 szt) czy
    // luzem (qty = liczba sztuk). "3 box stick" = 3 kartoniki = ~3 kg, NIE 3 szt.
    const isBoxUnit = String(productType).startsWith('box-')
      || /\b(box|boxy|box[oó]w|kartonik|karton|pude[łl])/.test(name);
    if (isBoxUnit) {
      totalWeight += qty * weightPer30;   // każdy box = weightPer30 kg
      kartonikCount += qty;               // każdy box = 1 kartonik
    } else {
      totalWeight += (qty / 30) * weightPer30;
      // Kartonik mieści standardowo 30 szt, ale upycha się do 36 (świadoma
      // optymalizacja by zaoszczędzić jeden karton — np. 125 szt = 4 zatłoczone
      // kartoniki, nie 5 luźnych).
      kartonikCount += Math.ceil(qty / 36);
    }
  }
  totalWeight = Math.max(1, Math.ceil(totalWeight));

  // Pakowanie: kartoniki w WIEŻE max po 3 (wysokość 10·3 = 30 cm), baza boxa
  // 20×20. Wieże ustawiamy obok siebie w siatce (max 3 w rzędzie):
  //   3 boxy  = 1 wieża      → 20×20×30
  //   6 boxów = 2 wieże po 3 → 20×40×30
  //   9 boxów = 3 wieże      → 20×60×30
  //   12      = 4 wieże      → 40×60×30 (2 rzędy)
  const BOX = { h: 10, w: 20, l: 20 };
  const MAX_PER_TOWER = 3;   // max kartoników na wieżę (najkrótszy bok)
  const MAX_TOWERS_PER_ROW = 3;
  const towers = Math.ceil(kartonikCount / MAX_PER_TOWER);
  const towerHeight = BOX.h * Math.min(kartonikCount, MAX_PER_TOWER); // 1→10, 2→20, ≥3→30
  const towersPerRow = Math.min(towers, MAX_TOWERS_PER_ROW);
  const rows = Math.ceil(towers / MAX_TOWERS_PER_ROW);
  const dimensions = {
    length: BOX.l * rows,
    width: BOX.w * towersPerRow,
    height: towerHeight,
  };

  return {
    weight: totalWeight,
    ...dimensions,
    kartonikCount,
    description: `${kartonikCount} kartonik(ów) ${dimensions.length}×${dimensions.width}×${dimensions.height} cm, ${totalWeight} kg`,
  };
}

const PACZKOMAT_SIZES = {
  A: { maxHeight: 8, maxWidth: 38, maxLength: 64 },
  B: { maxHeight: 19, maxWidth: 38, maxLength: 64 },
  C: { maxHeight: 41, maxWidth: 38, maxLength: 64 },
};

const COUNTRY_IDS = {
  PL: 1, BE: 5, CZ: 8, DK: 9, GR: 13, ES: 14, PT: 24, HU: 32, HR: 131, MT: 206, AE: 293,
};

// normalizeCountry — re-export z services/country-helper.js (commit B).
// Loose wariant (z fallback slice(0,2) dla nieznanych nazw) zachowany
// żeby quote nie pękł na nietypowych wpisach.
const { normalizeIsoLoose } = require('../services/country-helper');
const normalizeCountry = normalizeIsoLoose;

module.exports = { normalizeText, PACKAGE_PRESETS, PRODUCT_WEIGHTS, calculatePackageFromItems, PACZKOMAT_SIZES, COUNTRY_IDS, normalizeCountry };
