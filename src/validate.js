'use strict';

const { z, ZodError } = require('zod');

// n8n HTTP tools use {{ $json.field || '' }} expressions, so unfilled fields
// arrive as empty strings (or the literal "undefined"/"null") instead of
// being omitted. z.coerce.number('') is NaN and trips validation. Strip
// these placeholder values before parsing so optional() actually works.
function stripEmptyStrings(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === '' || v === 'undefined' || v === 'null') continue;
    out[k] = v;
  }
  return out;
}

// Replace req.body with parsed (and possibly transformed) value.
// On invalid input, ZodError propagates to the global error middleware.
function validateBody(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(stripEmptyStrings(req.body));
      next();
    } catch (err) {
      next(err);
    }
  };
}

// Replace req.query with parsed value (req.query is read-only in Express 5;
// we attach to req.validatedQuery instead to stay forward-compatible).
function validateQuery(schema) {
  return (req, res, next) => {
    try {
      req.validatedQuery = schema.parse(stripEmptyStrings(req.query));
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validateBody, validateQuery, stripEmptyStrings, z, ZodError };
