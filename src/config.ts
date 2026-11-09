import 'dotenv/config';

function required(name: string): string {
  const v = process.env[name];
  if (!v) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return v;
}

export const config = {
  botToken: required('BOT_TOKEN'),
  /** Public HTTPS URL of this server (for the Mini App button). */
  webappUrl: process.env.WEBAPP_URL ?? 'http://localhost:3000',
  port: Number(process.env.PORT ?? 3000),
  dbPath: process.env.DB_PATH ?? './data/shelflife.db',
  /** Directory holding the built Mini App (static HTML/JS/CSS). */
  webappStaticDir: process.env.WEBAPP_STATIC_DIR ?? './public',
  /** Allow API access without Telegram initData (dev only). */
  devAuth: process.env.DEV_AUTH === '1',
  /** Fixed user id used when devAuth is on. */
  devUserId: 1,
};

