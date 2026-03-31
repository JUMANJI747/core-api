'use strict';

const router = require('express').Router();

const SEED_PRODUCTS = [
  {ean:"5902082579014", name:"SURF CARE hydrating cream", category:"pielęgnacja", capacity:"30g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579021", name:"SURF GEL extreme waterproof gel spf 50+", category:"ochrona słoneczna", capacity:"40g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579045", name:"SURF DAILY protection spf 50", category:"ochrona słoneczna", capacity:"30g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082579052", name:"SURF LIPS lip balm spf 50+", category:"ochrona słoneczna", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556022", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Blue", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556053", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Pink", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556046", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Purple", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082556039", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Mint", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082564935", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"White", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082564942", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:"Skin", capacity:"6.8g", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576150", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Blue", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576167", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Mint", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576174", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Pink", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"5902082576181", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:"Black", capacity:"9ml", pricePLN:18, priceEUR:4.5},
  {ean:"STICK-GENERIC", name:"SURF STICK zinc stick spf 50+", category:"ochrona słoneczna", variant:null, capacity:"6.8g", pricePLN:18, priceEUR:4.5, unit:"szt"},
  {ean:"MASCARA-GENERIC", name:"SURF GIRL waterproof mascara", category:"makijaż", variant:null, capacity:"9ml", pricePLN:18, priceEUR:4.5, unit:"szt"},
  {ean:"BOX-STICK-30", name:"Surf Stick Box / Ekspozytor", category:"template", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{isTemplate:true, composition:[{ean:"5902082556022",variant:"Blue",qty:5},{ean:"5902082556053",variant:"Pink",qty:5},{ean:"5902082556046",variant:"Purple",qty:5},{ean:"5902082556039",variant:"Mint",qty:5},{ean:"5902082564935",variant:"White",qty:5},{ean:"5902082564942",variant:"Skin",qty:5}],totalQty:30}},
  {ean:"BOX-MASCARA-30", name:"Surf Girl Mascara Box", category:"template", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{isTemplate:true, composition:[{ean:"5902082576181",variant:"Black",qty:12},{ean:"5902082576167",variant:"Mint",qty:6},{ean:"5902082576174",variant:"Pink",qty:6},{ean:"5902082576150",variant:"Blue",qty:6}],totalQty:30}},
  {ean:"BOX-COLLECTION-30", name:"Surf Collection Box", category:"template", capacity:"30 szt", variant:"mixed", pricePLN:540, priceEUR:135, unit:"box", extras:{isTemplate:true, composition:[{ean:"5902082579052",variant:"Lip Balm",qty:12},{ean:"5902082579021",variant:"Gel SPF50+",qty:6},{ean:"5902082579045",variant:"Daily UV SPF50+",qty:6},{ean:"5902082579014",variant:"Hydrating Cream",qty:6}],totalQty:30}},
];

router.get('/expand-box', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { ean, qty } = req.query;
    if (!ean) return res.status(400).json({ error: 'ean required' });
    const multiplier = Math.max(1, parseInt(qty) || 1);

    const template = await prisma.product.findUnique({ where: { ean } });
    if (!template) return res.status(404).json({ error: 'product not found' });

    const composition = template.extras && template.extras.composition;
    if (!composition || !Array.isArray(composition)) return res.status(400).json({ error: 'product has no composition' });

    const eans = composition.map(c => c.ean);
    const products = await prisma.product.findMany({ where: { ean: { in: eans } } });
    const byEan = Object.fromEntries(products.map(p => [p.ean, p]));

    const lines = composition.map(c => {
      const p = byEan[c.ean] || {};
      return {
        ean: c.ean,
        name: p.name || null,
        variant: c.variant || p.variant || null,
        qty: c.qty * multiplier,
        pricePLN: p.pricePLN ?? null,
        priceEUR: p.priceEUR ?? null,
      };
    });

    res.json(lines);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { category, active } = req.query;
  const where = {};
  if (category) where.category = { equals: category, mode: 'insensitive' };
  if (active !== undefined) where.active = active === 'true';
  const products = await prisma.product.findMany({ where, orderBy: { category: 'asc' } });
  res.json(products);
});

router.post('/seed', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    let created = 0, updated = 0;
    for (const p of SEED_PRODUCTS) {
      const data = { ...p, extras: p.extras || {} };
      const existing = await prisma.product.findUnique({ where: { ean: p.ean } });
      if (existing) {
        await prisma.product.update({ where: { ean: p.ean }, data: { name: p.name, variant: p.variant ?? null, category: p.category, capacity: p.capacity ?? null, pricePLN: p.pricePLN, priceEUR: p.priceEUR } });
        updated++;
      } else {
        await prisma.product.create({ data });
        created++;
      }
    }
    res.json({ ok: true, created, updated, total: SEED_PRODUCTS.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
