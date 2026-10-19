// Minimal request/response shapes — Vercel's Node runtime provides
// these; self-typing avoids the heavyweight @vercel/node dev-dep.

import { loadConfig, type Config } from './config.js';

export interface Req {
  method?: string;
  body?: unknown;
  query?: Record<string, string | string[] | undefined>;
  headers: Record<string, string | string[] | undefined>;
}

export interface Res {
  status(code: number): Res;
  json(data: unknown): void;
  setHeader(name: string, value: string): void;
}

export function body(req: Req): Record<string, unknown> {
  if (req.body && typeof req.body === 'object') return req.body as Record<string, unknown>;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body) as Record<string, unknown>; } catch { return {}; }
  }
  return {};
}

/** The config, or a 503 already sent. */
export function configOr503(res: Res): Config | null {
  const cfg = loadConfig();
  if (!cfg) {
    res.status(503).json({ error: 'tournament not configured' });
    return null;
  }
  return cfg;
}

/** Run a handler, turning anything thrown into a logged 500. */
export async function guard(tag: string, res: Res, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.error(`[${tag}]`, e);
    res.status(500).json({ error: 'server error' });
  }
}
