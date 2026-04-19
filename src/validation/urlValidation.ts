import { Request, Response, NextFunction } from 'express';
import Joi from 'joi';

/**
 * Interface representing the validated payload for creating a URL shortening record.
 */
export interface ShortenRequestPayload {
  original_url: string;
  alias?: string;
  owner_id?: string;
}

/**
 * Joi Schema for validating the URL shortening request.
 * - original_url: Required, must be a valid URI using http or https protocols.
 * - alias: Optional, must be alphanumeric (base62 safe), between 4 and 16 characters.
 * - owner_id: Optional, must be a string.
 */
const shortenSchema = Joi.object<ShortenRequestPayload>({
  original_url: Joi.string()
    .uri({ scheme: ['http', 'https'] })
    .required()
    .trim(),
  alias: Joi.string()
    .alphanum()
    .min(4)
    .max(16)
    .trim(),
  owner_id: Joi.string()
    .alphanum()
    .min(1)
    .max(64)
    .trim(),
});

/**
 * Express middleware to validate the request body against the defined schema.
 * Collects all errors if validation fails.
 * 
 * @param schema - The Joi schema to validate against.
 */
const validate = (schema: Joi.ObjectSchema) => {
  return (req: Request, res: Response, next: NextFunction) => {
    const { error, value } = schema.validate(req.body, {
      abortEarly: false,
      stripUnknown: true,
    });

    if (error) {
      const errorDetails = error.details.map((detail) => ({
        field: detail.path.join('.'),
        message: detail.message.replace(/['"]/g, ''),
      }));

      // Log the validation failure for observability
      console.warn(`Validation failed for path ${req.path}: ${JSON.stringify(errorDetails)}`);

      return res.status(400).json({
        status: 400,
        message: 'Validation failed',
        errors: errorDetails,
      });
    }

    // Replace the request body with the sanitized, validated value
    req.body = value;
    next();
  };
};

/**
 * Middleware for the POST /shorten endpoint.
 */
export const validateShortenRequest = validate(shortenSchema);
