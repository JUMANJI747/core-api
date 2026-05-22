'use strict';

const https = require('https');
const crypto = require('crypto');
const router = require('express').Router();
const { sendMail, findAccount, extractInbox, getAccounts } = require('../mail-sender');
const { appendToSent } = require('../imap-sent');
const nodemailer = require('nodemailer');
const { buildTrackingUrl } = require('../services/tracking-urls');
const { sendTrackingNotification, validateShipmentReady } = require('../services/tracking-notify');
const { getOrders } = require('../glob-client');
const { sendTelegram } = require('../telegram-utils');
const { notifyMailResult } = require('../services/notify-mail-result');
const { scoreContractor } = require('../services/contractor-match');
const { OFFER_TEMPLATES } = require('../offer-templates');
const { parseOrderWithLLM } = require('../order-llm-parser');
const { translateToPl, translateFromPl, countryToLang } = require('../services/email-translate');
