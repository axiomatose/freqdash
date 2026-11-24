import { z } from 'zod';
import { apiError } from '../auth/guard';

// Small helpers for the route handlers: strict query parsing and a uniform 400.

export function parseQuery<S extends z.ZodType>(req: Request, schema: S): z.output<S> | Response {
  const params: Record<string, string> = {};
  for (const [key, value] of new URL(req.url).searchParams) params[key] = value;
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.join('.') ?? 'query';
    return apiError(400, 'bad_request', `invalid ${where}`);
  }
  return parsed.data;
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S> | Response> {
  const raw: unknown = await req.json().catch(() => undefined);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    return apiError(400, 'bad_request', `invalid ${first?.path.join('.') || 'body'}`);
  }
  return parsed.data;
}

export const isResponse = (v: unknown): v is Response => v instanceof Response;

export function ok(body: unknown): Response {
  return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
}

const optionalInt = (max: number) =>
  z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().max(max))
    .optional();

export const limitParam = (max: number) => optionalInt(max);
export const offsetParam = optionalInt(1_000_000);
