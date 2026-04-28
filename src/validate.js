'use strict';

const { z, ZodError } = require('zod');

// Replace req.body with parsed (and possibly transformed) value.
// On invalid input, ZodError propagates to the global error middleware.
function validateBody(schema) {
  return (req, res, next) => {
    try {
      req.body = schema.parse(req.body || {});
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
      req.validatedQuery = schema.parse(req.query || {});
      next();
    } catch (err) {
      next(err);
    }
  };
}

module.exports = { validateBody, validateQuery, z, ZodError };
