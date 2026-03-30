export const CHARACTER_LIMIT = 25_000;
export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 500;

import { z } from 'zod';

/**
 * Accepts string or number and coerces to a positive integer.
 * Using z.union so the JSON Schema advertises "string | number",
 * meaning Claude Desktop can send either type and it will always work.
 */
export const zId = z
  .union([z.string(), z.number()])
  .transform(v => Number(v))
  .pipe(z.number().int().positive());

export const zOptionalId = zId.optional();

export const zLimit = z
  .union([z.string(), z.number()])
  .transform(v => Number(v))
  .pipe(z.number().int().min(1).max(MAX_LIMIT))
  .default(DEFAULT_LIMIT);

export const zOffset = z
  .union([z.string(), z.number()])
  .transform(v => Number(v))
  .pipe(z.number().int().min(0))
  .default(0);
