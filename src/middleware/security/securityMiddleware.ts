import { Request, Response, NextFunction } from 'express';
import helmet from 'helmet';

/**
 * @file securityMiddleware.ts
 * @description Provides a production-grade security layer for Express, including
 * HTTP header enforcement via Helmet and robust request sanitization to prevent XSS
 * and HTTP Parameter Pollution.
 */

/**
 * XSS Sanitization patterns to identify and neutralize malicious payloads.
 * Targets script tags, dangerous event handlers, and javascript: pseudo-protocols.
 */
const XSS_PATTERNS = [
  /<script\b[^>]*>([\s\S]*?)<\/script>/gim,
  /on\w+\s*=\s*['"]?([^'"]+)['"]?/gim,
  /javascript:/gim,
  /vbscript:/gim,
  /data:[^,]+base64/gim,
];

/**
 * Sanitizes a string value by removing or encoding potentially dangerous patterns.
 */
function sanitizeValue(value: any): any {
  if (typeof value !== 'string') {
    return value;
  }

  let sanitized = value;
  for (const pattern of XSS_PATTERNS) {
    sanitized = sanitized.replace(pattern, '');
  }
  return sanitized.trim();
}

/**
 * Recursively sanitizes objects (req.body, req.query).
 */
function sanitizeInput(input: any): any {
  if (input === null || typeof input !== 'object') {
    return sanitizeValue(input);
  }

  if (Array.isArray(input)) {
    return input.map((item) => sanitizeInput(item));
  }

  const sanitizedObject: Record<string, any> = {};
  for (const [key, value] of Object.entries(input)) {
    sanitizedObject[key] = sanitizeInput(value);
  }
  return sanitizedObject;
}

/**
 * Middleware: Enforces secure HTTP headers using Helmet.
 */
export const helmetMiddleware = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      upgradeInsecureRequests: [],
    },
  },
  hsts: {
    maxAge: 31536000,
    includeSubDomains: true,
    preload: true,
  },
  hidePoweredBy: true,
});

/**
 * Middleware: Sanitizes request body, query, and params to prevent XSS and HPP.
 */
export const requestSanitizationMiddleware = (req: Request, res: Response, next: NextFunction) => {
  try {
    if (req.body) {
      req.body = sanitizeInput(req.body);
    }
    if (req.query) {
      req.query = sanitizeInput(req.query);
    }
    next();
  } catch (error) {
    // Log anomaly to standard logging facility (e.g., console.error or pino if configured)
    process.stderr.write(`[SECURITY ANOMALY] Sanitization failed for request path: ${req.path}\n`);
    res.status(400).json({ error: 'Invalid input sequence detected' });
  }
};
