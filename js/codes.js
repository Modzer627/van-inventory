// Barcode normalization + classification. Dependency-free so node scripts
// (tools/import-check.mjs) can import it and the browser shares the same rules.
//
// normalizeCode() produces the lookup key: digits lose their leading zeros so a
// UPC-A (843122104825), its EAN-13 form (0843122104825) and an Excel-mangled
// value (20103106041 for 020103106041) all resolve to the same part. Text codes
// are upper-cased with whitespace removed.

const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

export function normalizeCode(raw) {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(CONTROL_CHARS, '').replace(/\s+/g, '');
  if (!s) return null;
  if (/^\d+$/.test(s)) {
    s = s.replace(/^0+/, '');
    return s === '' ? '0' : s;
  }
  return s.toUpperCase();
}

export function upcCheckDigit(d11) {
  let sum = 0;
  for (let i = 0; i < 11; i++) sum += Number(d11[i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
export function isValidUpcA(s) {
  return /^\d{12}$/.test(s) && upcCheckDigit(s.slice(0, 11)) === s[11];
}
export function ean13CheckDigit(d12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(d12[i]) * (i % 2 === 0 ? 1 : 3);
  return String((10 - (sum % 10)) % 10);
}
export function isValidEan13(s) {
  return /^\d{13}$/.test(s) && ean13CheckDigit(s.slice(0, 12)) === s[12];
}
export function isValidEan8(s) {
  if (!/^\d{8}$/.test(s)) return false;
  let sum = 0;
  for (let i = 0; i < 7; i++) sum += Number(s[i]) * (i % 2 === 0 ? 3 : 1);
  return String((10 - (sum % 10)) % 10) === s[7];
}

/**
 * Classify a scanned / typed / imported code.
 * Returns { code, norm, kind, format, flags } or null when empty.
 *   code  — canonical display string (full 12-digit UPC-A when recoverable)
 *   kind  — 'upc' | 'ean' | 'mfr' | 'reel' | 'serial' | 'manual'
 *   flags — { fixedLeadingZero?, precisionLost? }
 */
export function classifyCode(raw, format = null) {
  const flags = {};
  const s = String(raw ?? '').replace(CONTROL_CHARS, '').trim();
  const norm = normalizeCode(s);
  if (!norm) return null;

  let kind = 'mfr';
  let code = s;
  if (/^\d+$/.test(s)) {
    if (s.replace(/^0+/, '').length > 15) flags.precisionLost = true; // beyond Excel's 15 significant digits
    if (s.length === 13 && s[0] === '0' && isValidUpcA(s.slice(1))) { kind = 'upc'; code = s.slice(1); }
    else if (s.length === 12 && isValidUpcA(s)) kind = 'upc';
    else if (s.length === 11 && isValidUpcA('0' + s)) { kind = 'upc'; code = '0' + s; flags.fixedLeadingZero = true; }
    else if (s.length === 13 && isValidEan13(s)) kind = 'ean';
    else if (s.length === 8 && isValidEan8(s)) kind = 'ean';
    else if (s.length >= 15) kind = 'serial';
    else if (format === 'upc_a' || format === 'upc_e') kind = 'upc';
    else if (format === 'ean_13' || format === 'ean_8') kind = 'ean';
    else kind = format === 'manual' ? 'manual' : 'mfr';
  } else {
    const up = s.toUpperCase();
    if (/^L\d{8}$/.test(up)) kind = 'reel';           // WindyCityWire reel ids
    else if (format === 'manual') kind = 'manual';
    else kind = 'mfr';                                 // Bosch F01U…, DMP part numbers, HID …
    code = s.replace(/\s+/g, '');
  }
  return { raw: s, code, norm, kind, format: format || null, flags };
}

const FORMAT_LABELS = {
  upc_a: 'UPC-A', upc_e: 'UPC-E', ean_13: 'EAN-13', ean_8: 'EAN-8',
  code_128: 'Code 128', code_39: 'Code 39', code_93: 'Code 93', itf: 'ITF',
  qr_code: 'QR', data_matrix: 'Data Matrix', pdf417: 'PDF417', aztec: 'Aztec',
  manual: 'typed', import: 'imported',
};
export function formatLabel(format) {
  return FORMAT_LABELS[format] || (format ? String(format) : '');
}

const KIND_LABELS = { upc: 'UPC', ean: 'EAN', mfr: 'Part no.', reel: 'Reel', serial: 'Serial', manual: 'Typed' };
export function kindLabel(kind) {
  return KIND_LABELS[kind] || 'Code';
}

/** Rank used to pick the "primary" code for exports: retail codes first. */
export function kindRank(kind) {
  return { upc: 0, ean: 1, mfr: 2, reel: 3, manual: 4, serial: 5 }[kind] ?? 6;
}
