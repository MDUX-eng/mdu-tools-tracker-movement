/**
 * ============================================================
 *  TOOLS TRACKER - Backend Google Apps Script
 * ============================================================
 *  Sheet yang dipakai:
 *   - LogActivity : catatan check-in / check-out
 *   - User        : database user (User_ID, Password, Aktif)
 *   - Location    : database lokasi (nama, koordinat, toleransi meter)
 *   - Tools       : database tools (untuk validasi QR)
 *
 *  Cara pakai singkat:
 *   1. Tempel kode ini di Extensions > Apps Script pada spreadsheet.
 *   2. Jalankan fungsi setup() sekali (membuat sheet + header + contoh data).
 *   3. Deploy > New deployment > Web app
 *        Execute as     : Me
 *        Who has access : Anyone
 *   4. Salin URL Web App ke SCRIPT_URL di index.html.
 * ============================================================
 */

const CONFIG = {
  SHEET_LOG: 'LogActivity',
  SHEET_USER: 'User',
  SHEET_LOCATION: 'Location',
  SHEET_TOOLS: 'Tools',
  SESSION_SECONDS: 6 * 60 * 60, // sesi login 6 jam (batas maksimal CacheService)
  MAX_LOGIN_FAIL: 5,            // salah password 5x -> dikunci sementara
  LOCK_SECONDS: 5 * 60          // lama kunci: 5 menit
};

const HEADERS = {
  [CONFIG.SHEET_LOG]: ['User_ID', 'Tools_ID', 'Timestamp', 'Location', 'Status'],
  [CONFIG.SHEET_USER]: ['User_ID', 'Password', 'Aktif'],
  [CONFIG.SHEET_LOCATION]: ['Location_Name', 'Latitude', 'Longitude', 'Tolerance_m'],
  [CONFIG.SHEET_TOOLS]: ['Tools_ID', 'Tools_Name']
};

// Kolom yang dipaksa format teks (agar ID / password / timestamp tidak diubah Sheets)
const TEXT_COLUMNS = {
  [CONFIG.SHEET_LOG]: 'A:E',
  [CONFIG.SHEET_USER]: 'A:B',
  [CONFIG.SHEET_TOOLS]: 'A:A'
};

const SAMPLES = {
  [CONFIG.SHEET_USER]: [['d400', '1234', 'Ya']],
  [CONFIG.SHEET_LOCATION]: [['Gudang Utama (Kantor)', -6.175392, 106.827153, 100]], // GANTI dengan koordinat asli
  [CONFIG.SHEET_TOOLS]: [['EL-MC-0001', 'Mesin Bor Listrik']]
};

// ============================================================
//  ENDPOINT
// ============================================================

function doGet() {
  return json_({ ok: true, message: 'Tools Tracker API aktif' });
}

function doPost(e) {
  let req;
  try {
    req = JSON.parse(e.postData.contents);
  } catch (err) {
    return json_({ ok: false, error: 'Format request tidak valid' });
  }

  try {
    switch (req.action) {
      case 'login':         return json_(login_(req));
      case 'checkLocation': return json_(requireSession_(req, () => checkLocation_(req)));
      case 'submitScan':    return json_(requireSession_(req, s => submitScan_(req, s)));
      case 'logout':        return json_(logout_(req));
      default:              return json_({ ok: false, error: 'Aksi tidak dikenal' });
    }
  } catch (err) {
    return json_({ ok: false, error: 'Server error: ' + err.message });
  }
}

// ============================================================
//  1. LOGIN
// ============================================================

function login_(req) {
  const userId = clean_(req.userId);
  const password = String(req.password || '');
  if (!userId || !password) return { ok: false, error: 'User ID dan Password wajib diisi' };

  const cache = CacheService.getScriptCache();
  const failKey = 'fail_' + userId.toLowerCase();
  const fails = Number(cache.get(failKey) || 0);
  if (fails >= CONFIG.MAX_LOGIN_FAIL) {
    return { ok: false, error: 'Terlalu banyak percobaan gagal. Coba lagi dalam 5 menit.' };
  }

  const user = readSheet_(CONFIG.SHEET_USER)
    .find(u => clean_(u.User_ID).toLowerCase() === userId.toLowerCase());

  if (!user || String(user.Password) !== password) {
    cache.put(failKey, String(fails + 1), CONFIG.LOCK_SECONDS);
    return { ok: false, error: 'User ID atau Password salah' };
  }
  if (!isActive_(user.Aktif)) {
    return { ok: false, error: 'Akun nonaktif, hubungi Admin!' };
  }

  cache.remove(failKey);
  const realId = clean_(user.User_ID);
  const token = Utilities.getUuid();
  cache.put('sess_' + token, realId, CONFIG.SESSION_SECONDS);
  return { ok: true, token: token, userId: realId };
}

function logout_(req) {
  if (req.token) CacheService.getScriptCache().remove('sess_' + req.token);
  return { ok: true };
}

function requireSession_(req, fn) {
  const cache = CacheService.getScriptCache();
  const userId = req.token ? cache.get('sess_' + req.token) : null;
  if (!userId) return { ok: false, sessionExpired: true, error: 'Sesi berakhir, silakan login ulang' };
  cache.put('sess_' + req.token, userId, CONFIG.SESSION_SECONDS); // perpanjang sesi selama aktif
  return fn({ userId: userId, token: req.token });
}

// ============================================================
//  2. PENGENALAN LOKASI
// ============================================================

function checkLocation_(req) {
  const result = findLocation_(req.lat, req.lng);
  if (result.error) return { ok: false, error: result.error };
  if (result.valid) {
    return { ok: true, valid: true, location: result.location, distance: Math.round(result.distance) };
  }
  return {
    ok: true,
    valid: false,
    message: 'Lokasi tidak terdaftar, hubungi Admin!',
    nearestDistance: result.nearestDistance == null ? null : Math.round(result.nearestDistance)
  };
}

/** Cari lokasi terdaftar yang radius toleransinya mencakup posisi user. */
function findLocation_(lat, lng) {
  lat = toNum_(lat);
  lng = toNum_(lng);
  if (!isFinite(lat) || !isFinite(lng)) return { valid: false, error: 'Koordinat GPS tidak valid' };

  const locations = readSheet_(CONFIG.SHEET_LOCATION)
    .map(l => ({
      name: clean_(l.Location_Name),
      lat: toNum_(l.Latitude),
      lng: toNum_(l.Longitude),
      tol: toNum_(l.Tolerance_m)
    }))
    .filter(l => l.name && isFinite(l.lat) && isFinite(l.lng) && isFinite(l.tol));

  let best = null;
  let nearest = null;
  locations.forEach(l => {
    const d = distance_(lat, lng, l.lat, l.lng);
    if (nearest === null || d < nearest) nearest = d;
    if (d <= l.tol && (!best || d < best.distance)) best = { location: l.name, distance: d };
  });

  if (best) return { valid: true, location: best.location, distance: best.distance };
  return { valid: false, nearestDistance: nearest };
}

// ============================================================
//  3. SIMPAN HASIL SCAN
// ============================================================

function submitScan_(req, session) {
  const status = req.status;
  if (status !== 'Check-in' && status !== 'Check-out') {
    return { ok: false, error: 'Status tidak valid' };
  }

  // Lokasi divalidasi ulang di server, bukan hanya di browser
  const loc = findLocation_(req.lat, req.lng);
  if (!loc.valid) {
    return { ok: true, saved: false, reason: 'LOCATION', message: 'Lokasi tidak terdaftar, hubungi Admin!' };
  }

  const scanned = clean_(req.toolsId).slice(0, 100);
  const tool = scanned && readSheet_(CONFIG.SHEET_TOOLS)
    .find(t => clean_(t.Tools_ID).toUpperCase() === scanned.toUpperCase());
  if (!tool) {
    return { ok: true, saved: false, reason: 'QR', message: 'QR Belum terdaftar' };
  }

  const toolsId = clean_(tool.Tools_ID);
  const timestamp = new Date().toISOString(); // contoh: 2026-05-15T07:41:23.295Z
  const row = [session.userId, toolsId, timestamp, loc.location, status];

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const sh = sheet_(CONFIG.SHEET_LOG);
    const r = sh.getLastRow() + 1;
    if (r > sh.getMaxRows()) sh.insertRowAfter(sh.getMaxRows());
    sh.getRange(r, 1, 1, row.length).setNumberFormat('@').setValues([row]);
  } finally {
    lock.releaseLock();
  }

  return {
    ok: true,
    saved: true,
    toolsId: toolsId,
    toolsName: clean_(tool.Tools_Name),
    timestamp: timestamp,
    location: loc.location,
    status: status
  };
}

// ============================================================
//  SETUP (jalankan sekali dari editor Apps Script)
// ============================================================

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(HEADERS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (TEXT_COLUMNS[name]) sh.getRange(TEXT_COLUMNS[name]).setNumberFormat('@');

    if (sh.getLastRow() === 0) {
      const h = HEADERS[name];
      sh.getRange(1, 1, 1, h.length).setValues([h]).setFontWeight('bold');
      sh.setFrozenRows(1);
      if (SAMPLES[name]) sh.getRange(2, 1, SAMPLES[name].length, h.length).setValues(SAMPLES[name]);
    }
  });
  Logger.log('Setup selesai. Isi sheet User, Location, dan Tools, lalu deploy sebagai Web App.');
}

// ============================================================
//  HELPER
// ============================================================

function sheet_(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh) throw new Error('Sheet "' + name + '" tidak ditemukan. Jalankan fungsi setup().');
  return sh;
}

/** Membaca sheet menjadi array objek berdasarkan header baris 1. */
function readSheet_(name) {
  const values = sheet_(name).getDataRange().getValues();
  if (values.length < 2) return [];
  const headers = values[0].map(h => String(h).trim());
  return values.slice(1).map(r => {
    const o = {};
    headers.forEach((h, i) => { o[h] = r[i]; });
    return o;
  });
}

function clean_(v) {
  return String(v === null || v === undefined ? '' : v).trim();
}

/** Angka aman: mendukung desimal koma (format Indonesia). Kosong -> NaN. */
function toNum_(v) {
  if (typeof v === 'number') return v;
  const s = clean_(v);
  if (s === '') return NaN;
  return Number(s.replace(',', '.'));
}

/** Kolom Aktif kosong = aktif. Isi FALSE / Tidak / No / 0 / Nonaktif = nonaktif. */
function isActive_(v) {
  if (v === false) return false;
  const s = clean_(v).toUpperCase();
  return ['FALSE', 'TIDAK', 'NO', '0', 'NONAKTIF'].indexOf(s) === -1;
}

/** Jarak dua koordinat dalam meter (rumus Haversine). */
function distance_(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
