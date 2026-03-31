'use strict';

const router = require('express').Router();

router.post('/import', async (req, res) => {
  const prisma = req.app.locals.prisma;
  try {
    const { contacts, campaign } = req.body;
    if (!contacts?.length) return res.status(400).json({ error: 'contacts required' });
    let created = 0, skipped = 0;
    for (const c of contacts) {
      try {
        await prisma.mailingContact.create({
          data: { ...c, campaign: campaign || c.campaign, status: 'PENDING' },
        });
        created++;
      } catch (e) {
        if (e.code === 'P2002') skipped++;
        else throw e;
      }
    }
    res.json({ ok: true, created, skipped, total: contacts.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/pending', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { campaign, limit } = req.query;
  const where = { status: 'PENDING' };
  if (campaign) where.campaign = { contains: campaign, mode: 'insensitive' };
  const contacts = await prisma.mailingContact.findMany({ where, take: parseInt(limit) || 200, orderBy: { createdAt: 'asc' } });
  res.json(contacts);
});

router.patch('/:id/sent', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { sentFrom, sentVariant } = req.body;
  const contact = await prisma.mailingContact.update({
    where: { id: req.params.id },
    data: { status: 'SENT', sentAt: new Date(), sentFrom, sentVariant },
  });
  res.json(contact);
});

router.get('/stats', async (req, res) => {
  const prisma = req.app.locals.prisma;
  const { campaign } = req.query;
  const where = campaign ? { campaign: { contains: campaign, mode: 'insensitive' } } : {};
  const total = await prisma.mailingContact.count({ where });
  const pending = await prisma.mailingContact.count({ where: { ...where, status: 'PENDING' } });
  const sent = await prisma.mailingContact.count({ where: { ...where, status: 'SENT' } });
  const replied = await prisma.mailingContact.count({ where: { ...where, status: 'REPLIED' } });
  const bounced = await prisma.mailingContact.count({ where: { ...where, status: 'BOUNCED' } });
  const clients = await prisma.mailingContact.count({ where: { ...where, status: 'CLIENT' } });
  res.json({ campaign: campaign || 'all', total, pending, sent, replied, bounced, clients });
});

module.exports = router;
