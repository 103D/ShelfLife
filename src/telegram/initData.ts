import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Validates Telegram WebApp `initData` per the official algorithm:
 *   secret = HMAC_SHA256(key="WebAppData", msg=bot_token)
 *   hash   = HMAC_SHA256(key=secret, msg=data_check_string)
 * where data_check_string is the sorted "key=value" set (excluding hash),
 * joined by "\n". Returns the parsed user or null if invalid/expired.
 */

export interface TelegramUser {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface ParsedInitData {
  user?: TelegramUser;
  auth_date: number;
  query_id?: string;
  raw: URLSearchParams;
}

function buildDataCheckString(params: URLSearchParams): string {
  const pairs: string[] = [];
  for (const [key, value] of params.entries()) {
    if (key === 'hash') continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  return pairs.join('\n');
}

export function verifyInitData(initData: string, maxAgeSeconds = 24 * 60 * 60): ParsedInitData | null {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;

  const dataCheckString = buildDataCheckString(params);
  const secret = crypto.createHmac('sha256', 'WebAppData').update(config.botToken).digest();
  const computed = crypto.createHmac('sha256', secret).update(dataCheckString).digest('hex');

  const a = Buffer.from(computed, 'hex');
  const b = Buffer.from(hash, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  const authDate = Number(params.get('auth_date') ?? '0');
  const nowSec = Date.now() / 1000;
  if (!authDate || authDate > nowSec + 60 || nowSec - authDate > maxAgeSeconds) return null;

  let user: TelegramUser | undefined;
  const userRaw = params.get('user');
  if (userRaw) {
    try {
      user = JSON.parse(userRaw) as TelegramUser;
    } catch {
      return null;
    }
  }

  return { user, auth_date: authDate, query_id: params.get('query_id') ?? undefined, raw: params };
}
