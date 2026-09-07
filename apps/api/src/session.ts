import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from './config.js';

const COOKIE_NAME = 'sausixudos_session';
const SESSION_DURATION_SECONDS = 12 * 60 * 60;

export interface SessionIdentity {
  id: string;
  displayName: string;
}

interface SessionPayload extends SessionIdentity {
  expiresAt: number;
}

function encode(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function sign(encodedPayload: string): string {
  return createHmac('sha256', config.SESSION_SECRET).update(encodedPayload).digest('base64url');
}

function readCookies(request: Request): Record<string, string> {
  const header = request.headers.cookie;
  if (!header) return {};

  return Object.fromEntries(
    header.split(';').flatMap((part) => {
      const separator = part.indexOf('=');
      if (separator < 0) return [];
      return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1))]];
    }),
  );
}

export function createSession(id: string, displayName: string): SessionPayload {
  return {
    id,
    displayName,
    expiresAt: Math.floor(Date.now() / 1000) + SESSION_DURATION_SECONDS,
  };
}

export function setSessionCookie(response: Response, session: SessionPayload): void {
  const encodedPayload = encode(JSON.stringify(session));
  response.cookie(COOKIE_NAME, `${encodedPayload}.${sign(encodedPayload)}`, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
    maxAge: SESSION_DURATION_SECONDS * 1000,
    path: '/',
  });
}

export function clearSessionCookie(response: Response): void {
  response.clearCookie(COOKIE_NAME, {
    httpOnly: true,
    sameSite: 'strict',
    secure: config.COOKIE_SECURE,
    path: '/',
  });
}

export function getSession(request: Request): SessionIdentity | null {
  const raw = readCookies(request)[COOKIE_NAME];
  if (!raw) return null;

  const [encodedPayload, providedSignature] = raw.split('.');
  if (!encodedPayload || !providedSignature) return null;

  const expectedSignature = sign(encodedPayload);
  const actualBuffer = Buffer.from(providedSignature);
  const expectedBuffer = Buffer.from(expectedSignature);

  if (
    actualBuffer.length !== expectedBuffer.length ||
    !timingSafeEqual(actualBuffer, expectedBuffer)
  ) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()) as SessionPayload;
    if (
      typeof payload.id !== 'string' ||
      typeof payload.displayName !== 'string' ||
      typeof payload.expiresAt !== 'number' ||
      payload.expiresAt <= Date.now() / 1000
    ) {
      return null;
    }
    return { id: payload.id, displayName: payload.displayName };
  } catch {
    return null;
  }
}

export function inviteMatches(provided: string): boolean {
  const actual = Buffer.from(provided);
  const expected = Buffer.from(config.INVITE_TOKEN);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
