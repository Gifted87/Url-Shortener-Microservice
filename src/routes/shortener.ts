import { Router, Request, Response, NextFunction } from 'express';
import { urlService } from '../services/url/urlService';
import { validateShortenRequest } from '../validation/urlValidation';
import { rateLimiter } from '../middleware/rate_limiter';
import pino from 'pino';

const logger = pino({ level: 'info' });
const router = Router();

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
        short_url: `${process.env.BASE_URL || 'http://localhost'}/${generatedAlias}`,
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
    const { alias } = req.params;

    const originalUrl = await urlService.resolveUrl(alias);

    if (!originalUrl) {
      logger.warn({ alias }, 'Attempted to resolve non-existent alias');
      return res.status(404).json({
        status: 404,
        message: 'URL not found',
      });
    }

    // Trigger analytics capture asynchronously
    // Analytics service interface assumed to be available globally or injected
    // AnalyticsService.logClick({
    //   alias,
    //   ip: req.ip,
    //   userAgent: req.headers['user-agent'],
    //   referer: req.headers['referer'],
    //   timestamp: new Date(),
    // }).catch((err) => logger.error({ err }, 'Failed to log analytics event'));

    // Perform the redirect
    return res.status(302).redirect(originalUrl);
  } catch (error) {
    logger.error({ error, alias: req.params.alias }, 'Error during URL resolution');
    next(error);
  }
});

export default router;
