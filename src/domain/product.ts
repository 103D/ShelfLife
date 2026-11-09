/**
 * Domain model + expiration logic, ported 1:1 from the Android app
 * (`domain/model/Product.kt`) so behaviour stays identical on the web.
 *
 * Dates are epoch milliseconds (Long in Kotlin === number in TS).
 */

export type ProductExpiration = 'EXPIRED' | 'ON_SALE' | 'OTHER';

export interface ProductBatch {
  id: number;
  expirationDate: number | null;
  manufacturingDate: number | null;
  shelfLifeValue: number;
  shelfLifeUnit: string;
  quantity: number;
  isMarkedDown: boolean;
  isMissing: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface Product {
  id: number;
  barcode: string;
  name: string;
  /** Агрегат: суммарное количество по всем партиям. */
  quantity: number;
  hasExpirationDate: boolean;
  hasShelfLife: boolean;
  /** Агрегат: самая ранняя дата истечения среди партий. */
  expirationDate: number | null;
  manufacturingDate: number | null;
  shelfLifeValue: number;
  shelfLifeUnit: string;
  /** Агрегат: уценена ли хотя бы одна партия. */
  isMarkedDown: boolean;
  /** Агрегат: отсутствует ли хотя бы одна партия. */
  isMissing: boolean;
  category: string;
  updatedAt: number;
  /** Партии товара (несколько дат). */
  batches: ProductBatch[];
}

export type NewProduct = Omit<Product, 'id' | 'updatedAt' | 'batches'> & { batches?: ProductBatch[] };

/** Product payload for bulk import (allows carrying updatedAt). */
export type ImportProduct = NewProduct & { updatedAt?: number };

const MILLIS_PER_DAY = 1000 * 60 * 60 * 24;

/** Days until expiration. 0 = expires today, negative = already expired. */
export function daysRemaining(p: Pick<Product, 'hasExpirationDate' | 'expirationDate'>): number | null {
  if (!p.hasExpirationDate || p.expirationDate == null) return null;
  const ms = p.expirationDate - Date.now();
  // Kotlin's Duration.toDays() truncates toward zero; Math.trunc matches that.
  return Math.trunc(ms / MILLIS_PER_DAY);
}

/** Expired: today or earlier (daysRemaining <= 0). */
export function isExpired(p: Pick<Product, 'hasExpirationDate' | 'expirationDate'>): boolean {
  const d = daysRemaining(p);
  return d != null ? d <= 0 : false;
}

/** Expiring within `days` starting tomorrow (daysRemaining in 1..days). */
export function isExpiringSoonWithin(
  p: Pick<Product, 'hasExpirationDate' | 'expirationDate'>,
  days: number,
): boolean {
  const d = daysRemaining(p);
  return d != null ? d >= 1 && d <= days : false;
}

/**
 * Single source of truth for expiration categorization.
 * - EXPIRED  (Списание): expired today or earlier (daysRemaining <= 0)
 * - ON_SALE  (Уценка):   expires tomorrow..+warningDays (1..warningDays)
 * - OTHER    (Другое):   everything else
 */
export function expirationCategory(
  p: Pick<Product, 'hasExpirationDate' | 'expirationDate'>,
  warningDays: number,
): ProductExpiration {
  if (isExpired(p)) return 'EXPIRED';
  if (isExpiringSoonWithin(p, warningDays)) return 'ON_SALE';
  return 'OTHER';
}

/** Human labels used by both the bot and the Mini App. */
export const EXPIRATION_LABELS: Record<ProductExpiration, string> = {
  EXPIRED: 'Списание',
  ON_SALE: 'Уценка',
  OTHER: 'Другое',
};

/**
 * Дата истечения из даты производства + срока хранения, как в Android
 * (`ProductDetailViewModel.recalculateExpiration`):
 *   cal.add(DAY_OF_YEAR | MONTH, value - 1)
 * Значение `value` считает день производства первым днём срока, поэтому
 * срок «1 день» истекает в день производства. Месяцы — календарные, с
 * клампингом дня к последнему дню месяца (поведение java.util.Calendar.add).
 * Число дней/месяцев задаётся в Android и здесь не меняется.
 */
export function computeExpirationDate(mfg: number | null, value: number, unit: string): number | null {
  if (mfg == null || !value) return null;
  const n = value;
  const d = new Date(mfg);
  if (unit === 'months') {
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + n);
    const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    d.setDate(Math.min(day, lastDay));
  } else {
    d.setDate(d.getDate() + n);
  }
  // Android после Calendar.add выставляет 23:59:59 (ProductDetailViewModel):
  // срок действует ВЕСЬ последний день. Без этого срок считался истёкшим
  // уже в 00:00 последнего дня — на сутки раньше, чем в Android.
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}
