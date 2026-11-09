import express from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Serve the Mini App static files. Falls back to a helpful message if the
 *  build directory is missing (so the API still works before the UI is built). */
export function serveStatic(dir: string): express.RequestHandler {
  const abs = resolve(dir);
  const middleware = express.static(abs, {
    index: 'index.html',
    extensions: ['html'],
    // Всегда ревалидировать статику: после деплоя браузер не должен
    // использовать устаревшие app.js/report.js из кэша.
    setHeaders: (res) => {
      res.setHeader('Cache-Control', 'no-cache');
    },
  });
  return (req, res, next) => {
    if (!existsSync(abs)) {
      if (req.path === '/' || req.path === '/index.html') {
        res
          .status(200)
          .type('text/plain; charset=utf-8')
          .send('Mini App build not found. Put your built web files into the public/ directory.');
        return;
      }
      next();
      return;
    }
    middleware(req, res, next);
  };
}
