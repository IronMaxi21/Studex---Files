import './setup.js';
import type { FastifyInstance, InjectOptions } from 'fastify';
import { randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.js';

export interface Client {
  token: string;
  csrfToken: string;
  cookies: Record<string, string>;
  userId: string;
  email: string;
}

let appInstance: FastifyInstance | null = null;

export async function getApp(): Promise<FastifyInstance> {
  if (!appInstance) appInstance = await buildApp();
  return appInstance;
}

export async function closeApp(): Promise<void> {
  await appInstance?.close();
  appInstance = null;
}

function collectCookies(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
  for (const entry of list) {
    const item = entry as { name?: string; value?: string };
    if (item.name && item.value !== undefined) out[item.name] = item.value;
  }
  return out;
}

/** Registers a fresh user and returns credentials for both auth styles. */
export async function registerUser(displayName = 'Test Student'): Promise<Client> {
  const app = await getApp();
  const email = `user-${randomUUID()}@studex.test`;
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    payload: { email, password: 'a-perfectly-fine-passphrase', displayName },
  });
  if (res.statusCode !== 201) {
    throw new Error(`registration failed: ${res.statusCode} ${res.body}`);
  }
  const body = res.json();
  return {
    token: body.token,
    csrfToken: body.csrfToken,
    cookies: collectCookies(res.cookies),
    userId: body.user.id,
    email,
  };
}

/** Authenticated request using a bearer token (no CSRF token required). */
export async function api(
  client: Client,
  options: InjectOptions,
): Promise<ReturnType<FastifyInstance['inject']> extends Promise<infer R> ? R : never> {
  const app = await getApp();
  return app.inject({
    ...options,
    headers: {
      ...options.headers,
      authorization: `Bearer ${client.token}`,
    },
  });
}

/** Authenticated request using cookies, exercising the CSRF path. */
export async function cookieApi(
  client: Client,
  options: InjectOptions & { csrf?: string | null },
) {
  const app = await getApp();
  const { csrf, ...rest } = options;
  const headers: Record<string, string> = { ...(rest.headers as Record<string, string>) };
  const token = csrf === undefined ? client.csrfToken : csrf;
  if (token !== null) headers['x-csrf-token'] = token;

  return app.inject({ ...rest, cookies: client.cookies, headers });
}

/** A minimal but structurally valid PDF. */
export function samplePdf(sizeBytes = 1024): Buffer {
  const header = Buffer.from(
    '%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
    'ascii',
  );
  if (sizeBytes <= header.length) return header;
  return Buffer.concat([header, Buffer.alloc(sizeBytes - header.length, 0x20)]);
}

/**
 * A PDF that states the size of its page tree, so the server can read the page
 * count off it the way it does off a real one.
 */
export function samplePdfWithPages(pages: number, sizeBytes = 1024): Buffer {
  const kids = Array.from({ length: pages }, (_, i) => `${i + 3} 0 R`).join(' ');
  const leaves = Array.from(
    { length: pages },
    (_, i) => `${i + 3} 0 obj<</Type/Page/Parent 2 0 R>>endobj\n`,
  ).join('');
  const body = Buffer.from(
    '%PDF-1.4\n'
      + '1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n'
      + `2 0 obj<</Type/Pages/Kids[${kids}]/Count ${pages}>>endobj\n`
      + leaves
      + 'trailer<</Root 1 0 R>>\n%%EOF\n',
    'latin1',
  );
  if (sizeBytes <= body.length) return body;
  return Buffer.concat([body, Buffer.alloc(sizeBytes - body.length, 0x20)]);
}

/** A real 1×1 PNG, so the uploader's sniff has something true to find. */
export function samplePng(): Buffer {
  return Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
}

/** Builds a multipart body for file upload injection. */
export function multipartBody(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; content: Buffer },
): { payload: Buffer; headers: Record<string, string> } {
  const boundary = `----studex${randomUUID().replace(/-/g, '')}`;
  const parts: Buffer[] = [];

  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        'utf8',
      ),
    );
  }

  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
      'utf8',
    ),
    file.content,
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  );

  return {
    payload: Buffer.concat(parts),
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  };
}

export const uuid = () => randomUUID();
