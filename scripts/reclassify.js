import Database from 'better-sqlite3';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyCategory } from '../dist/data/categoryClassifier.js';

/**
 * Пересчитывает категории всех товаров по названию (после правок
 * классификатора) и пересобирает справочник `categories` для каждого
 * пользователя.
 *
 * Важно: если классификатор не уверен (вернул «Другое»), осмысленная
 * сохранённая категория НЕ затирается.
 *
 * Запуск: DB_PATH=/path/to/shelflife.db node scripts/reclassify.js
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.DB_PATH || path.resolve(__dirname, '../data/shelflife.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

const rows = db.prepare('SELECT id,user_id,name,category FROM products').all();
const upd = db.prepare('UPDATE products SET category = ? WHERE id = ?');

let changed = 0;
let unchanged = 0;
const changes = new Map();

const tx = db.transaction(() => {
  for (const r of rows) {
    const predicted = classifyCategory(r.name || '');
    // Не понижаем ручную категорию до «Другое».
    const next = predicted === 'Другое' ? r.category || 'Другое' : predicted;
    if (next !== r.category) {
      upd.run(next, r.id);
      changed++;
      const key = (r.category || '∅') + ' → ' + next;
      changes.set(key, (changes.get(key) || 0) + 1);
    } else {
      unchanged++;
    }
  }
});
tx();

const users = db
  .prepare('SELECT DISTINCT user_id FROM products')
  .all()
  .map((r) => r.user_id);
const del = db.prepare('DELETE FROM categories WHERE user_id = ?');
const ins = db.prepare('INSERT OR IGNORE INTO categories (user_id, name) VALUES (?, ?)');
const selectCats = db.prepare(
  "SELECT DISTINCT category FROM products WHERE user_id = ? AND category IS NOT NULL AND category <> '' ORDER BY category",
);

const rebuild = db.transaction(() => {
  for (const uid of users) {
    del.run(uid);
    for (const { category } of selectCats.all(uid)) ins.run(uid, category);
  }
});
rebuild();

console.log('DB:', dbPath);
console.log(`products: ${rows.length}, changed: ${changed}, unchanged: ${unchanged}, users: ${users.length}`);
console.log('top changes:');
for (const [k, v] of [...changes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
  console.log(`  ${v}x  ${k}`);
}
db.close();

