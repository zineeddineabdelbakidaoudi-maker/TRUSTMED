const logger = require('../../../shared/logger');

/**
 * Creates a Zod validation middleware for Express.
 * Validates req[source] against the provided schema.
 *
 * @param {import('zod').ZodSchema} schema - Zod schema
 * @param {'body'|'query'|'params'} source - Request property to validate
 */
function validate(schema, source = 'body') {
  return (req, res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const errors = result.error.issues.map((issue) => ({
        field: issue.path.join('.'),
        message: issue.message,
      }));
      logger.warn('Validation failed', { path: req.path, errors });
      return res.status(400).json({
        error: 'validation_error',
        message: 'Invalid request parameters',
        details: errors,
      });
    }
    req.validated = result.data;
    next();
  };
}

module.exports = validate;
