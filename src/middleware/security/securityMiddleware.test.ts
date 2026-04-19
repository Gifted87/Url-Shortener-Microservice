import { requestSanitizationMiddleware, helmetMiddleware } from './securityMiddleware';
import { Request, Response, NextFunction } from 'express';

jest.mock('helmet', () => {
    return jest.fn((config) => {
        return (req: Request, res: Response, next: NextFunction) => {
            (req as any).helmetConfig = config;
            next();
        };
    });
});

describe('securityMiddleware', () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    let next: NextFunction;

    beforeEach(() => {
        req = {
            body: {},
            query: {},
            path: '/api/v1/test'
        };
        
        res = {
            status: jest.fn().mockReturnThis(),
            json: jest.fn()
        };

        next = jest.fn();
    });

    describe('helmetMiddleware', () => {
        it('should call helmet configuration and next', () => {
            helmetMiddleware(req as Request, res as Response, next);
            expect((req as any).helmetConfig).toBeDefined();
            expect(next).toHaveBeenCalled();
        });
    });

    describe('requestSanitizationMiddleware', () => {
        it('should sanitize simple string fields in body and query', () => {
            req.body = { name: 'Normal string', malicious: '<script>alert(1)</script>' };
            req.query = { search: 'javascript:alert(1)' };

            requestSanitizationMiddleware(req as Request, res as Response, next);

            expect(req.body.name).toBe('Normal string');
            expect(req.body.malicious).toBe(''); // <script> pattern removes the tags and content
            expect(req.query.search).toBe('alert(1)'); // javascript: pattern removes it

            expect(next).toHaveBeenCalled();
        });

        it('should sanitize deeply nested objects', () => {
            req.body = { 
                data: {
                    user: {
                        bio: 'vbscript:exec()'
                    }
                }
            };

            requestSanitizationMiddleware(req as Request, res as Response, next);

            expect(req.body.data.user.bio).toBe('exec()');
            expect(next).toHaveBeenCalled();
        });

        it('should sanitize arrays', () => {
            req.body = { 
                tags: ['safe', '<script>danger()</script>', 'javascript:void(0)']
            };

            requestSanitizationMiddleware(req as Request, res as Response, next);

            expect(req.body.tags).toEqual(['safe', '', 'void(0)']);
            expect(next).toHaveBeenCalled();
        });

        it('should skip sanitization for non-string primitives', () => {
            req.body = { 
                age: 30,
                isActive: true,
                money: null
            };

            requestSanitizationMiddleware(req as Request, res as Response, next);

            expect(req.body.age).toBe(30);
            expect(req.body.isActive).toBe(true);
            expect(req.body.money).toBeNull();
            expect(next).toHaveBeenCalled();
        });

        it('should handle undefined body or query gracefully', () => {
            req.body = undefined;
            req.query = undefined;

            requestSanitizationMiddleware(req as Request, res as Response, next);

            expect(next).toHaveBeenCalled();
        });

        it('should handle cyclic object structures gracefully by throwing and catching', () => {
            const cyclicObj: any = {};
            cyclicObj.self = cyclicObj;

            req.body = cyclicObj;

            // Mock process.stderr.write to prevent clutter
            const originalStderr = process.stderr.write;
            process.stderr.write = jest.fn() as any;

            requestSanitizationMiddleware(req as Request, res as Response, next);

            expect(res.status).toHaveBeenCalledWith(400);
            expect(res.json).toHaveBeenCalledWith({ error: 'Invalid input sequence detected' });
            expect(next).not.toHaveBeenCalled();

            process.stderr.write = originalStderr;
        });
    });
});
