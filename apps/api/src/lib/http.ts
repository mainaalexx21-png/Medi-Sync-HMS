import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { ZodError, ZodSchema, z } from 'zod';
import { AppError, badRequest } from './errors';

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };

/** Validates a payload against a zod schema, throwing a 400 with field details. */
export function parseBody<S extends ZodSchema>(schema: S, data: unknown): z.infer<S> {
  try {
    return schema.parse(data) as z.infer<S>;
  } catch (error) {
    if (error instanceof ZodError) {
      throw badRequest('Validation failed', {
        fields: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    throw error;
  }
}

export interface Pagination {
  page: number;
  pageSize: number;
  skip: number;
  take: number;
}

export function parsePagination(query: Request['query'], maxPageSize = 100): Pagination {
  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number(query.pageSize ?? 25) || 25));
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}

export function paginated<T>(items: T[], total: number, p: Pagination) {
  return {
    data: items,
    pagination: {
      page: p.page,
      pageSize: p.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / p.pageSize)),
    },
  };
}

/** RFC4180-ish CSV with spreadsheet formula-injection protection. */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const escape = (value: string | number | null | undefined) => {
    const text = value === null || value === undefined ? '' : String(value);
    const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
    return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
  };
  return [headers.map(escape).join(','), ...rows.map((r) => r.map(escape).join(','))].join('\r\n');
}

export function sendCsv(res: Response, filename: string, csv: string) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(`\uFEFF${csv}`);
}

export function errorEnvelope(error: unknown) {
  if (error instanceof AppError) {
    return {
      status: error.status,
      body: {
        error: { code: error.code, message: error.message, details: error.details ?? undefined },
      },
    };
  }
  return {
    status: 500,
    body: { error: { code: 'INTERNAL_ERROR', message: 'Unexpected server error' } },
  };
}
