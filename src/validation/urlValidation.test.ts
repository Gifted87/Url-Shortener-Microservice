import { validateShortenRequest } from './urlValidation';
import { Request, Response, NextFunction } from 'express';

describe('urlValidation', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: NextFunction;

  beforeEach(() => {
    req = { body: {} };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
  });

  it('should validate a correct payload and call next', () => {
    req.body = { original_url: 'https://example.com', alias: 'myalias123', owner_id: 'user1' };
    
    validateShortenRequest(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.body).toEqual({ original_url: 'https://example.com', alias: 'myalias123', owner_id: 'user1' });
  });

  it('should allow valid original_url without alias or owner_id', () => {
    req.body = { original_url: 'http://valid.org' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(req.body).toEqual({ original_url: 'http://valid.org' });
  });

  it('should trim string values', () => {
    req.body = { original_url: '  https://test.com  ', alias: '  a1b2  ' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ original_url: 'https://test.com', alias: 'a1b2' });
  });

  it('should return 400 if original_url is missing', () => {
    req.body = { alias: 'test' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      status: 400,
      message: 'Validation failed',
      errors: [{ field: 'original_url', message: 'original_url is required' }]
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 400 if original_url is invalid', () => {
    req.body = { original_url: 'ftp://invalid-scheme.com' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 400,
      message: 'Validation failed',
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'original_url' })
      ])
    }));
    expect(next).not.toHaveBeenCalled();
  });

  it('should return 400 if alias is less than 4 characters', () => {
    req.body = { original_url: 'https://example.com', alias: 'abc' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 400,
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'alias', message: 'alias length must be at least 4 characters long' })
      ])
    }));
  });

  it('should return 400 if alias has special characters', () => {
    req.body = { original_url: 'https://example.com', alias: 'abcd!' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      status: 400,
      errors: expect.arrayContaining([
        expect.objectContaining({ field: 'alias', message: 'alias must only contain alpha-numeric characters' })
      ])
    }));
  });

  it('should strip unknown fields', () => {
    req.body = { original_url: 'https://example.com', unknown: 'field' };

    validateShortenRequest(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ original_url: 'https://example.com' });
  });
});
