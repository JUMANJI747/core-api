'use strict';

function normalizeText(s) {
  return (s || '').toString().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

const PACKAGE_PRESETS = {
  maly_kartonik: { name: 'Mały kartonik (30 szt)', weight: 1, length: 20, width: 20, height: 10 },
  duzy_karton: { name: 'Duży karton (40×40×40)', weight: 10, length: 40, width: 40, height: 40 },
  paczkomat_a: { name: 'Paczkomat A (mały)', weight: 1, length: 38, width: 64, height: 8 },
  paczkomat_b: { name: 'Paczkomat B (średni)', weight: 2, length: 38, width: 64, height: 19 },
  paczkomat_c: { name: 'Paczkomat C (duży)', weight: 5, length: 38, width: 64, height: 41 },
};

const PRODUCT_WEIGHTS = {
  stick: 1, mascara: 1, gel: 1, daily: 1, care: 1, lips: 0.5, collection: 2,
};

function calculatePackageFromItems(items) {
  let totalWeight = 0;
  let kartonikCount = 0;
  for (const item of (items || [])) {
    const name = (item.name || item.productName || item.productEan || '').toLowerCase();
    const qty = item.qty || item.quantity || 1;
    let productType = 'stick';
    if (name.includes('mascara') || name.includes('girl')) productType = 'mascara';
    else if (name.includes('gel')) productType = 'gel';
    else if (name.includes('daily')) productType = 'daily';
    else if (name.includes('care')) productType = 'care';
    else if (name.includes('lip')) productType = 'lips';
    else if (name.includes('collection') || name.includes('box')) productType = 'collection';
    const weightPer30 = PRODUCT_WEIGHTS[productType] || 1;
    totalWeight += (qty / 30) * weightPer30;
    kartonikCount += Math.ceil(qty / 36);
  }
  totalWeight = Math.max(1, Math.ceil(totalWeight));

  const BOX = { h: 10, w: 20, l: 20 };
  let dimensions;
  if (kartonikCount <= 1) dimensions = { length: BOX.l, width: BOX.w, height: BOX.h };
  else if (kartonikCount <= 2) dimensions = { length: BOX.l, width: BOX.w, height: BOX.h * 2 };
  else if (kartonikCount <= 4) dimensions = { length: BOX.l * 2, width: BOX.w, height: BOX.h * 2 };
  else if (kartonikCount <= 6) dimensions = { length: BOX.l * 2, width: BOX.w, height: BOX.h * 3 };
  else if (kartonikCount <= 8) dimensions = { length: BOX.l * 2, width: BOX.w * 2, height: BOX.h * 2 };
  else if (kartonikCount <= 12) dimensions = { length: BOX.l * 2, width: BOX.w * 2, height: BOX.h * 3 };
  else {
    dimensions = { length: 40, width: 40, height: 40 };
    if (kartonikCount > 16) dimensions.height = Math.min(60, Math.ceil(kartonikCount / 4) * BOX.h);
  }

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

// LLM agents tend to fill `country` with the Polish name ("Hiszpania")
// instead of the ISO-2 code ("ES"). Normalize before mapping to countryId
// so quotes don't silently fall back to PL.
const COUNTRY_NAME_TO_ISO = {
  'polska': 'PL', 'poland': 'PL',
  'hiszpania': 'ES', 'spain': 'ES', 'espana': 'ES', 'españa': 'ES',
  'francja': 'FR', 'france': 'FR',
  'niemcy': 'DE', 'germany': 'DE', 'deutschland': 'DE',
  'wlochy': 'IT', 'włochy': 'IT', 'italy': 'IT', 'italia': 'IT',
  'portugalia': 'PT', 'portugal': 'PT',
  'belgia': 'BE', 'belgium': 'BE',
  'czechy': 'CZ', 'czech republic': 'CZ', 'czechia': 'CZ',
  'dania': 'DK', 'denmark': 'DK',
  'grecja': 'GR', 'greece': 'GR',
  'wegry': 'HU', 'węgry': 'HU', 'hungary': 'HU',
  'chorwacja': 'HR', 'croatia': 'HR',
  'malta': 'MT',
  'wielka brytania': 'GB', 'uk': 'GB', 'united kingdom': 'GB', 'anglia': 'GB',
  'irlandia': 'IE', 'ireland': 'IE',
  'holandia': 'NL', 'netherlands': 'NL',
  'austria': 'AT',
  'szwecja': 'SE', 'sweden': 'SE',
  'finlandia': 'FI', 'finland': 'FI',
  'norwegia': 'NO', 'norway': 'NO',
  'szwajcaria': 'CH', 'switzerland': 'CH',
  'rumunia': 'RO', 'romania': 'RO',
  'slowacja': 'SK', 'słowacja': 'SK', 'slovakia': 'SK',
  'slowenia': 'SI', 'słowenia': 'SI', 'slovenia': 'SI',
  'litwa': 'LT', 'lithuania': 'LT',
  'lotwa': 'LV', 'łotwa': 'LV', 'latvia': 'LV',
  'estonia': 'EE',
  'bulgaria': 'BG', 'bułgaria': 'BG',
};

function normalizeCountry(input) {
  if (!input) return null;
  const s = String(input).trim();
  if (!s) return null;
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  const key = s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  return COUNTRY_NAME_TO_ISO[key] || s.toUpperCase().slice(0, 2);
}

module.exports = { normalizeText, PACKAGE_PRESETS, PRODUCT_WEIGHTS, calculatePackageFromItems, PACZKOMAT_SIZES, COUNTRY_IDS, normalizeCountry };
