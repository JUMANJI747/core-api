'use strict';

const router = require('express').Router();

router.use(require('./glob-sync'));
router.use(require('./glob-orders'));
router.use(require('./glob-quote'));

module.exports = router;
