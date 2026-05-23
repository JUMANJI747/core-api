'use strict';

const router = require('express').Router();
const { processIfirmaInvoices } = require('../services/ifirma-sync');
const { fetchWithTimeout } = require('../http');
const { findAddressInContractorEmails, saveAddressToContractorLocations } = require('../services/address-from-emails');
const { findAddressInGkOrders } = require('../services/find-address-in-gk-orders');
const { backfillShippingFromGk } = require('../services/shipping-backfill-from-gk');
const { scoreContractor } = require('../services/contractor-match');
const { geocodeAndSave } = require('../services/geocode');
const { geocodeContractor } = require('../services/geocode');
const { normalizeAddress } = require('../services/llm-geocode');
const { searchContractor: ifirmaSearchContractor, upsertContractor: ifirmaUpsertContractor } = require('../ifirma-client');
const { extractPostCode, extractCityAfterPostCode } = require('../utils/address');

// PLACEHOLDER