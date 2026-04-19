import request from 'supertest';
import express from 'express';
import shortenerRouter from './shortener';
import { urlService } from '../services/url/urlService';
import { validateShortenRequest } from '../validation/urlValidation';
import { rateLimiter } from '../middleware/rate_limiter';

jest.mock('../services/url/urlService', () => ({
    urlService: {
        shortenUrl: jest.fn(),
        resolveUrl: jest.fn()
    }
}));

jest.mock('../validation/urlValidation', () => ({
    validateShortenRequest: jest.fn((req, res, next) => next())
}));

jest.mock('../middleware/rate_limiter', () => ({
    rateLimiter: jest.fn((req, res, next) => next())
}));

jest.mock('pino', () => {
    return () => ({
        info: jest.fn(),
        warn: jest.fn(),
        error: jest.fn()
    });
});

const app = express();
app.use(express.json());
app.use('/', shortenerRouter);

describe('Shortener Routes', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('POST /shorten', () => {
        it('should successfully shorten a url and return 201', async () => {
            const mockAlias = 'abcd';
            (urlService.shortenUrl as jest.Mock).mockResolvedValue(mockAlias);

            const res = await request(app)
                .post('/shorten')
                .send({ original_url: 'https://example.com' });

            expect(res.status).toBe(201);
            expect(res.body.data.alias).toBe(mockAlias);
            expect(res.body.data.original_url).toBe('https://example.com');
            expect(urlService.shortenUrl).toHaveBeenCalledWith('https://example.com', undefined);
        });

        it('should handle service errors gracefully', async () => {
            (urlService.shortenUrl as jest.Mock).mockRejectedValue(new Error('Service failure'));

            const res = await request(app)
                .post('/shorten')
                .send({ original_url: 'https://example.com' });

            // Next is called with error, express default error handler returns 500 html if not configured,
            // so we expect a 500 status.
            expect(res.status).toBe(500);
        });
    });

    describe('GET /:alias', () => {
        it('should return 404 if alias not found', async () => {
            (urlService.resolveUrl as jest.Mock).mockResolvedValue(null);

            const res = await request(app)
                .get('/nonexistent');

            expect(res.status).toBe(404);
            expect(res.body.message).toBe('URL not found');
            expect(urlService.resolveUrl).toHaveBeenCalledWith('nonexistent');
        });

        it('should redirect to original url if alias found', async () => {
            (urlService.resolveUrl as jest.Mock).mockResolvedValue('https://target.com');

            const res = await request(app)
                .get('/exists');

            expect(res.status).toBe(302);
            expect(res.header.location).toBe('https://target.com');
            expect(urlService.resolveUrl).toHaveBeenCalledWith('exists');
        });

        it('should handle service errors during resolution', async () => {
            (urlService.resolveUrl as jest.Mock).mockRejectedValue(new Error('DB Error'));

            const res = await request(app)
                .get('/erroralias');

            expect(res.status).toBe(500);
        });
    });
});
