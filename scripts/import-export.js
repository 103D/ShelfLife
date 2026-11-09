import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../src/config.js';
import { classifyCategory } from '../dist/data/categoryClassifier.js';


const __dirname = path.dirname(fileURLToPath(import.meta.url));
const exportPath = process.env.EXPORT_PATH || '/tmp/shots2/export_newest.json';
const dbPath = process.env.DB_PATH || config.dbPath;

if (!fs.existsSync(exportPath)) {
  console.error('Export not found:', exportPath);
  process.exit(1);
}

const data = JSON.parse(fs.readFileSync(exportPath, 'utf-8'));
const products = Array.isArray(data) ? data : data.products || [];

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');

// Clear previous import for the dev user (keep all columns, reset timestamp).
db.exec('DELETE FROM products');

const ins = db.prepare(
  `INSERT INTO products
    (user_id, barcode, name, quantity, has_expiration_date, has_shelf_life,
     expiration_date, manufacturing_date, shelf_life_value, shelf_life_unit,
     is_marked_down, is_missing, category, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

const now = Date.now();
const tx = db.transaction((items) => {
  for (const p of items) {
    ins.run(
      1,
      p.barcode || '',
      p.name || '',
      Number(p.quantity) || 1,
      p.hasExpirationDate ? 1 : 0,
      p.hasShelfLife ? 1 : 0,
      p.expirationDate || null,
      p.manufacturingDate || null,
      Number(p.shelfLifeValue) || 0,
      p.shelfLifeUnit || 'days',
      p.isMarkedDown ? 1 : 0,
      p.isMissing ? 1 : 0,
      classifyCategory(p.name || ''),
      p.updatedAt || now
    );
  }
});

tx(products);
console.log(`Imported ${products.length} products into ${dbPath}`);
db.close();
