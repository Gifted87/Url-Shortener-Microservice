import dotenv from 'dotenv';
import Joi from 'joi';

// Load environment variables from .env file if it exists
if (process.env.NODE_ENV !== 'test') {
  dotenv.config();
}

/**
 * Interface defining the application configuration contract.
 * Ensures type safety throughout the application.
 */
export interface AppConfig {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  DATABASE_URL: string;
  REDIS_URL: string;
  LOG_LEVEL: 'debug' | 'info' | 'warn' | 'error';
  WORKER_COUNT?: number;
  SHUTDOWN_TIMEOUT_MS: number;
  BASE_URL: string;
  PROXY_TRUST_DEPTH: number;
}

/**
 * Joi schema for environment variable validation.
 * Enforces strict typing and presence of required variables.
 */
const schema = Joi.object<AppConfig>({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'production')
    .default('development'),
  PORT: Joi.number()
    .port()
    .default(3000),
  DATABASE_URL: Joi.string()
    .uri()
    .required(),
  REDIS_URL: Joi.string()
    .uri()
    .required(),
  LOG_LEVEL: Joi.string()
    .valid('debug', 'info', 'warn', 'error')
    .default('info'),
  WORKER_COUNT: Joi.number()
    .optional(),
  SHUTDOWN_TIMEOUT_MS: Joi.number()
    .min(0)
    .default(10000),
  BASE_URL: Joi.string()
    .uri()
    .default('http://localhost:3000'),
  PROXY_TRUST_DEPTH: Joi.number()
    .min(1)
    .default(1),
});

/**
 * Validates and normalizes environment variables.
 * Exits the process if validation fails to prevent unstable runtime.
 * 
 * @returns {Readonly<AppConfig>} An immutable configuration object.
 */
function loadConfig(): Readonly<AppConfig> {
  const { error, value } = schema.validate(process.env, {
    abortEarly: false,
    allowUnknown: true,
  });

  if (error) {
    const errorDetails = error.details.map((detail) => detail.message).join(', ');
    console.error(`Configuration validation failed: ${errorDetails}`);
    process.exit(1);
  }

  return Object.freeze(value as AppConfig);
}

// Export the frozen configuration object
export const config: Readonly<AppConfig> = loadConfig();
