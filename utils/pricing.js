/**
 * utils/pricing.js
 *
 * Single source of truth for print pricing and page-count estimation.
 *
 * Both POST /orders (order creation) and POST /orders/estimate (live price
 * preview, used by the Customer UI) call into this module, so the price a
 * customer sees before submitting always matches what actually gets
 * charged. Do not duplicate these numbers/formulas anywhere else —
 * update them here only.
 */

const RATE_PER_PAGE_BW = 3; // ₹3 per page, black & white
const RATE_PER_PAGE_COLOR = 10; // ₹10 per page, color

const MAX_FILE_SIZE_MB = 10; // Cloudinary free-tier limit, per file
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024;

/**
 * Works out how many pages a single file's print settings cover.
 *
 * - `pagesString` is the optional free-text range the customer can type,
 *   e.g. "1-3" or "1,4,7". Left blank, "all pages" is assumed.
 * - `detectedPageCount` is the real page count pdf-lib detected at upload
 *   time (see POST /upload). It's used as the fallback whenever
 *   `pagesString` is blank or can't be parsed, so the estimate is based on
 *   the file's actual length instead of always guessing "1".
 */
function estimatePageCount(pagesString, detectedPageCount) {
  const fallback = detectedPageCount && detectedPageCount > 0 ? detectedPageCount : 1;

  if (!pagesString || !pagesString.trim()) return fallback;

  const trimmed = pagesString.trim();

  if (trimmed.includes("-")) {
    const [start, end] = trimmed.split("-").map(Number);
    if (!isNaN(start) && !isNaN(end) && end >= start) return end - start + 1;
    return fallback;
  }

  if (trimmed.includes(",")) {
    const count = trimmed.split(",").filter((p) => p.trim() !== "").length;
    return count > 0 ? count : fallback;
  }

  if (!isNaN(Number(trimmed))) return 1; // a single page number, e.g. "3"

  return fallback;
}

/**
 * Works out a shop's effective per-page rates: the shop's own custom rate
 * if they've set one (Settings -> Print Rates), otherwise the platform
 * default. `shop` can be null/undefined (falls back to defaults entirely) —
 * makes this safe to call even when a shop lookup came back empty.
 *
 * Uses ?? rather than || so a shop that deliberately sets a rate of 0
 * (e.g. free B&W printing) is respected instead of being overridden.
 */
function effectiveRates(shop) {
  return {
    bw: shop && shop.ratePerPageBW != null ? shop.ratePerPageBW : RATE_PER_PAGE_BW,
    color: shop && shop.ratePerPageColor != null ? shop.ratePerPageColor : RATE_PER_PAGE_COLOR,
  };
}

/**
 * Price for one file entry.
 * Expects: { pages, copies, color, pageCount } — `pageCount` is the
 * detected count from upload (may be null), `pages` is the customer's
 * optional manual range. `rates` is a { bw, color } pair from
 * effectiveRates() — defaults to the platform rates if omitted.
 */
function calculateFilePrice(file, rates) {
  const pageCount = estimatePageCount(file.pages, file.pageCount);
  const r = rates || { bw: RATE_PER_PAGE_BW, color: RATE_PER_PAGE_COLOR };
  const rate = file.color ? r.color : r.bw;
  return pageCount * rate * (Number(file.copies) || 1);
}

/** Total price across every file in an order, at the given shop's rates. */
function calculateOrderPrice(files, rates) {
  return (files || []).reduce((total, file) => total + calculateFilePrice(file, rates), 0);
}

module.exports = {
  RATE_PER_PAGE_BW,
  RATE_PER_PAGE_COLOR,
  MAX_FILE_SIZE_MB,
  MAX_FILE_SIZE_BYTES,
  estimatePageCount,
  effectiveRates,
  calculateFilePrice,
  calculateOrderPrice,
};
