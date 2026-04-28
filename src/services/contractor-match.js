'use strict';

function normalizeContractorName(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[áàä]/g, 'a').replace(/[éèë]/g, 'e').replace(/[íìï]/g, 'i')
    .replace(/[óòö]/g, 'o').replace(/[úùü]/g, 'u').replace(/ñ/g, 'n')
    .replace(/ç/g, 'c').replace(/[ãõ]/g, a => a === 'ã' ? 'a' : 'o')
    .replace(/[-.,&]/g, ' ')
    .replace(/\b(lda|slu|sl|sa|sp|gmbh|srl|snc|unipessoal|spolka|sp z o o|sp\. z o\.o\.?)\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function scoreContractor(contractor, search) {
  const normSearch = normalizeContractorName(search);
  const normName = normalizeContractorName(contractor.name);
  const searchWords = normSearch.split(/\s+/).filter(w => w.length >= 3);

  if (normName === normSearch) return 100;
  if (searchWords.length > 0 && searchWords.every(w => normName.includes(w))) return 90;
  if (searchWords.some(w => normName.includes(w))) return 80;

  const nameWords = normName.split(/\s+/).filter(w => w.length >= 3);
  const has70 = searchWords.some(sw => nameWords.some(nw => nw.includes(sw) || sw.includes(nw)));
  if (has70) return 70;

  const aliases = (contractor.extras && Array.isArray(contractor.extras.aliases)) ? contractor.extras.aliases : [];
  if (aliases.some(a => normalizeContractorName(a) === normSearch)) return 60;

  if (contractor.nip && contractor.nip.replace(/\s/g, '').includes(search.replace(/\s/g, ''))) return 50;

  const has40 = searchWords.some(sw => {
    const pfx = sw.slice(0, 4);
    return nameWords.some(nw => nw.startsWith(pfx));
  });
  if (has40) return 40;

  return 0;
}

module.exports = { normalizeContractorName, scoreContractor };
