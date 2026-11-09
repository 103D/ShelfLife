import { createApp } from './api/server.js';
import { createBot } from './telegram/bot.js';
import { config } from './config.js';
import { serveStatic } from './api/static.js';

const app = createApp();
const bot = createBot();

// Serve the Mini App static files at the web root.
app.use(serveStatic(config.webappStaticDir));

app.listen(config.port, () => {
  console.log(`🚀 API + Mini App listening on http://localhost:${config.port}`);
  console.log(`   Mini App public URL (set in BotFather): ${config.webappUrl}`);
  console.log(`   DEV_AUTH=${config.devAuth ? 'on (no Telegram signature check!)' : 'off'}`);
});

// Long polling keeps the bot running alongside the HTTP server. In production
// you may switch to webhooks via `bot.api.setWebhook(...)`.
// A bot/network error must NOT take down the API server, so we catch it.
void bot.start({
  onStart: (me) => console.log(`🤖 Bot @${me.username} started (long polling)`),
}).catch((err) => {
  console.error('⚠️  Bot long polling failed to start (check BOT_TOKEN):', err?.message ?? err);
  console.error('   The API + Mini App keep running; fix the token and restart to enable the bot.');
});
