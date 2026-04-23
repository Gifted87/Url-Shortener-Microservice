import { Router, Request, Response, NextFunction } from 'express';
import { urlService } from '../services/url/urlService';
import { analyticsService } from '../services/analytics/analyticsService';
import { validateShortenRequest } from '../validation/urlValidation';
import { rateLimiter } from '../middleware/rate_limiter';
import pino from 'pino';
import Joi from 'joi';
import { config } from '../config/env';

const logger = pino({ level: 'info' });
const router = Router();

/**
 * Interface representing the URL record for resolution.
 */
interface ResolvedUrl {
  id: string;
  original_url: string;
}

const aliasSchema = Joi.string().alphanum().min(4).max(64).required();

/**
 * POST /shorten
 * Shortens a long URL and returns the generated alias.
 */
router.post('/shorten', rateLimiter, validateShortenRequest, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { original_url, alias, owner_id } = req.body;

    // The service handles logic: persistence, potential alias generation, and cache warming
    const generatedAlias = await urlService.shortenUrl(original_url, owner_id);

    logger.info({ alias: generatedAlias, original_url }, 'URL successfully shortened');

    return res.status(201).json({
      status: 201,
      data: {
        original_url,
        alias: generatedAlias,
        short_url: `${config.BASE_URL}/${generatedAlias}`,
        owner_id,
        created_at: new Date().toISOString(),
      },
    });
  } catch (error) {
    logger.error({ error, body: req.body }, 'Error during URL shortening');
    next(error);
  }
});

/**
 * GET /:alias
 * Resolves the provided alias to its corresponding long-form destination URL.
 * Dispatches async analytics event and performs a 302 redirect.
 */
router.get('/:alias', rateLimiter, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { error, value: alias } = aliasSchema.validate(req.params.alias);
    if (error) {
      return res.status(400).json({
        status: 400,
        message: 'Invalid alias format',
        details: error.details.map(d => d.message)
      });
    }

    const record = await urlService.resolveUrl(alias);

    if (!record) {
      logger.warn({ alias }, 'Attempted to resolve non-existent alias');
      return res.status(404).json({
        status: 404,
        message: 'URL not found',
      });
    }

    // Trigger analytics capture asynchronously
    analyticsService.trackClick(
      record.id.toString(),
      req.ip || '0.0.0.0',
      req.headers['user-agent'] || 'unknown',
      req.headers['referer'] || ''
    ).catch((err) => logger.error({ err }, 'Failed to log analytics event'));

    // Perform the redirect
    return res.status(302).redirect(record.original_url);
  } catch (error) {
    logger.error({ error, alias: req.params.alias }, 'Error during URL resolution');
    next(error);
  }
});


export default router;

