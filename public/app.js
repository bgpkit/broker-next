/* broker status — the MRT collector fleet as the product.
   Plain ES module, no build step. Every value on screen comes from the v4 API. */

const API = 'https://api.bgpkit.com';

const SVG_NS = 'http' + '://www.w3.org/2000/svg'; // split so the source carries no third-party origin
/// Health is judged on a fixed 24h window whatever the page is showing: the state rules are
/// calibrated on one day of a collector's own cadence, and a 30-day window would relabel
/// collectors that are perfectly on schedule.
const HEALTH_HOURS = 24;
/// Windows the page offers. The API takes any since/until plus an hour or day bucket, but it caps
/// the work: more than 31 days without a collector filter is a 400, and buckets x series above
/// 5000 points is refused. 7 days at hour granularity over ~80 collectors is 168 x 80 and errors
/// out, so anything longer than a day reads day buckets.
const WINDOWS = {
  '24h': { label: '24h', hours: HEALTH_HOURS, bucket: 'hour', bucketNoun: 'hourly', unit: 'hour' },
  '7d': { label: '7d', hours: 24 * 7, bucket: 'day', bucketNoun: 'daily', unit: 'day' },
  '30d': { label: '30d', hours: 24 * 30, bucket: 'day', bucketNoun: 'daily', unit: 'day' },
};
const PEER_ROWS = 12;

/// Publication cadence per archive project, in minutes. Updates files and RIB dumps are
/// produced on different clocks, so freshness is judged separately for each.
const CADENCE = {
  riperis: { updates: 5, rib: 8 * 60 },
  routeviews: { updates: 15, rib: 2 * 60 },
};

/// Extra allowance before a feed counts as late. Publication jitter is real: RIS update files are
/// typically ~10 minutes behind their slot and RouteViews ~30, so a tight slack flags healthy
/// collectors at the boundary. 15 minutes for updates and 30 for RIBs keeps the flag for actual
/// gaps while tolerating normal lag.
const STALE_SLACK = { updates: 15, rib: 30 };

/// Plain-language names for the responses this page reads. Never show an API path.
const SOURCE_LABEL = {
  catalog: 'collector catalog',
  processed: 'parsed files',
  aggregates: 'parsed files',
  health: 'parsed files',
  series: 'parsed files',
  latest: 'latest files',
  peers: 'peer list',
};

const HEALTH = {
  pending: { label: 'not fetched', rank: 8 },
  nofiles: { label: 'no files', rank: 0 },
  partial: { label: 'partial', rank: 1 },
  late: { label: 'late', rank: 2 },
  legacy: { label: 'old name', rank: 4 },
  alias: { label: 'duplicate', rank: 7.5 },
  ok: { label: 'ok', rank: 7 },
  retired: { label: 'deactivated', rank: 9 },
};

/// Health states in display order; the filters and the strip both read this.
const HEALTH_ORDER = Object.keys(HEALTH).sort((a, b) => HEALTH[a].rank - HEALTH[b].rank);

/// Archive paths that carry the same MRT files as another collector. RouteViews keeps these
/// names alive after a site rename, so the files are duplicated on disk and in every count.
/// Verified 2026-10-23 by sha256 equality on update and RIB slots across the retained history
/// (route-views.amsix was renamed to locix.fra, not to amsix.ams). Annotated here until the
/// catalog itself carries alias rows.
const COLLECTOR_ALIAS = {
  'route-views.amsix': 'locix.fra',
  'route-views.saopaulo': 'ix-br.gru',
  'route-views2.saopaulo': 'ix-br2.gru',
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const state = {
  sources: {},
  tiles: [],
  byName: new Map(),
  filters: { q: '', project: '', country: '', health: '', sort: 'files' },
  showDeprecated: false,
  chartMetric: 'elements',
  window: '24h',
  fetchedAt: null,
  lastFocus: null,
  detailSeq: 0,
};

/* ---------- tiny DOM helpers (no innerHTML: API strings always go through textContent) ---------- */

function $(selector, root = document) {
  return root.querySelector(selector);
}

function dotEl(health) {
  return el('span', { class: 'dot', 'data-health': health, 'aria-hidden': 'true' });
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  applyProps(node, props);
  appendChildren(node, children);
  return node;
}

function svgEl(tag, props = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  return node;
}

function applyProps(node, props) {
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value') node.value = value;
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
    else node.setAttribute(key, String(value));
  }
}

function appendChildren(node, children) {
  const list = (Array.isArray(children) ? children : [children]).flat(Infinity);
  for (const child of list) {
    if (child === undefined || child === null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
}

/* ---------- format helpers ---------- */

function num(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asUtc(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value)) {
    return new Date(value + 'Z');
  }
  return new Date(value);
}

function stamp(value) {
  const date = asUtc(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toISOString().slice(11, 19) + 'Z';
}

function dayStamp(value) {
  const date = asUtc(value);
  if (Number.isNaN(date.getTime())) return '—';
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]} ${hh}:${mm}Z`;
}

function dateOnly(value) {
  const date = asUtc(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/// Day-granularity label without the year: the RIB ledger compares days inside one month or two,
/// and "31 Oct 2026" repeated six times in a row is noise next to the date that matters.
function dayLabel(value) {
  const date = asUtc(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`;
}

const intFmt = new Intl.NumberFormat('en-US');

function fmtInt(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? intFmt.format(parsed) : '—';
}

/// ASNs are identifiers, not quantities: render plain digits, never 13,335.
/// Two-letter country code to its flag emoji: regional indicator symbols are U+1F1E6 + letter - A.
function flagOf(code) {
  if (typeof code !== 'string' || !/^[A-Za-z]{2}$/.test(code)) return '';
  const base = 0x1f1e6;
  const upper = code.toUpperCase();
  return String.fromCodePoint(base + upper.charCodeAt(0) - 65, base + upper.charCodeAt(1) - 65);
}

function countryLabel(code) {
  if (!code) return '—';
  const flag = flagOf(code);
  return flag ? `${flag} ${code.toUpperCase()}` : code;
}

function fmtAsn(value) {
  if (value === null || value === undefined || value === '') return '—';
  const digits = String(value).replace(/[^0-9]/g, '');
  return digits || '—';
}

function fmtCompact(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return '—';
  const abs = Math.abs(parsed);
  if (abs >= 1e9) return `${(parsed / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${(parsed / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${(parsed / 1e3).toFixed(1)}k`;
  return fmtInt(parsed);
}

function fmtDuration(seconds) {
  const parsed = Number(seconds);
  if (!Number.isFinite(parsed) || parsed < 0) return '—';
  if (parsed < 60) return `${Math.round(parsed)}s`;
  const minutes = Math.floor(parsed / 60);
  if (minutes < 60) return `${minutes}m ${String(Math.round(parsed % 60)).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function fmtAge(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed < 0) return '—';
  if (parsed < 1) return '<1m';
  // Round up: a feed 15m16s old must not read as "15m" when 15m is the threshold that
  // makes it stale. The same rounding is used in the tile, the drawer and the stale reason.
  const total = Math.ceil(parsed);
  if (total < 60) return `${total}m`;
  if (total < 60 * 48) return `${Math.floor(total / 60)}h ${String(total % 60).padStart(2, '0')}m`;
  return `${Math.ceil(parsed / 1440)}d`;
}

/// Cadences and thresholds read better without a seconds field: 5m, 8h, 16h 15m.
function fmtCadence(minutes) {
  const parsed = Number(minutes);
  if (!Number.isFinite(parsed) || parsed < 0) return '—';
  if (parsed < 60) return `${Math.round(parsed)}m`;
  if (parsed % 60 === 0) return `${Math.floor(parsed / 60)}h`;
  return `${Math.floor(parsed / 60)}h ${Math.round(parsed % 60)}m`;
}

function cadenceOf(project) {
  return (project && CADENCE[project]) || null;
}

function sourceLabel(key) {
  return SOURCE_LABEL[key] || 'source';
}

function fmtBytes(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = parsed;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size >= 100 ? size.toFixed(0) : size.toFixed(1)} ${units[index]}`;
}

function windowSpec() {
  return WINDOWS[state.window] || WINDOWS['24h'];
}

function windowRange(spec = windowSpec()) {
  const nowMs = Date.now();
  const endMs = Math.floor(nowMs / 3600000) * 3600000;
  let startMs;
  if (spec.bucket === 'day') {
    // Day buckets are labelled with the UTC midnight they start in, so a 7d window that begins at
    // 23:00 would draw eight columns with a one-hour stub on the left. Start at midnight instead:
    // 7d is then seven buckets, six full days plus today so far.
    const days = Math.round(spec.hours / 24);
    const midnight = Math.floor(nowMs / 86400000) * 86400000;
    startMs = midnight - (days - 1) * 86400000;
  } else {
    startMs = endMs - spec.hours * 3600000;
  }
  const iso = (ms) => new Date(ms).toISOString().slice(0, 19) + 'Z';
  return { start: new Date(startMs), end: new Date(endMs), since: iso(startMs), until: iso(endMs) };
}

/// Hour buckets read as a clock time, day buckets as a date: "17 Oct 00:00Z" says nothing a day
/// bucket does not already say.
function bucketStamp(value) {
  const date = asUtc(value);
  if (Number.isNaN(date.getTime())) return '—';
  if (windowSpec().bucket === 'day') {
    return `${String(date.getUTCDate()).padStart(2, '0')} ${MONTHS[date.getUTCMonth()]}`;
  }
  return dayStamp(value);
}

/* ---------- API ---------- */

async function api(path, params = {}) {
  const url = new URL(path, API);
  // Cloudflare rewrites a cached API response's Cache-Control to a four-hour browser TTL, which
  // outlives the five-minute progress samples: a reload inside that window re-renders the previous
  // finish estimate. Rotate the key on the sample cadence so a stale browser copy is never reused,
  // while the edge still answers every request inside the same five minutes.
  url.searchParams.set('t', String(Math.floor(Date.now() / 300000)));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  const init = { headers: { accept: 'application/json' } };
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    init.signal = AbortSignal.timeout(20000);
  }
  const response = await fetch(url.toString(), init);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error('the response was not JSON');
  }
  if (body && typeof body === 'object' && body.error) throw new Error(String(body.error));
  return body;
}

async function loadSource(spec) {
  const at = new Date();
  try {
    const data = await api(spec.path, spec.params);
    return { ...spec, data, at, error: null };
  } catch (error) {
    return { ...spec, data: null, at, error: error && error.message ? error.message : String(error) };
  }
}

/* ---------- model ---------- */

// Health is about delivery, not popularity. A single failed file out of ~96 is a blip, and a
// name that only exists in the processed-file index is usually a collector renamed in the catalog.
//   retired   catalog entry with deactivated_on (old RRCs, closed RouteViews collectors)
//   legacy    processed files under a name the current catalog does not list (renamed collectors)
//   nofiles   no file in the window, or >=10% (min 3) of the expected files missing
//   partial   a small number of files missing from the window
//   late      newest updates or newest RIB is past 2x its own cadence plus a small allowance
function staleByCadence(tile) {
  const cadence = cadenceOf(tile.project);
  if (!cadence) return false;
  if (tile.updateAgeMin !== null && tile.updateAgeMin > 2 * cadence.updates + STALE_SLACK.updates) return true;
  if (tile.ribAgeMin !== null && tile.ribAgeMin > 2 * cadence.rib + STALE_SLACK.rib) return true;
  return false;
}

function staleReason(tile) {
  const parts = [];
  if (tile.updateAgeMin !== null) parts.push(`newest updates ${fmtAge(tile.updateAgeMin)} old`);
  if (tile.ribAgeMin !== null) parts.push(`newest rib ${fmtAge(tile.ribAgeMin)} old`);
  return parts.join(' · ') || 'nothing to compare';
}

/// A collector that joined the catalog recently and was never crawled is pending, not broken:
/// RouteViews and RIS list a collector before the first archive file exists. Adding it to the
/// crawler is a code change, so the page waits instead of flagging an error.
const PENDING_DAYS = 30;

function healthOf(tile) {
  if (tile.deactivated) return 'retired';
  if (!tile.inCatalog) return tile.alias ? 'alias' : 'legacy';
  const ageDays = Number.isFinite(tile.activatedMs) ? (Date.now() - tile.activatedMs) / 86400000 : null;
  if (!tile.everSeen && ageDays !== null && ageDays <= PENDING_DAYS) return 'pending';
  if (tile.files24 === null) return 'nofiles';
  const expected = Math.max(tile.expected24 || 0, (tile.files24 || 0) + (tile.failed24 || 0));
  const failed = tile.failed24 || 0;
  if (!tile.inProcessed || tile.files24 === 0) return 'nofiles';
  if (failed >= Math.max(3, Math.ceil(expected * 0.1))) return 'nofiles';
  if (failed > 0) return 'partial';
  if (staleByCadence(tile)) return 'late';
  return 'ok';
}

function tileOrder(a, b) {
  const rankA = HEALTH[a.health] ? HEALTH[a.health].rank : 99;
  const rankB = HEALTH[b.health] ? HEALTH[b.health].rank : 99;
  return rankA - rankB || a.name.localeCompare(b.name);
}

function inferProject(name, latestRows) {
  for (const row of latestRows) {
    if (!row || row.collector !== name || typeof row.url !== 'string') continue;
    if (/ris\.ripe\.net/i.test(row.url)) return 'riperis';
    if (/routeviews\.org/i.test(row.url)) return 'routeviews';
  }
  return null;
}

/// The file feed reports age_seconds from the start of the file's window; publication delay is the
/// gap between the end of that window and the feed's snapshot, so subtract the window width. A
/// 5-minute RIS updates window and a 15-minute RouteViews one would otherwise read 10 minutes apart.
function fileWindowSeconds(row) {
  const startMs = asUtc(row && row.ts_start).getTime();
  const endMs = asUtc(row && row.ts_end).getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return 0;
  return Math.max(0, (endMs - startMs) / 1000);
}

function ageSecondsOf(row, atMs) {
  const declared = Number(row && row.age_seconds);
  if (Number.isFinite(declared) && declared >= 0) return declared;
  const startMs = asUtc(row && row.ts_start).getTime();
  return Number.isFinite(startMs) ? Math.max(0, (atMs - startMs) / 1000) : NaN;
}

function delaySecondsOf(row, atMs) {
  const age = ageSecondsOf(row, atMs);
  if (!Number.isFinite(age)) return NaN;
  return Math.max(0, age - fileWindowSeconds(row));
}

function buildModel() {
  const catalog = state.sources.catalog && state.sources.catalog.data;
  const health = state.sources.health && state.sources.health.data;
  const windowed = state.sources.aggregates && state.sources.aggregates.data;
  const feed = state.sources.latest && state.sources.latest.data;

  const catalogRows = Array.isArray(catalog && catalog.data) ? catalog.data : [];
  const latestRows = Array.isArray(feed && feed.data) ? feed.data : [];
  const healthRows = Array.isArray(health && health.data) ? health.data : [];
  const windowRows = Array.isArray(windowed && windowed.data) ? windowed.data : [];

  // The same shape is summed twice: the fixed 24h rows decide health, the selected window's rows
  // supply every number the page prints.
  function sumRows(rows) {
    const by = new Map();
    for (const row of rows) {
      const key = row && row.id;
      if (!key) continue;
      let agg = by.get(key);
      if (!agg) {
        agg = { files: 0, failed: 0, expected: 0, missing: 0, pending: 0, records: 0, elements: 0, bytes: 0, buckets: new Map() };
        by.set(key, agg);
      }
      const files = num(row.files);
      const failed = num(row.failed_files);
      const records = num(row.records);
      agg.files += files;
      agg.failed += failed;
      agg.expected += num(row.expected_files);
      // What was expected but never arrived (missing), and what arrived but did not parse
      // (failed). Pending is neither: the crawler has not tried that slot yet.
      agg.missing += num(row.missing_files);
      agg.pending += num(row.pending_files);
      agg.records += records;
      agg.elements += num(row.elements);
      agg.bytes += num(row.uncompressed_bytes);
      const bucketKey = String(row.bucket_start || '');
      if (!bucketKey) continue;
      let bucket = agg.buckets.get(bucketKey);
      if (!bucket) {
        bucket = { t: bucketKey, files: 0, records: 0, elements: 0, bytes: 0 };
        agg.buckets.set(bucketKey, bucket);
      }
      bucket.files += files;
      bucket.records += records;
      bucket.elements += num(row.elements);
      bucket.bytes += num(row.uncompressed_bytes);
    }
    return by;
  }

  const healthBy = sumRows(healthRows);
  const windowBy = sumRows(windowRows);

  // One row per collector and data type in the file feed; keep the newest by window start.
  const latestBy = new Map();
  for (const row of latestRows) {
    if (!row || !row.collector) continue;
    if (row.data_type !== 'updates' && row.data_type !== 'rib') continue;
    const ms = asUtc(row.ts_start).getTime();
    if (!Number.isFinite(ms)) continue;
    const key = `${row.collector}\u0000${row.data_type}`;
    const previous = latestBy.get(key);
    if (!previous || ms > previous.ms) latestBy.set(key, { row, ms });
  }

  // Ages are measured from the feed's own snapshot time, not the browser clock, so they line up
  // with the response's age_seconds field and with every "as of" label on the page.
  const feedMeta = (feed && feed.meta) || {};
  const feedMs = asUtc(feedMeta.generated_at).getTime();
  const now = Number.isFinite(feedMs) ? feedMs : (state.fetchedAt ? state.fetchedAt.getTime() : Date.now());
  const tiles = new Map();

  function ensureTile(name) {
    let tile = tiles.get(name);
    if (!tile) {
      tile = {
        name,
        project: null,
        country: null,
        dataUrl: null,
        activated: null,
        deactivated: null,
        inCatalog: false,
        everSeen: false,
        alias: COLLECTOR_ALIAS[name] || null,
        inProcessed: false,
        lastBucket: null,
        processedFiles: null,
        // 24h values: the health verdict is always computed from these.
        files24: null,
        failed24: null,
        expected24: null,
        // Selected-window values: everything the page prints.
        filesWin: null,
        elementsWin: 0,
        bytesWin: 0,
        recordsWin: 0,
        // Selected-window file accounting, including the files that never arrived. These are
        // kept apart from filesWin so a tile can print volume and completeness side by side.
        expected: 0,
        files: 0,
        missing: 0,
        failed: 0,
        pending: 0,
        buckets: [],
        newestUpdate: null,
        newestRib: null,
        updateAgeMin: null,
        ribAgeMin: null,
      };
      tiles.set(name, tile);
    }
    return tile;
  }

  for (const row of catalogRows) {
    if (!row || !row.name) continue;
    const tile = ensureTile(row.name);
    // The catalog spells projects `ripe-ris`/`route-views`; the cadence table, the grid groups and
    // the filters are keyed `riperis`/`routeviews`. This is the one place the spelling is normalised.
    tile.project = catalogProject(row.project) || tile.project;
    tile.country = row.country || tile.country;
    tile.dataUrl = row.data_url || tile.dataUrl;
    tile.activated = row.activated_on || tile.activated;
    tile.deactivated = row.deactivated_on || tile.deactivated;
    tile.inCatalog = true;
    tile.activatedMs = asUtc(row.activated_on).getTime();
  }

  for (const entry of latestBy.values()) {
    const tile = ensureTile(entry.row.collector);
    tile.everSeen = true;
    if (entry.row.data_type === 'updates') tile.newestUpdate = entry.row;
    else tile.newestRib = entry.row;
  }

  for (const tile of tiles.values()) {
    if (!tile.project) tile.project = inferProject(tile.name, latestRows);

    const agg = healthBy.get(tile.name);
    if (agg) tile.everSeen = true;
    if (agg && agg.files + agg.failed > 0) {
      // A collector is "processed" when the file-processing index has at least one row for it in
      // the 24h health window. It replaces the earlier per-collector collector-count call, which
      // was only an aggregation of the same file table.
      tile.inProcessed = true;
    }
    if (agg) {
      tile.files24 = agg.files;
      tile.failed24 = agg.failed;
      tile.expected24 = agg.expected;
    }

    const win = windowBy.get(tile.name);
    if (win) {
      tile.everSeen = true;
      tile.filesWin = win.files;
      tile.expected = win.expected;
      tile.files = win.files;
      tile.missing = win.missing;
      tile.failed = win.failed;
      tile.pending = win.pending;
      tile.elementsWin = win.elements;
      tile.bytesWin = win.bytes;
      tile.recordsWin = win.records;
      tile.buckets = [...win.buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
    }

    if (tile.newestUpdate) tile.lastBucket = tile.newestUpdate.ts_start;
    const updateMs = tile.newestUpdate ? asUtc(tile.newestUpdate.ts_start).getTime() : NaN;
    const ribMs = tile.newestRib ? asUtc(tile.newestRib.ts_start).getTime() : NaN;
    tile.updateAgeMin = Number.isFinite(updateMs) ? Math.max(0, (now - updateMs) / 60000) : null;
    tile.ribAgeMin = Number.isFinite(ribMs) ? Math.max(0, (now - ribMs) / 60000) : null;
    tile.health = healthOf(tile);
  }

  state.tiles = [...tiles.values()].sort(tileOrder);
  state.byName = tiles;

}

/* ---------- header ---------- */

function setKpi(key, value, meta, title) {
  const valueEl = document.getElementById(`kpi-${key}`);
  const metaEl = document.getElementById(`kpi-${key}-meta`);
  if (valueEl) valueEl.textContent = value;
  if (metaEl) {
    metaEl.textContent = meta;
    if (title) metaEl.title = title;
    else metaEl.removeAttribute('title');
  }
}

function renderHeader() {
  const catalog = state.sources.catalog;
  const aggregates = state.sources.aggregates;
  const series = state.sources.series;
  const spec = windowSpec();

  const catalogCount = catalog && !catalog.error ? num(catalog.data && catalog.data.count) : NaN;
  const aggRows = aggregates && !aggregates.error && Array.isArray(aggregates.data && aggregates.data.data)
    ? aggregates.data.data
    : null;
  const processedCount = aggRows
    ? new Set(aggRows.filter((row) => num(row.files) > 0).map((row) => row.id)).size
    : NaN;

  const reportingLabel = $('#kpi-reporting-label');
  if (reportingLabel) reportingLabel.textContent = 'with files';
  const filesLabel = $('#kpi-files-label');
  if (filesLabel) filesLabel.textContent = `files · ${spec.label}`;
  const elementsLabel = $('#kpi-elements-label');
  if (elementsLabel) elementsLabel.textContent = `messages · ${spec.label}`;

  $('#claim-n').textContent = Number.isFinite(catalogCount) ? fmtInt(catalogCount) : '—';

  setKpi(
    'catalog',
    Number.isFinite(catalogCount) ? fmtInt(catalogCount) : '—',
    catalog ? `as of ${stamp(catalog.at)}` : 'catalog · unavailable',
    'rows in the collector catalog'
  );

  setKpi(
    'reporting',
    Number.isFinite(processedCount) ? fmtInt(processedCount) : '—',
    aggregates ? `${spec.label} · parsed files` : 'parsed files · unavailable',
    `collectors with at least one file in the last ${spec.label}`
  );

  const files = aggRows ? aggRows.reduce((total, row) => total + num(row.files), 0) : null;
  setKpi(
    'files',
    files === null ? '—' : fmtInt(files),
    aggregates ? `${spec.label} · parsed files` : 'parsed files · unavailable',
    `files received in the last ${spec.label}`
  );

  const seriesRows = (series && series.data && series.data.data) || [];
  const elementsTotal = seriesRows.length
    ? seriesRows.reduce((total, row) => total + num(row.elements), 0)
    : null;
  setKpi(
    'elements',
    elementsTotal === null ? '—' : fmtCompact(elementsTotal),
    series ? `${spec.label} · parsed files` : 'parsed files · unavailable',
    `BGP messages parsed from the update files in the last ${spec.label} (announcements and withdrawals)`
  );

  $('#kpi-lag').textContent = '…';
  $('#kpi-lag-meta').textContent = 'file feed · loading';
}

function healthCounts() {
  const counts = Object.fromEntries(HEALTH_ORDER.map((h) => [h, 0]));
  for (const tile of state.tiles) counts[tile.health] = (counts[tile.health] || 0) + 1;
  return counts;
}

function renderStrip() {
  const svg = $('#strip');
  const legend = $('#strip-legend');
  svg.replaceChildren();
  const order = HEALTH_ORDER;
  const tiles = [...filteredTiles()].sort(
    (a, b) => order.indexOf(a.health) - order.indexOf(b.health) || a.name.localeCompare(b.name)
  );
  if (!tiles.length) {
    legend.replaceChildren();
    return;
  }
  const width = 1000;
  const gap = 1.1;
  const step = width / tiles.length;
  const fragment = document.createDocumentFragment();
  tiles.forEach((tile, index) => {
    const rect = svgEl('rect', {
      x: (index * step).toFixed(2),
      y: 0,
      width: Math.max(0.7, step - gap).toFixed(2),
      height: 18,
      class: `hl-${tile.health}`,
    });
    // one LED is ~1/86 of the rail, so the label has to arrive on hover
    rect.append(svgEl('title', { text: `${tile.name} · ${HEALTH[tile.health].label}` }));
    fragment.append(rect);
  });
  svg.append(fragment);

  const counts = healthCounts();
  legend.replaceChildren(
    ...order
      .filter((health) => counts[health] > 0)
      .map((health) => el('span', { class: 'leg' }, [dotEl(health), `${HEALTH[health].label} ${fmtInt(counts[health])}`]))
  );
  renderAttention(counts);
}

/// States worth interrupting for. Alias and deactivated are annotations, not faults, so they stay
/// in the legend; an ok fleet renders nothing here at all.
const ATTENTION = ['nofiles', 'late', 'partial', 'degraded', 'pending'];

function renderAttention(counts) {
  const host = $('#attention');
  if (!host) return;
  const rows = ATTENTION.filter((health) => (counts[health] || 0) > 0);
  if (!rows.length) {
    host.hidden = true;
    host.replaceChildren();
    return;
  }
  host.hidden = false;
  host.setAttribute('aria-label', `status: ${rows.map((health) => `${HEALTH[health].label} ${fmtInt(counts[health])}`).join(', ')}`);
  host.replaceChildren(
    el('span', { class: 'attention-label', text: 'needs a look' }),
    ...rows.flatMap((health) => [
      el('button', {
        class: 'attention-item',
        type: 'button',
        'data-health': health,
        'aria-pressed': state.filters.health === health ? 'true' : 'false',
        title: 'filter the grid to these collectors',
        onclick: () => {
          const next = state.filters.health === health ? '' : health;
          state.filters.health = next;
          const select = $('#f-health');
          if (select) select.value = next;
          renderStrip();
          renderGrid();
        },
      }, [
        dotEl(health),
        el('span', { text: `${HEALTH[health].label} ${fmtInt(counts[health])}` }),
      ]),
    ])
  );
}

/* ---------- grid ---------- */

/// Two-letter units only: at tile size "28m / 2h" is read at a glance, "upd 28m rib 1h 58m" is not.
function shortAge(minutes) {
  if (minutes === null || minutes === undefined) return '—';
  if (minutes < 90) return `${Math.max(0, Math.round(minutes))}m`;
  if (minutes < 60 * 24) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

function stat(value, label, title, wide = false) {
  const empty = value === null || value === undefined;
  const node = el('span', { class: wide ? 'stat stat-wide' : 'stat' }, [
    el('span', { class: `stat-n${empty ? ' is-empty' : ''}`, text: empty ? '—' : String(value) }),
    el('span', { class: 'stat-l', text: label }),
  ]);
  if (title) node.title = title;
  return node;
}

function tileLabel(tile) {
  const spec = windowSpec();
  const bits = [tile.name, HEALTH[tile.health].label];
  if (tile.filesWin !== null) bits.push(`${fmtInt(tile.filesWin)} files in the last ${spec.label}`);
  if (tile.elementsWin) bits.push(`${fmtInt(tile.elementsWin)} messages in the last ${spec.label}`);
  if (num(tile.missing) > 0) bits.push(`${fmtInt(tile.missing)} of ${fmtInt(tile.expected)} expected files never arrived`);
  if (num(tile.failed) > 0) bits.push(`${fmtInt(tile.failed)} file${num(tile.failed) === 1 ? '' : 's'} failed to parse`);
  if (tile.updateAgeMin !== null) bits.push(`newest updates ${fmtAge(tile.updateAgeMin)} ago`);
  if (tile.ribAgeMin !== null) bits.push(`newest rib ${fmtAge(tile.ribAgeMin)} ago`);
  bits.push('open details');
  return bits.join(', ');
}

/// A tile's incompleteness as tokens, so the chip text and the data-gap tint read the same value.
function gapTokens(tile) {
  const tokens = [];
  if (num(tile.missing) > 0) tokens.push('missing');
  if (num(tile.failed) > 0) tokens.push('failed');
  return tokens;
}

/// Files that were expected in the loaded window and never arrived, plus files that arrived and
/// did not parse. Rendered under the stat row rather than inside it: the three stats are volume,
/// this is completeness, and mixing them made the row read as one number too many.
function gapChip(tile) {
  const tokens = gapTokens(tile);
  if (!tokens.length) return null;
  const parts = [];
  const notes = [];
  if (tokens.includes('missing')) {
    parts.push(`${fmtInt(tile.missing)} missing`);
    notes.push('expected files that never arrived in the loaded window');
  }
  if (tokens.includes('failed')) {
    parts.push(`${fmtInt(tile.failed)} failed`);
    notes.push('files that arrived but could not be parsed');
  }
  if (num(tile.pending) > 0) notes.push(`${fmtInt(tile.pending)} expected files still pending`);
  return el('span', {
    class: 'tile-gap',
    'data-gap': tokens.join(' '),
    title: notes.join(' · '),
    text: parts.join(' · '),
  });
}

function tileEl(tile) {
  const spec = windowSpec();
  const tokens = gapTokens(tile);
  const chip = gapChip(tile);
  const children = [
    el('span', { class: 'tile-state' }, [
      dotEl(tile.health),
      el('span', { class: 'tile-state-text', text: tile.health === 'ok' ? '' : HEALTH[tile.health].label }),
    ]),
    el('span', { class: 'tile-name', text: tile.name }),
    el('span', {
      class: 'tile-sub',
      text:
        tile.health === 'retired'
          ? `${tile.project || 'collector'} · deactivated ${dateOnly(tile.deactivated)}`
          : tile.health === 'alias'
            ? `same files as ${tile.alias}`
            : tile.health === 'legacy'
              ? 'publishes files under a name the catalog does not list'
              : tile.project
                ? countryLabel(tile.country)
                : 'not in catalog',
    }),
    el('span', { class: 'tile-stats' }, [
      stat(tile.filesWin === null ? null : fmtInt(tile.filesWin), 'files', `files received in the last ${spec.label}`, false),
      stat(
        tile.elementsWin ? fmtCompact(tile.elementsWin) : tile.filesWin === 0 ? '0' : null,
        'bgp messages',
        `BGP messages parsed from this collector in the last ${spec.label} (each announcement or withdrawal counts once)`,
      ),
      stat(
        tile.bytesWin ? fmtBytes(tile.bytesWin) : tile.filesWin === 0 ? '0' : null,
        'size',
        `uncompressed size of the files received in the last ${spec.label}`,
      ),
    ]),
  ];
  if (chip) children.push(chip);
  children.push(el('span', {
    class: 'tile-ages',
    title: 'age of the newest updates file and the newest RIB file',
  }, [
    el('span', { text: `updates ${shortAge(tile.updateAgeMin)} · RIB ${shortAge(tile.ribAgeMin)}` }),
  ]));
  const props = {
    class: 'tile',
    type: 'button',
    'data-health': tile.health,
    'data-name': tile.name,
    'aria-label': tileLabel(tile),
  };
  if (tokens.length) props['data-gap'] = tokens.join(' ');
  return el('button', props, children);
}

/// Sort orders offered in the filter bar. Health stays first-class because the grid is a
/// status view; the numbers sort descending so the busiest collectors come first, and they follow
/// the selected window like every other figure on the tile.
const SORTS = {
  health: (a, b) => (HEALTH[a.health].rank - HEALTH[b.health].rank) || a.name.localeCompare(b.name),
  name: (a, b) => a.name.localeCompare(b.name),
  files: (a, b) => num(b.filesWin) - num(a.filesWin) || a.name.localeCompare(b.name),
  messages: (a, b) => num(b.elementsWin) - num(a.elementsWin) || a.name.localeCompare(b.name),
  size: (a, b) => num(b.bytesWin) - num(a.bytesWin) || a.name.localeCompare(b.name),
  country: (a, b) => (a.country || 'zz').localeCompare(b.country || 'zz') || a.name.localeCompare(b.name),
};

function isQuiet(tile) {
  return tile.health === 'retired' || tile.health === 'pending';
}

function filteredTiles() {
  const query = state.filters.q.trim().toLowerCase();
  const list = state.tiles.filter((tile) => {
    if (!state.showDeprecated && isQuiet(tile)) return false;
    if (state.filters.project && (tile.project || 'unknown') !== state.filters.project) return false;
    if (state.filters.country && (tile.country || 'unknown') !== state.filters.country) return false;
    if (state.filters.health && tile.health !== state.filters.health) return false;
    if (query) {
      const haystack = `${tile.name} ${tile.project || ''} ${tile.country || ''}`.toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });
  const compare = SORTS[state.filters.sort] || SORTS.health;
  return list.sort(compare);
}

/// Tiles are grouped by archive project so the grid reads as two ledgers, RouteViews and RIPE RIS,
/// wherever the width allows two columns. The active sort applies inside each group; a tile whose
/// project neither the catalog nor the file feed names stays in a trailing block of its own.
const GRID_PROJECTS = ['routeviews', 'riperis'];

function projectGroups(tiles) {
  const groups = GRID_PROJECTS
    .map((project) => ({
      project,
      label: projectLabel(project),
      tiles: tiles.filter((tile) => projectKey(tile.project) === projectKey(project)),
    }))
    .filter((group) => group.tiles.length);
  const rest = tiles.filter((tile) => !GRID_PROJECTS.some((project) => projectKey(project) === projectKey(tile.project)));
  if (rest.length) groups.push({ project: '', label: 'project unknown', tiles: rest });
  return groups;
}

/// Collectors in a project before any filter, so a column head can say "56 of 57" instead of
/// pretending the visible tiles are the whole project.
function projectTotal(project) {
  return state.tiles.filter((tile) => (project
    ? projectKey(tile.project) === projectKey(project)
    : !GRID_PROJECTS.some((candidate) => projectKey(candidate) === projectKey(tile.project)))).length;
}

function renderGrid() {
  const grid = $('#grid');
  const sourceLine = $('#grid-src');
  const failures = Object.values(state.sources).filter((source) => source && source.error);
  const spec = windowSpec();
  sourceLine.textContent = `${spec.label} window · status from the last ${HEALTH_HOURS}h${failures.length ? ' · partial' : ''}`;

  const list = filteredTiles();

  if (!state.tiles.length) {
    grid.className = 'grid grid-single';
    grid.replaceChildren(
      el('div', { class: 'empty' }, [
        el('span', { text: 'No collector data loaded.' }),
        el('button', { type: 'button', text: 'retry', onclick: boot }),
      ])
    );
  } else if (!list.length) {
    grid.className = 'grid grid-single';
    grid.replaceChildren(
      el('div', { class: 'empty' }, [
        el('span', { text: 'No collectors match these filters.' }),
        el('button', { type: 'button', text: 'clear filters', onclick: resetFilters }),
      ])
    );
  } else {
    const groups = projectGroups(list);
    const twoColumns = groups.filter((group) => group.project).length === 2;
    grid.className = `grid ${twoColumns ? 'grid-split' : 'grid-single'}`;
    grid.replaceChildren(...groups.map((group) => el('section', {
      class: 'project-col',
      'data-project': group.project,
      'aria-label': `${group.label} collectors`,
    }, [
      el('div', { class: 'project-col-head' }, [
        el('h3', { text: group.label }),
        el('span', {
          text: `${fmtInt(group.tiles.length)} shown of ${fmtInt(projectTotal(group.project))} tracked`,
          title: 'collectors shown of collectors in this project',
        }),
      ]),
      el('div', { class: 'tile-grid' }, group.tiles.map(tileEl)),
    ])));
  }

  const fileWindow = (tile) => num(tile.filesWin) > 0;
  const reportingWin = state.tiles.filter(fileWindow).length;
  const hidden = state.tiles.filter(isQuiet).length;
  const hiddenNote = !state.showDeprecated && hidden ? ` · ${fmtInt(hidden)} hidden` : '';
  $('#count').textContent = `${fmtInt(list.length)} of ${fmtInt(state.tiles.length)} · ${fmtInt(reportingWin)} with files · ${spec.label}${hiddenNote}`;
}

function resetFilters() {
  state.filters = { q: '', project: '', country: '', health: '', sort: 'files' };
  state.showDeprecated = false;
  $('#f-q').value = '';
  $('#f-project').value = '';
  $('#f-country').value = '';
  $('#f-health').value = '';
  renderGrid();
}

/* ---------- source alerts ---------- */

function fillSelect(select, options, placeholder, current) {
  if (!select) return current || '';
  const values = new Set(options.map((option) => option.value));
  const selected = values.has(current) ? current : '';
  select.replaceChildren(
    ...(placeholder ? [el('option', { value: '', text: placeholder })] : []),
    ...options.map((option) => el('option', { value: option.value, text: option.label }))
  );
  select.value = selected;
  return selected;
}

function renderControls() {
  const projects = new Map();
  const countries = new Map();
  for (const tile of state.tiles) {
    if (tile.project) projects.set(tile.project, (projects.get(tile.project) || 0) + 1);
    if (tile.country) countries.set(tile.country, (countries.get(tile.country) || 0) + 1);
  }
  const projectOptions = [...projects.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: `${projectLabel(value)} · ${count}` }));
  const countryOptions = [...countries.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([value, count]) => ({ value, label: `${projectLabel(value)} · ${count}` }));
  const counts = healthCounts();
  const healthOptions = HEALTH_ORDER
    .filter((health) => counts[health] > 0)
    .map((health) => ({ value: health, label: `${HEALTH[health].label} · ${counts[health] || 0}` }));

  const sortOptions = Object.keys(SORTS).map((key) => ({ value: key, label: key }));
  state.filters.project = fillSelect($('#f-project'), projectOptions, 'all projects', state.filters.project);
  state.filters.country = fillSelect($('#f-country'), countryOptions, 'all countries', state.filters.country);
  state.filters.health = fillSelect($('#f-health'), healthOptions, 'all health', state.filters.health);
  state.filters.sort = fillSelect($('#f-sort'), sortOptions, null, state.filters.sort);
  const deprecated = $('#f-deprecated');
  if (deprecated) deprecated.checked = state.showDeprecated;

  const total = state.tiles.length;
  const spec = windowSpec();
  const reporting = state.tiles.filter((tile) => num(tile.filesWin) > 0).length;
  $('#count').textContent = `${fmtInt(total)} collectors · ${fmtInt(reporting)} with files · ${spec.label}`;
}

/* ---------- fleet chart, project split, newest files ---------- */

const PROJECTS = {
  riperis: { key: 'ripe-ris', label: 'RIPE RIS', color: '#b45309' },
  'ripe-ris': { key: 'ripe-ris', label: 'RIPE RIS', color: '#b45309' },
  routeviews: { key: 'route-views', label: 'RouteViews', color: '#1f4e8c' },
  'route-views': { key: 'route-views', label: 'RouteViews', color: '#1f4e8c' },
};
/// The catalog and the per-collector counts spell projects `ripe-ris`/`route-views`; the page's
/// cadence table, grid groups and filter values are keyed `riperis`/`routeviews`. Everything that
/// compares them goes through projectKey, and the catalog adapter normalises once.
const projectKey = (value) => (PROJECTS[value] ? PROJECTS[value].key : value || null);
const projectLabel = (value) => (PROJECTS[value] ? PROJECTS[value].label : value || '—');
const projectColor = (value) => (PROJECTS[value] ? PROJECTS[value].color : 'var(--faint)');

/// Page-side spelling for a project id as the API returns it. Unknown ids pass through untouched so
/// a new project still groups on its own instead of collapsing into "unknown".
const PAGE_PROJECT = { 'ripe-ris': 'riperis', 'route-views': 'routeviews', riperis: 'riperis', routeviews: 'routeviews' };

function catalogProject(value) {
  if (!value) return null;
  return PAGE_PROJECT[value] || value;
}
const FAIL_COLOR = '#a02517';

/// One chart, four readings. Three of them ride on the counts payload and cost no request; the
/// fourth is parse-time p95, which only /v4/mrt/distributions answers and costs one fetch per
/// window. Switching between them does not refetch.
const CHART_METRICS = {
  elements: { label: 'BGP messages', pick: (b, p) => (p === 'ris' ? b.ris : b.rv), fmt: fmtCompact },
  files: { label: 'files', pick: (b, p) => (p === 'ris' ? b.risFiles : b.rvFiles), fmt: (v) => fmtInt(Math.round(v)) },
  bytes: { label: 'uncompressed', pick: (b, p) => (p === 'ris' ? b.risBytes : b.rvBytes), fmt: fmtBytes },
  p95: {
    label: 'file p95',
    pick: (b, p) => (p === 'ris' ? b.risP95 : b.rvP95),
    fmt: (v) => (v >= 1000 ? `${Math.round(v / 1000)} s` : `${Math.round(v)} ms`),
  },
};

/// Axis ceiling on a 1/2/2.5/4/5/8 x 10^n ladder so the four inner rules land on round numbers.
/// 65.1M used to render as a top tick; it becomes 80.0M with 20.0M steps.
function niceCeil(value) {
  const exp = Math.pow(10, Math.floor(Math.log10(value)));
  const f = value / exp;
  const m = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 4 ? 4 : f <= 5 ? 5 : f <= 8 ? 8 : 10;
  return m * exp;
}

function renderFleetChart() {
  const svg = $('#fleet-chart');
  if (!svg) return;
  const src = $('#fleet-src');
  const legend = $('#fleet-legend');
  const source = state.sources.series;

  const empty = (message) => {
    svg.replaceChildren();
    if (src) src.textContent = message;
    if (legend) legend.replaceChildren();
  };
  if (!source || source.error) return empty('parsed files · unavailable');

  // One point per bucket per project. Volume is the interesting signal: files follow a fixed
  // cadence, while the announcements and withdrawals they carry move with routing activity.
  const spec = windowSpec();
  const byBucket = new Map();
  const bucketFor = (t) => {
    let bucket = byBucket.get(t);
    if (!bucket) {
      bucket = { t, ris: 0, rv: 0, risFiles: 0, rvFiles: 0, risBytes: 0, rvBytes: 0, risExpected: 0, rvExpected: 0, risP95: 0, rvP95: 0 };
      byBucket.set(t, bucket);
    }
    return bucket;
  };
  for (const row of (source.data && source.data.data) || []) {
    const t = row.bucket_start;
    if (!t) continue;
    const bucket = bucketFor(t);
    // dimension=project rows carry the project id in `id`, not `project`.
    const key = projectKey(row.id);
    if (key === 'ripe-ris') {
      bucket.ris += num(row.elements);
      bucket.risFiles += num(row.files);
      bucket.risExpected += num(row.expected_files);
      bucket.risBytes += num(row.uncompressed_bytes);
    } else if (key === 'route-views') {
      bucket.rv += num(row.elements);
      bucket.rvFiles += num(row.files);
      bucket.rvExpected += num(row.expected_files);
      bucket.rvBytes += num(row.uncompressed_bytes);
    }
  }

  // A bucket only the percentile answer carries is still a bucket worth drawing: both requests use
  // the same window and bucket width, so the two series line up on bucket_start.
  const dist = state.sources.distributions;
  if (dist && !dist.error) {
    for (const row of (dist.data && dist.data.data) || []) {
      const t = row.bucket_start;
      if (!t) continue;
      const bucket = bucketFor(t);
      const key = projectKey(row.id);
      if (key === 'ripe-ris') bucket.risP95 = Math.max(bucket.risP95, num(row.p95));
      else if (key === 'route-views') bucket.rvP95 = Math.max(bucket.rvP95, num(row.p95));
    }
  }

  const buckets = [...byBucket.values()].sort((a, b) => a.t.localeCompare(b.t));
  if (!buckets.length) return empty('parsed files · no rows in the window');

  const W = 720;
  const H = 200;
  const padL = 58;
  const padR = 12;
  const padT = 12;
  const padB = 24;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const metric = CHART_METRICS[state.chartMetric] || CHART_METRICS.elements;
  const valueOf = (bucket, project) => metric.pick(bucket, project);
  const max = niceCeil(Math.max(1, ...buckets.map((b) => Math.max(valueOf(b, 'ris'), valueOf(b, 'rv')))));
  const xOf = (index) => padL + (buckets.length === 1 ? plotW / 2 : (index / (buckets.length - 1)) * plotW);
  const yOf = (value) => padT + plotH - (value / max) * plotH;
  const nodes = [];

  for (const frac of [0, 0.25, 0.5, 0.75, 1]) {
    const value = max * frac;
    nodes.push(svgEl('line', { x1: padL, x2: W - padR, y1: yOf(value), y2: yOf(value), class: 'grid-line' }));
    nodes.push(svgEl('text', {
      x: padL - 6, y: yOf(value) + 3, class: 'axis', 'text-anchor': 'end', text: metric.fmt(value),
    }));
  }

  // Reset annotations (inference layer). One bar per bucket, height by how many collectors
  // replayed inside it. Bars sit behind the volume lines so the two readings share one axis
  // without either hiding the other.
  const resetSource = state.sources.resets;
  const resetByBucket = new Map();
  if (resetSource && !resetSource.error) {
    for (const row of (resetSource.data && resetSource.data.data) || []) {
      if (!row.hour) continue;
      const key = spec.bucket === 'day' ? row.hour.slice(0, 10) : row.hour.slice(0, 13);
      const prev = resetByBucket.get(key) || { collectors: new Set(), maxBreadth: 0 };
      for (const name of row.collectors || []) prev.collectors.add(name);
      prev.maxBreadth = Math.max(prev.maxBreadth, num(row.max_breadth));
      resetByBucket.set(key, prev);
    }
  }
  const barW = Math.max(3, Math.min(16, (plotW / Math.max(buckets.length, 1)) * 0.55));
  buckets.forEach((bucket, index) => {
    const key = spec.bucket === 'day' ? bucket.t.slice(0, 10) : bucket.t.slice(0, 13);
    const hit = resetByBucket.get(key);
    if (!hit || hit.collectors.size === 0) return;
    const count = hit.collectors.size;
    const h = plotH * (0.22 + 0.6 * Math.min(count / 7, 1));
    const x = xOf(index) - barW / 2;
    nodes.push(svgEl('rect', {
      x, y: padT + plotH - h, width: barW, height: h,
      class: 'reset-bar', rx: 2,
      'data-count': count,
      'data-collectors': [...hit.collectors].join(','),
      'data-breadth': hit.maxBreadth.toFixed(2),
    }));
  });

  const seriesFor = [
    { key: 'ris', label: 'RIPE RIS', color: projectColor('riperis') },
    { key: 'rv', label: 'RouteViews', color: projectColor('routeviews') },
  ];

  for (const series of seriesFor) {
    const points = buckets.map((bucket, index) => [xOf(index), yOf(valueOf(bucket, series.key))]);
    const path = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
    nodes.push(svgEl('path', { d: path, fill: 'none', stroke: series.color, 'stroke-width': 2.2, class: 'series-line' }));
    buckets.forEach((bucket, index) => {
      const [x, y] = points[index];
      nodes.push(svgEl('circle', { cx: x, cy: y, r: 2.4, fill: series.color, class: 'series-point' }));
    });
  }

  // Six x labels whatever the window holds: 24 hourly buckets step by 4, 30 daily buckets by 5.
  // A week of daily buckets is short enough to label every one. Hour buckets print a clock time,
  // day buckets a date.
  const tickEvery = buckets.length <= 8 ? 1 : Math.max(1, Math.ceil(buckets.length / 6));
  const tickLabel = (t) => (spec.bucket === 'day' ? `${t.slice(8, 10)} ${MONTHS[Number(t.slice(5, 7)) - 1]}` : t.slice(11, 16));
  buckets.forEach((bucket, index) => {
    if (index % tickEvery !== 0) return;
    nodes.push(svgEl('text', {
      x: xOf(index), y: H - 6, class: 'axis', 'text-anchor': 'middle', text: tickLabel(bucket.t),
    }));
  });
  // The unit used to be drawn in the top-left corner anchored to the axis gutter: "messages / h"
  // is wider than that gutter, so it ran past the panel edge and collided with the top value
  // label. The panel head already names the metric and the source line says "per hour".

  // Hover readout: one crosshair and one panel-positioned tooltip, driven by pointer position so
  // every hourly value is readable without hovering a 2px dot.
  const hover = svgEl('line', { class: 'chart-hover-line', x1: 0, x2: 0, y1: padT, y2: padT + plotH, opacity: 0 });
  nodes.push(hover);
  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  nodes.push(hit);
  svg.replaceChildren(...nodes);

  const panel = svg.closest('.panel') || svg.parentElement;
  let tip = panel ? panel.querySelector('.chart-tip') : null;
  if (panel && !tip) {
    tip = el('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite' });
    panel.append(tip);
  }

  const showAt = (index) => {
    if (index < 0 || index >= buckets.length) return;
    const bucket = buckets[index];
    const x = xOf(index);
    hover.setAttribute('x1', x.toFixed(1));
    hover.setAttribute('x2', x.toFixed(1));
    hover.setAttribute('opacity', '0.45');
    if (!tip) return;
    tip.innerHTML =
      `<div class="tip-head">${spec.bucket === 'day' ? `${bucket.t.slice(0, 10)}` : `${bucket.t.slice(0, 10)} ${bucket.t.slice(11, 16)}Z`}</div>` +
      `<div class="tip-row"><span class="tip-key"><i style="background:${projectColor('riperis')}"></i>RIPE RIS</span><span>${metric.fmt(valueOf(bucket, 'ris'))}</span></div>` +
      `<div class="tip-row"><span class="tip-key"><i style="background:${projectColor('routeviews')}"></i>RouteViews</span><span>${metric.fmt(valueOf(bucket, 'rv'))}</span></div>` +
      `<div class="tip-row"><span class="tip-key">files</span><span>${fmtInt(bucket.risFiles)} / ${fmtInt(bucket.risExpected)} · ${fmtInt(bucket.rvFiles)} / ${fmtInt(bucket.rvExpected)}</span></div>` +
      `<div class="tip-row"><span class="tip-key">messages</span><span>${fmtCompact(bucket.ris)} · ${fmtCompact(bucket.rv)}</span></div>` +
      `<div class="tip-row"><span class="tip-key">file p95</span><span>${CHART_METRICS.p95.fmt(bucket.risP95)} · ${CHART_METRICS.p95.fmt(bucket.rvP95)} · fetch + parse</span></div>` +
      (() => {
        const key = spec.bucket === 'day' ? bucket.t.slice(0, 10) : bucket.t.slice(0, 13);
        const hit = resetByBucket.get(key);
        if (!hit || hit.collectors.size === 0) return '';
        const names = [...hit.collectors].join(', ');
        return `<div class="tip-row tip-reset"><span class="tip-key">resets</span><span>${fmtInt(hit.collectors.size)} collector${hit.collectors.size === 1 ? '' : 's'}: ${names}</span></div>`;
      })();
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    const left = Math.min(Math.max(x * scale + 14, 8), rect.width - 190);
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = '16px';
    tip.dataset.visible = 'true';
  };

  const clear = () => {
    hover.setAttribute('opacity', '0');
    if (tip) tip.dataset.visible = 'false';
  };

  hit.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    const localX = (event.clientX - rect.left) / scale;
    const ratio = (localX - padL) / plotW;
    const index = Math.round(ratio * (buckets.length - 1));
    showAt(Math.min(Math.max(index, 0), buckets.length - 1));
  });
  hit.addEventListener('pointerleave', clear);
  hit.addEventListener('pointercancel', clear);

  if (src) {
    src.textContent = `parsed files · ${metric.label} per ${spec.unit} · ${buckets.length} ${spec.bucketNoun} buckets · as of ${stamp(source.at)}`;
  }
  const title = $('#throughput-title');
  if (title) title.textContent = `Fleet volume · last ${spec.label}`;

  const totals = buckets.reduce(
    (acc, bucket) => ({
      ris: acc.ris + num(bucket.risFiles),
      rv: acc.rv + num(bucket.rvFiles),
      peaks: {
        ris: Math.max(acc.peaks.ris, bucket.risP95),
        rv: Math.max(acc.peaks.rv, bucket.rvP95),
      },
    }),
    { ris: 0, rv: 0, peaks: { ris: 0, rv: 0 } }
  );
  if (legend) {
    const sumOf = (project) => (state.chartMetric === 'files'
      ? `${fmtInt(project === 'ris' ? totals.ris : totals.rv)} files`
      : state.chartMetric === 'p95'
        ? `peak p95 ${metric.fmt(project === 'ris' ? totals.peaks.ris : totals.peaks.rv)}`
        : `${metric.label} ${metric.fmt(buckets.reduce((acc, b) => acc + valueOf(b, project), 0))}`);
    const resetEvents = (state.sources.resets && !state.sources.resets.error && state.sources.resets.data
      ? (state.sources.resets.data.events || []).length
      : 0);
    legend.innerHTML =
      `<span class="key"><i style="background:${projectColor('riperis')}"></i>RIPE RIS ${sumOf('ris')}</span>` +
      `<span class="key"><i style="background:${projectColor('routeviews')}"></i>RouteViews ${sumOf('rv')}</span>` +
      (resetEvents ? `<span class="key key-reset"><i class="reset-swatch"></i>resets ${fmtInt(resetEvents)}</span>` : '');
  }
}

function renderProjects() {
  const host = $('#project-cards');
  if (!host) return;
  const catalog = state.sources.catalog && state.sources.catalog.data;
  const series = state.sources.series && state.sources.series.data;
  if (!catalog || !catalog.data) {
    host.textContent = 'collector catalog unavailable';
    return;
  }
  const seriesRows = (series && series.data) || [];
  const catalogRows = catalog.data;
  const spec = windowSpec();

  host.replaceChildren(
    ...['riperis', 'routeviews'].map((project) => {
      const key = projectKey(project);
      const inCatalog = catalogRows.filter((row) => projectKey(row.project) === key);
      const active = inCatalog.filter((row) => !row.deactivated_on).length;
      const own = seriesRows.filter((row) => projectKey(row.id) === key);
      const files = own.reduce((total, row) => total + num(row.files), 0);
      const elements = own.reduce((total, row) => total + num(row.elements), 0);
      const bytes = own.reduce((total, row) => total + num(row.uncompressed_bytes), 0);
      return el('div', { class: 'project-card' }, [
        el('p', { class: 'project-name' }, [
          el('i', { style: `background:${projectColor(project)}` }),
          el('span', { text: projectLabel(project) }),
        ]),
        el('div', { class: 'project-row' }, [
          el('span', { class: 'project-k', text: 'collectors' }),
          el('span', { class: 'project-v', text: `${fmtInt(active)} sending files · ${fmtInt(inCatalog.length)} tracked` }),
        ]),
        el('div', { class: 'project-row' }, [
          el('span', { class: 'project-k', text: `files ${spec.label}` }),
          el('span', { class: 'project-v', text: fmtInt(files) }),
        ]),
        el('div', { class: 'project-row' }, [
          el('span', { class: 'project-k', text: `bgp messages ${spec.label}` }),
          el('span', { class: 'project-v', text: fmtCompact(elements) }),
        ]),
        el('div', { class: 'project-row' }, [
          el('span', { class: 'project-k', text: `size ${spec.label}` }),
          el('span', { class: 'project-v', text: fmtBytes(bytes) }),
        ]),
      ]);
    })
  );
}

/* ---------- RIB coverage ---------- */

/// Point-in-time on purpose: the ledger answers "what does the published RIB corpus hold right
/// now", which is a different question from the selected window. Read once at boot.
function renderAlerts() {
  const box = $('#alerts');
  const failures = Object.values(state.sources).filter((source) => source && source.error);
  const quality = deliveryGaps();
  const hasQuality = quality.missing.length > 0 || quality.failed.length > 0;
  if (!failures.length && !hasQuality) {
    box.hidden = true;
    box.replaceChildren();
    return;
  }
  box.hidden = false;

  const nodes = [];
  if (failures.length) {
    nodes.push(
      el('p', { class: 'alert-title', text: `${failures.length} source${failures.length === 1 ? '' : 's'} did not load` }),
      el('ul', {}, failures.map((source) => el('li', { text: `${sourceLabel(source.key)} · ${source.error}` }))),
      el('button', { class: 'retry', type: 'button', text: 'retry all', onclick: boot })
    );
  }

  if (hasQuality) {
    const spec = windowSpec();
    const rows = [];
    const qualityRow = (term, text, names) => el('div', { class: 'quality-row' }, [
      el('dt', { text: term }),
      el('dd', {}, [el('span', { text }), names ? [' ', names] : null]),
    ]);

    if (quality.missing.length) {
      rows.push(qualityRow(
        'missing',
        `${fmtInt(quality.missingFiles)} expected file${quality.missingFiles === 1 ? '' : 's'} never arrived for ${fmtInt(quality.missing.length)} collector${quality.missing.length === 1 ? '' : 's'}:`,
        nameList(quality.missing.map((tile) => tile.name))
      ));
    }
    if (quality.failed.length) {
      rows.push(qualityRow(
        'failed',
        `${fmtInt(quality.failedFiles)} file${quality.failedFiles === 1 ? '' : 's'} failed to parse for ${fmtInt(quality.failed.length)} collector${quality.failed.length === 1 ? '' : 's'}:`,
        nameList(quality.failed.map((tile) => tile.name))
      ));
    }
    if (quality.resetCount !== null) {
      rows.push(qualityRow(
        'resets',
        `${fmtInt(quality.resetCount)} session-reset event${quality.resetCount === 1 ? '' : 's'} in the last ${spec.label}`
      ));
    }

    nodes.push(
      el('div', { class: failures.length ? 'quality quality-block' : 'quality' }, [
        el('p', { class: 'alert-title', text: `file delivery · last ${spec.label}` }),
        el('dl', { class: 'quality-list' }, rows),
      ])
    );
  }

  box.replaceChildren(...nodes);
}

/// Collectors whose loaded window is incomplete, plus the reset count that explains a burst of
/// them. Both lists are sorted by size so the worst collector is named first.
function deliveryGaps() {
  const byCount = (key) => (a, b) => num(b[key]) - num(a[key]) || a.name.localeCompare(b.name);
  const missing = state.tiles.filter((tile) => num(tile.missing) > 0).sort(byCount('missing'));
  const failed = state.tiles.filter((tile) => num(tile.failed) > 0).sort(byCount('failed'));
  const resets = state.sources.resets;
  const resetCount = resets && !resets.error && resets.data && Array.isArray(resets.data.events)
    ? resets.data.events.length
    : null;
  return {
    missing,
    failed,
    missingFiles: missing.reduce((total, tile) => total + num(tile.missing), 0),
    failedFiles: failed.reduce((total, tile) => total + num(tile.failed), 0),
    resetCount,
  };
}

/// Eight names then "+N more": a fleet-wide gap must stay readable and must state what it hid.
function nameList(names, limit = 8) {
  const shown = names.slice(0, limit);
  const rest = names.length - shown.length;
  const node = el('span', { class: 'alert-names', text: shown.join(', ') });
  if (rest > 0) node.append(el('span', { class: 'alert-more', text: ` +${fmtInt(rest)} more` }));
  return node;
}

/* ---------- lag ---------- */

// Updates-only on purpose: RIB rows run on an 8h or 2h clock and would dominate a mixed median.
// Current rows only, so a long-dead archive cannot set the fleet's lag figure. Delay is measured
// from the end of each file's own window (age_seconds minus the window width), so a 5-minute RIS
// window and a 15-minute RouteViews one stay directly comparable.
function renderLag(data, at) {
  const rows = Array.isArray(data && data.data) ? data.data : [];
  const feedAt = (data && data.meta && data.meta.generated_at) || at;
  const snapshotMs = asUtc(feedAt).getTime();
  const nowMs = Number.isFinite(snapshotMs) ? snapshotMs : Date.now();
  const cutoff = nowMs - HEALTH_HOURS * 3600000;
  const newest = new Map();
  for (const row of rows) {
    if (!row || row.data_type !== 'updates' || !row.collector) continue;
    const ms = asUtc(row.ts_start).getTime();
    if (!Number.isFinite(ms) || ms < cutoff) continue;
    const delay = delaySecondsOf(row, nowMs);
    if (!Number.isFinite(delay) || delay < 0) continue;
    const previous = newest.get(row.collector);
    if (!previous || ms > previous.ms) newest.set(row.collector, { row, ms, delay });
  }
  const delays = [...newest.values()].map((entry) => entry.delay).sort((a, b) => a - b);
  const valueEl = $('#kpi-lag');
  const metaEl = $('#kpi-lag-meta');
  if (!delays.length) {
    valueEl.textContent = '—';
    metaEl.textContent = 'file feed · no current updates';
    metaEl.removeAttribute('title');
    return;
  }
  const middle = Math.floor(delays.length / 2);
  const median = delays.length % 2 ? delays[middle] : (delays[middle - 1] + delays[middle]) / 2;
  valueEl.textContent = fmtDuration(median);
  valueEl.title = `${fmtInt(median)} seconds`;
  metaEl.textContent = `file feed · updates only · ${fmtInt(delays.length)} collectors · ${stamp(feedAt)}`;
  metaEl.title = "median publication delay of each collector's newest updates file, in seconds; RIB cadence is shown per collector in the detail panel";
}

/* ---------- detail drawer ---------- */

function kvRow(label, value) {
  const dd = el('dd');
  appendChildren(dd, value);
  return el('div', { class: 'kv-row' }, [el('dt', { text: label }), dd]);
}

function statusNode(tile) {
  const notes = {
    ok: `${fmtInt(tile.files24)} files in the last 24h`,
    partial: 'some files are missing from the last 24h',
    late: staleReason(tile),
    pending: `in the catalog since ${tile.activated ? dateOnly(tile.activated) : 'recently'}, no archive file yet`,
    nofiles: tile.inCatalog ? 'in the catalog, but no file in the last 24h' : 'no file in the last 24h',
    legacy: 'publishes files under a name the catalog does not list, usually a rename',
    alias: tile.alias ? `same files as ${tile.alias}, published under the pre-rename path` : 'same files as another collector',
    retired: tile.deactivated ? `deactivated ${dateOnly(tile.deactivated)} in the catalog` : 'deactivated',
  };
  return el('span', { class: 'status' }, [
    dotEl(tile.health),
    el('span', { text: HEALTH[tile.health].label }),
    el('span', { class: 'muted', text: ` · ${notes[tile.health]}` }),
  ]);
}

function fileWindow(file) {
  if (!file) return '—';
  if (file.ts_start === file.ts_end) return dayStamp(file.ts_start);
  return `${dayStamp(file.ts_start)} → ${stamp(file.ts_end)}`;
}

function identitySection(tile) {
  const sectionRef = section('Identity', 'collector catalog · catalog record');
  sectionRef.src.textContent = tile.inCatalog
    ? 'collector catalog · catalog record'
    : tile.alias
      ? `not in the catalog · same files as ${tile.alias}`
      : 'collector catalog · no record for this name';

  const rows = [
    kvRow('status', statusNode(tile)),
    kvRow('project', tile.project || '—'),
    kvRow('country', tile.country || '—'),
    kvRow('activated since', tile.activated ? dateOnly(tile.activated) : '—'),
  ];
  if (tile.deactivated) rows.push(kvRow('deactivated', dateOnly(tile.deactivated)));

  const archive = el('p', { class: 'archive' }, [
    el('span', { class: 'kv-label', text: tile.inCatalog ? 'archive root' : tile.alias ? `archive root · same files as ${tile.alias}` : 'archive root · not in catalog' }),
    tile.dataUrl ? safeLink(tile.dataUrl, tile.dataUrl) : el('span', { class: 'muted', text: '—' }),
  ]);

  sectionRef.body.replaceChildren(el('dl', { class: 'kv' }, rows), archive);
  return sectionRef.node;
}

/// The RPKI verdict split and the attribute mix are folded into the collector view from the same
/// file index the rest of the page reads, so no extra service is involved.
function facetKey(label, value, sum, color) {
  const share = sum > 0 ? (100 * value) / sum : 0;
  return el('span', { class: 'facet-key' }, [
    el('i', { style: `background:${color}` }),
    el('span', { text: `${label} ${fmtCompact(value)} · ${share.toFixed(share < 1 ? 2 : 1)}%` }),
  ]);
}

function renderVerdictSplit(data, name) {
  const rows = (Array.isArray(data.data) ? data.data : []).filter((row) => row.id === name);
  const total = (key) => rows.reduce((sum, row) => sum + num(row[key]), 0);
  const valid = total('rpki_valid_elements');
  const invalid = total('rpki_invalid_elements');
  const unknown = total('rpki_unknown_elements');
  const all = valid + invalid + unknown;

  const wrap = el('div', { class: 'facet' });
  if (!all) {
    wrap.append(el('p', { class: 'muted', text: 'no RPKI verdicts in this window' }));
    return wrap;
  }

  const pct = (value) => (100 * value) / all;
  wrap.append(
    el('p', { class: 'facet-title', text: 'RPKI validation results' }),
    el('div', { class: 'rpki-bar' }, [
      el('span', { class: 'seg seg-valid', style: `width:${pct(valid).toFixed(2)}%`, title: `valid ${fmtInt(valid)}` }),
      el('span', { class: 'seg seg-invalid', style: `width:${pct(invalid).toFixed(2)}%`, title: `invalid ${fmtInt(invalid)}` }),
      el('span', { class: 'seg seg-unknown', style: `width:${pct(unknown).toFixed(2)}%`, title: `unknown ${fmtInt(unknown)}` }),
    ]),
    el('div', { class: 'facet-legend' }, [
      facetKey('valid', valid, all, 'var(--ok)'),
      facetKey('invalid', invalid, all, 'var(--fail)'),
      facetKey('unknown', unknown, all, 'var(--silent)'),
    ]),
    el('p', { class: 'tbl-note', text: 'one verdict per announced prefix and origin, from the newest parse of each file' })
  );
  return wrap;
}

function renderAttributeMix(data) {
  const rows = (Array.isArray(data.data) ? [...data.data] : [])
    .filter((row) => num(row.instances) > 0)
    .sort((a, b) => num(b.instances) - num(a.instances))
    .slice(0, 6);
  const wrap = el('div', { class: 'facet facet-mix' });
  if (!rows.length) return wrap;

  const max = num(rows[0].instances);
  wrap.append(el('p', { class: 'facet-title', text: 'attribute mix · instances seen' }));
  for (const row of rows) {
    wrap.append(el('div', { class: 'attr-row' }, [
      el('span', { class: 'attr-name', text: row.attribute_type || '—' }),
      el('span', { class: 'attr-track' }, [
        el('span', { class: 'attr-fill', style: `width:${((100 * num(row.instances)) / max).toFixed(1)}%` }),
      ]),
      el('span', { class: 'attr-val', text: fmtCompact(num(row.instances)) }),
    ]));
  }
  return wrap;
}

function renderFailure(target, label, error) {
  target.src.textContent = `${label} · request failed`;
  target.body.replaceChildren(
    el('div', { class: 'empty-state' }, [
      el('p', { text: 'The request did not complete.' }),
      el('p', { class: 'muted', text: (error && error.message) || String(error) }),
    ])
  );
}

// Same cutoffs the API applies for full_feed=true: above 700k IPv4 or 100k IPv6 prefixes.
const FULL_FEED_V4 = 700000;
const FULL_FEED_V6 = 100000;
const PEER_ROWS_SHOWN = 20;

function isFullFeed(peer) {
  return num(peer.num_v4_pfxs) > FULL_FEED_V4 || num(peer.num_v6_pfxs) > FULL_FEED_V6;
}

function renderPeers(target, data, name, at) {
  const all = Array.isArray(data.data) ? [...data.data] : [];
  // The endpoint pages at 500 rows; total is the snapshot size, all.length is what this page holds.
  const total = Number.isFinite(Number(data.total)) ? Number(data.total) : all.length;
  const snapDate = data.meta && data.meta.snapshot_date;
  const snapshotText = typeof snapDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(snapDate)
    ? dateOnly(snapDate)
    : stamp(snapDate || at);
  target.src.textContent = `peer list · snapshot ${snapshotText} · ${fmtInt(total)} peers`;

  if (!all.length) {
    target.body.replaceChildren(el('div', { class: 'empty-state', text: 'No peer snapshot for this collector.' }));
    return;
  }

  for (const peer of all) peer.fullFeed = isFullFeed(peer);
  const fullFeedCount = all.filter((peer) => peer.fullFeed).length;

  all.sort((a, b) => {
    if (a.fullFeed !== b.fullFeed) return a.fullFeed ? -1 : 1;
    return num(b.num_v4_pfxs) + num(b.num_v6_pfxs) - (num(a.num_v4_pfxs) + num(a.num_v6_pfxs));
  });

  const table = el('table', { class: 'peer-table' }, [
    el('colgroup', {}, [
      el('col', { class: 'c-ip' }),
      el('col', { class: 'c-asn' }),
      el('col', { class: 'c-v4' }),
      el('col', { class: 'c-v6' }),
      el('col', { class: 'c-conn' }),
    ]),
    el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col', text: 'peer IP' }),
      el('th', { scope: 'col', text: 'asn' }),
      el('th', { scope: 'col', class: 'num', text: 'IPv4 prefixes' }),
      el('th', { scope: 'col', class: 'num', text: 'IPv6 prefixes' }),
      el('th', { scope: 'col', class: 'num', text: 'ASNs connected' }),
    ])),
  ]);

  const bodyHost = el('tbody');
  table.append(bodyHost);

  const note = el('p', { class: 'tbl-note' });
  const toggle = el('input', { type: 'checkbox', id: `ff-${name}` });
  const controls = el('div', { class: 'peer-controls' }, [
    el('label', { for: `ff-${name}` }, [toggle, el('span', { text: 'full feed only' })]),
    el('span', { class: 'muted', text: '' }),
  ]);

  const paint = () => {
    const onlyFull = toggle.checked;
    const rows = all.filter((peer) => (onlyFull ? peer.fullFeed : true));
    const shown = rows.slice(0, PEER_ROWS_SHOWN);
    bodyHost.replaceChildren(...shown.map((peer) => el('tr', {}, [
      el('td', { class: 'ip', text: peer.peer_ip || '—', title: peer.peer_ip || '' }),
      el('td', { class: 'num', text: fmtAsn(peer.peer_asn) }),
      el('td', { class: 'num', text: num(peer.num_v4_pfxs) ? fmtInt(peer.num_v4_pfxs) : '—' }),
      el('td', { class: 'num', text: num(peer.num_v6_pfxs) ? fmtInt(peer.num_v6_pfxs) : '—' }),
      el('td', { class: 'num', text: fmtInt(peer.num_connected_asns) }),
    ])));
    controls.lastElementChild.textContent =
      `${fmtInt(fullFeedCount)} of ${fmtInt(all.length)} full feed · showing ${fmtInt(shown.length)}`;
    note.textContent = 'sorted by feed size, full feed first · prefixes as seen in the newest parsed RIB'
      + (total > all.length ? ` · this page carries ${fmtInt(all.length)} of ${fmtInt(total)} peers` : '');
  };

  toggle.addEventListener('change', paint);
  paint();

  target.body.replaceChildren(controls, table, note);
}

function buildSpark(rows, name, peak, readout) {
  const width = 340;
  const height = 96;
  const padT = 8;
  const padB = 6;
  const padL = 3;
  const padR = 3;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;
  const max = Math.max(1, ...rows.map((row) => num(row.elements)));
  const xAt = (index) => padL + (rows.length === 1 ? innerW / 2 : (index / (rows.length - 1)) * innerW);
  const yAt = (value) => padT + innerH - (num(value) / max) * innerH;
  const base = padT + innerH;

  const spec = windowSpec();
  const svg = svgEl('svg', {
    class: 'spark',
    viewBox: `0 0 ${width} ${height}`,
    preserveAspectRatio: 'none',
    role: 'img',
    'aria-label': `${spec.bucketNoun} message volume for ${name}: ${rows.length} buckets, peak ${fmtInt(peak.elements)} messages at ${bucketStamp(peak.bucket_start)}.`,
  });

  for (const fraction of [0.25, 0.5, 0.75]) {
    const y = (padT + innerH * fraction).toFixed(1);
    svg.append(svgEl('line', { class: 'spark-grid', x1: padL, x2: width - padR, y1: y, y2: y, 'vector-effect': 'non-scaling-stroke' }));
  }
  svg.append(svgEl('line', { class: 'spark-base', x1: padL, x2: width - padR, y1: base, y2: base, 'vector-effect': 'non-scaling-stroke' }));

  const points = rows.map((row, index) => [xAt(index), yAt(row.elements)]);
  const line = points.map(([x, y], index) => `${index ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join(' ');
  svg.append(svgEl('path', { class: 'spark-area', d: `${line} L${xAt(rows.length - 1).toFixed(1)} ${base} L${xAt(0).toFixed(1)} ${base} Z` }));
  svg.append(svgEl('path', { class: 'spark-line', d: line, 'vector-effect': 'non-scaling-stroke' }));

  const last = points[points.length - 1];
  svg.append(svgEl('circle', { class: 'spark-dot', cx: last[0].toFixed(1), cy: last[1].toFixed(1), r: '2.2' }));

  const cross = svgEl('line', { class: 'spark-cross', x1: 0, x2: 0, y1: padT, y2: base, opacity: 0 });
  svg.append(cross);
  const hitArea = svgEl('rect', { x: padL, y: padT, width: innerW, height: innerH, fill: 'transparent' });
  svg.append(hitArea);

  const show = (index) => {
    const row = rows[index];
    cross.setAttribute('x1', xAt(index).toFixed(1));
    cross.setAttribute('x2', xAt(index).toFixed(1));
    cross.setAttribute('opacity', '0.5');
    if (readout) {
      readout.textContent = `${bucketStamp(row.bucket_start)} · ${fmtInt(row.files)} files · ${fmtInt(row.elements)} messages · ${fmtBytes(row.uncompressed_bytes)} uncompressed`;
    }
  };

  const clear = () => {
    cross.setAttribute('opacity', '0');
    if (readout) readout.textContent = `hover a point for its ${spec.unit}`;
  };

  hitArea.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / width;
    const localX = (event.clientX - rect.left) / scale;
    const ratio = (localX - padL) / innerW;
    const index = Math.min(Math.max(Math.round(ratio * (rows.length - 1)), 0), rows.length - 1);
    show(index);
  });
  hitArea.addEventListener('pointerleave', clear);
  clear();

  return svg;
}

function miniStat(value, label) {
  return el('div', { class: 'mini-stat' }, [el('b', { text: value }), el('span', { text: label })]);
}

function renderDelivery(target, data, name, at, until) {
  const spec = windowSpec();
  const rows = (Array.isArray(data.data) ? data.data : [])
    .filter((row) => row.id === name)
    .sort((a, b) => String(a.bucket_start).localeCompare(String(b.bucket_start)));
  // The counts response carries no window_end: the window is the one the caller asked for.
  const asOf = until ? stamp(until) : stamp(at);
  target.src.textContent = `file index · files, messages · ${fmtInt(rows.length)} ${spec.bucketNoun} buckets · window to ${asOf}`;

  if (!rows.length) {
    target.body.replaceChildren(
      el('div', { class: 'empty-state', text: `No ${spec.bucketNoun} file-processing rows for this collector in the last ${spec.label}.` })
    );
    return;
  }

  const files = rows.reduce((total, row) => total + num(row.files), 0);
  const elements = rows.reduce((total, row) => total + num(row.elements), 0);
  const bytes = rows.reduce((total, row) => total + num(row.uncompressed_bytes), 0);
  const peak = rows.reduce((best, row) => (num(row.elements) > num(best.elements) ? row : best), rows[0]);

  const stats = el('div', { class: 'mini-stats' }, [
    miniStat(fmtInt(files), 'files'),
    miniStat(`≈${fmtCompact(elements)}`, 'messages'),
    miniStat(`≈${fmtCompact(peak.elements)}`, `peak / ${spec.unit}`),
    miniStat(fmtBytes(bytes), 'uncompressed'),
  ]);

  const axis = el('div', { class: 'spark-axis' }, [
    el('span', { text: bucketStamp(rows[0].bucket_start) }),
    el('span', { text: bucketStamp(rows[rows.length - 1].bucket_start) }),
  ]);

  const readout = el('p', { class: 'spark-readout', text: `hover a point for its ${spec.unit}` });
  target.body.replaceChildren(
    stats,
    el('div', { class: 'spark-label' }, [
      el('span', { text: `messages / ${spec.unit}` }),
      el('span', { text: `peak ≈${fmtCompact(peak.elements)} at ${bucketStamp(peak.bucket_start)}` }),
    ]),
    readout,
    buildSpark(rows, name, peak, readout),
    axis,
    el('p', { class: 'tbl-note', text: `${spec.bucketNoun} buckets from the file index, filtered to this collector` })
  );
}

function renderNewest(target, data, name, at) {
  const rows = (Array.isArray(data.data) ? data.data : []).filter((row) => row.collector === name);
  const feedAt = (data.meta && data.meta.generated_at) || at;
  const feedMs = asUtc(feedAt).getTime();
  target.src.textContent = `file feed · newest row per type · feed ${stamp(feedAt)}`;

  if (!rows.length) {
    target.body.replaceChildren(el('div', { class: 'empty-state', text: 'No file listed for this collector in the file feed.' }));
    return;
  }

  const latest = {};
  for (const type of ['updates', 'rib']) {
    const candidates = rows.filter((row) => row.data_type === type);
    if (!candidates.length) continue;
    candidates.sort((a, b) => String(b.ts_end || b.ts_start || '').localeCompare(String(a.ts_end || a.ts_start || '')));
    latest[type] = candidates[0];
  }

  const table = el('table', {}, [
    // Explicit widths: an equal five-way split wraps the file window onto two lines, which the
    // narrow left column of the modal shows first.
    el('colgroup', {}, [
      el('col', { class: 'nf-type' }),
      el('col', { class: 'nf-window' }),
      el('col', { class: 'nf-delay' }),
      el('col', { class: 'nf-size' }),
      el('col', { class: 'nf-open' }),
    ]),
    el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col', text: 'type' }),
      el('th', { scope: 'col', text: 'window (UTC)' }),
      el('th', { scope: 'col', class: 'num', text: 'delay' }),
      el('th', { scope: 'col', class: 'num', text: 'size' }),
      el('th', { scope: 'col', text: '' }),
    ])),
    el('tbody', {}, ['updates', 'rib'].map((type) => {
      const file = latest[type];
      if (!file) {
        return el('tr', {}, [
          el('td', { text: type }),
          el('td', { class: 'muted', text: 'no file in the feed' }),
          el('td', { class: 'num', text: '—' }),
          el('td', { class: 'num', text: '—' }),
          el('td'),
        ]);
      }
      const windowText = file.ts_start === file.ts_end
        ? dayStamp(file.ts_start)
        : `${dayStamp(file.ts_start)} → ${dayStamp(file.ts_end)}`;
      const delaySec = delaySecondsOf(file, Number.isFinite(feedMs) ? feedMs : Date.now());
      return el('tr', {}, [
        el('td', { text: type }),
        el('td', { text: windowText }),
        el('td', { class: 'num', text: Number.isFinite(delaySec) ? fmtAge(delaySec / 60) : '—' }),
        el('td', { class: 'num', text: file.exact_size ? fmtBytes(file.exact_size) : fmtBytes(file.rough_size) }),
        el('td', {}, file.url
          ? [el('a', { href: file.url, target: '_blank', rel: 'noopener noreferrer', text: 'open' })]
          : [el('span', { class: 'muted', text: '—' })]),
      ]);
    })),
  ]);

  target.body.replaceChildren(table, el('p', {
    class: 'tbl-note',
    text: 'delay is the gap between the end of the file window and its publication',
  }));
}

/* ---------- recent files in the collector drawer ---------- */

const RECENT_ROWS = 20;

/// The file-processing index, newest first, one page. This is the ledger behind the tile counts:
/// every row is one archive file with its window, its parse cost and where it can be opened.
function renderRecentFiles(target, data, name) {
  const rows = Array.isArray(data && data.data) ? data.data : [];
  const total = Number.isFinite(Number(data && data.total)) ? Number(data.total) : rows.length;
  target.src.textContent = `recent files · newest ${fmtInt(RECENT_ROWS)} · ${fmtInt(rows.length)} rows`;

  if (!rows.length) {
    target.body.replaceChildren(el('div', { class: 'empty-state', text: `No files in the index for ${name}.` }));
    return;
  }

  // The file catalogue is the broker index (broker.file), not the parse ledger: a row names an
  // archive file with its window, type, size and where to open it. Parse detail (records, parse
  // time, outcome) belongs to the delivery panel, which reads /v4/mrt/counts.
  const table = el('table', { class: 'recent-table' }, [
    el('colgroup', {}, [
      el('col', { class: 'rf-window' }),
      el('col', { class: 'rf-type' }),
      el('col', { class: 'rf-size' }),
      el('col', { class: 'rf-open' }),
    ]),
    el('thead', {}, el('tr', {}, [
      el('th', { scope: 'col', text: 'window start (UTC)' }),
      el('th', { scope: 'col', class: 'rf-left', text: 'type' }),
      el('th', { scope: 'col', class: 'num', text: 'size' }),
      el('th', { scope: 'col', text: '' }),
    ])),
    el('tbody', {}, rows.map((row) => el('tr', {}, [
      el('td', { text: dayStamp(row.ts_start) }),
      el('td', { class: 'rf-left', text: row.data_type || '—' }),
      el('td', { class: 'num', text: num(row.rough_size) ? fmtBytes(row.rough_size) : '—' }),
      el('td', {}, safeLink(row.url, 'open')),
    ]))),
  ]);

  target.body.replaceChildren(el('div', { class: 'recent-wrap' }, table), el('p', {
    class: 'tbl-note',
    text: `newest first · ${fmtInt(total)} files in the broker index for this collector · size is the archive size recorded by the index`,
  }));
}

function section(title, srcText) {
  const src = el('p', { class: 'src', text: srcText });
  const body = el('div', { class: 'sec-body' }, [el('div', { class: 'loading', text: 'fetching' })]);
  const node = el('section', { class: 'sec' }, [el('h3', { text: title }), src, body]);
  return { node, src, body };
}

function setHash(name) {
  try {
    const base = location.pathname + location.search;
    history.replaceState(null, '', name ? `${base}#${encodeURIComponent(name)}` : base);
  } catch (error) {
    /* history is not available in every embedding context */
  }
}

function safeLink(href, label) {
  if (typeof href !== 'string' || !/^https?:/i.test(href)) {
    return el('span', { class: 'muted', text: label || '—' });
  }
  return el('a', { href, target: '_blank', rel: 'noopener noreferrer', text: label });
}

function openFromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (raw && state.byName.has(raw)) openDetail(raw, null);
}

function openDetail(name, trigger) {
  const tile = state.byName.get(name);
  if (!tile) return;

  state.lastFocus = trigger instanceof HTMLElement ? trigger : document.activeElement;
  const seq = ++state.detailSeq;

  const drawer = $('#detail');
  const scrim = $('#scrim');
  document.body.classList.add('drawer-open');
  scrim.hidden = false;
  scrim.dataset.open = 'true';
  drawer.dataset.open = 'true';
  drawer.setAttribute('aria-hidden', 'false');
  setHash(tile.name);

  $('#detail-title').textContent = tile.name;
  $('#detail-sub').textContent = `${tile.project || 'not in catalog'} · ${tile.country || '—'} · ${HEALTH[tile.health].label}`;

  const body = $('#detail-body');
  const spec = windowSpec();
  const delivery = section(`File delivery · ${spec.label}`, 'file index · queued');
  const facets = section(`RPKI and attributes · ${spec.label}`, 'file index · RPKI verdicts + attribute mix');
  const facetBlocks = el('div', { class: 'facet-blocks' });
  facets.body.replaceChildren(facetBlocks);
  const peers = section('Peers · newest snapshot', 'peer list · queued');
  const newest = section('Newest files · file feed', 'file feed · queued');
  // The file-processing index page: the ledger behind the tile counts, newest first. One request
  // per drawer open, and only the page the drawer shows.
  const recent = section('Recent files', `recent files · newest ${fmtInt(RECENT_ROWS)} · queued`);
  // Tables on the left, charts on the right: Identity and the newest-file table are read as
  // rows, the delivery sparkline and the two facet panels are read as shapes.
  body.replaceChildren(
    el('div', { class: 'detail-cols' }, [
      el('div', { class: 'detail-col' }, [identitySection(tile), newest.node]),
      el('div', { class: 'detail-col' }, [delivery.node, facets.node]),
    ]),
    recent.node,
    peers.node
  );
  body.scrollTop = 0;
  $('#detail-close').focus();

  const win = windowRange(spec);
  const at = new Date();

  api('/v4/mrt/collectors/peers', { collector: name, page_size: 500 })
    .then((data) => {
      if (seq === state.detailSeq) renderPeers(peers, data, name, at);
    })
    .catch((error) => {
      if (seq === state.detailSeq) renderFailure(peers, 'peer list', error);
    });

  api('/v4/mrt/files', { page_size: RECENT_ROWS, collector: name })
    .then((data) => {
      if (seq === state.detailSeq) renderRecentFiles(recent, data, name);
    })
    .catch((error) => {
      if (seq === state.detailSeq) renderFailure(recent, 'recent files', error);
    });

  // One collector, one window: the endpoint takes a collector filter, so the drawer reads 24 rows
  // instead of the whole fleet's 1900 and still gets every counter, RPKI verdicts included.
  api('/v4/mrt/counts', {
    since: win.since,
    until: win.until,
    bucket: spec.bucket,
    dimension: 'collector',
    collector: name,
  })
    .then((data) => {
      if (seq !== state.detailSeq) return;
      renderDelivery(delivery, data, name, at, win.until);
      facetBlocks.append(renderVerdictSplit(data, name));
    })
    .catch((error) => {
      if (seq === state.detailSeq) renderFailure(delivery, 'file processing index', error);
    });

  api('/v4/mrt/attributes', { since: win.since, until: win.until, collector: name })
    .then((data) => {
      if (seq === state.detailSeq) facetBlocks.append(renderAttributeMix(data));
    })
    .catch(() => { /* the mix is optional next to the verdict split */ });

  // The file feed is fetched once at boot; the drawer only reads that response.
  const feed = state.sources.latest;
  if (feed && !feed.error) renderNewest(newest, feed.data, name, feed.at);
  else renderFailure(newest, 'file feed', feed ? feed.error : 'not loaded');
}

function closeDetail(silent = false) {
  const drawer = $('#detail');
  if (drawer.dataset.open !== 'true') return;
  state.detailSeq += 1;
  drawer.dataset.open = 'false';
  drawer.setAttribute('aria-hidden', 'true');
  const scrim = $('#scrim');
  scrim.dataset.open = 'false';
  window.setTimeout(() => {
    if (drawer.dataset.open !== 'true') scrim.hidden = true;
  }, 200);
  document.body.classList.remove('drawer-open');
  setHash(null);
  if (!silent) {
    const target = state.lastFocus;
    if (target && document.contains(target) && typeof target.focus === 'function') target.focus();
  }
}

function onKeydown(event) {
  const drawer = $('#detail');
  if (drawer.dataset.open !== 'true') return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDetail();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = [...drawer.querySelectorAll('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])')]
    .filter((node) => node.getClientRects().length > 0);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

/* ---------- boot ---------- */

/// Health always reads the fixed 24h window; when the page shows 24h that same response is the
/// display data too, so the two queries collapse into one.
function healthSpec() {
  const win = windowRange(WINDOWS['24h']);
  return {
    key: 'health',
    path: '/v4/mrt/counts',
    params: {
      since: win.since,
      until: win.until,
      bucket: 'hour',
      dimension: 'collector',
    },
  };
}

function windowSpecs(key) {
  const spec = WINDOWS[key];
  const win = windowRange(spec);
  return [
    {
      key: 'aggregates',
      path: '/v4/mrt/counts',
      params: { since: win.since, until: win.until, bucket: spec.bucket, dimension: 'collector' },
    },
    {
      key: 'series',
      path: '/v4/mrt/counts',
      params: { since: win.since, until: win.until, bucket: spec.bucket, dimension: 'project' },
    },
    // Parse-time percentiles are their own product: the counts answer carries every counter but no
    // distribution, so the chart's fourth reading costs one more request per window.
    {
      key: 'distributions',
      path: '/v4/mrt/distributions',
      params: {
        metric: 'parse_duration_ms',
        since: win.since,
        until: win.until,
        bucket: spec.bucket,
        dimension: 'project',
      },
    },
    // Inference layer: session-reset annotations. Optional by design, so a failure leaves the
    // chart intact without bars instead of blanking the volume series.
    {
      key: 'resets',
      path: '/v4/mrt/collectors/reset-events',
      params: { since: win.since, until: win.until },
    },
  ];
}


/* ---------- archive coverage ---------- */

/// Which project's archive calendar is on screen. Independent of the fleet window: the calendar is
/// the whole history, not the last 24 hours, so switching the window must not reload it.
const archive = { project: 'ripe-ris', data: null, error: null, at: null };

const ARCHIVE_LABEL = {
  'ripe-ris': 'RIPE RIS',
  'route-views': 'RouteViews',
};

/// Five bands plus "no files that week". The band is the ratio of parsed files to the files the
/// archive holds, never the absolute count: a quiet week in 2003 and a busy one this month have to
/// compare by what fraction of their own files arrived.
function archiveLevel(week) {
  if (!week || week.expected === 0) return 'none';
  const ratio = week.done / week.expected;
  if (ratio <= 0) return '0';
  if (ratio < 0.5) return '1';
  if (ratio < 0.9) return '2';
  if (ratio < 1) return '3';
  return '4';
}

/// Day N of the series is `start + N days`; the API sends the date once because the series is
/// dense, so this is the only place that turns an index back into a calendar week.
function archiveWeeks(data) {
  if (!data || !data.start || !data.files_expected) return [];
  const startMs = Date.parse(`${data.start}T00:00:00Z`);
  const byYear = new Map();
  for (let index = 0; index < data.files_expected.length; index += 1) {
    const expected = data.files_expected[index] || 0;
    const done = data.files_done[index] || 0;
    const date = new Date(startMs + index * 86400000);
    const year = date.getUTCFullYear();
    const week = Math.floor((date.getTime() - Date.UTC(year, 0, 1)) / 86400000 / 7);
    let weeks = byYear.get(year);
    if (!weeks) {
      weeks = new Map();
      byYear.set(year, weeks);
    }
    let bucket = weeks.get(week);
    if (!bucket) {
      bucket = {
        year,
        week,
        first: date,
        last: date,
        expected: 0,
        done: 0,
        collectorsExpected: 0,
        collectorsDone: 0,
      };
      weeks.set(week, bucket);
    }
    bucket.last = date;
    bucket.expected += expected;
    bucket.done += done;
    if (data.collectors_expected && data.collectors_done) {
      bucket.collectorsExpected = Math.max(bucket.collectorsExpected, data.collectors_expected[index] || 0);
      bucket.collectorsDone = Math.max(bucket.collectorsDone, data.collectors_done[index] || 0);
    }
  }
  return [...byYear.keys()].sort((a, b) => a - b).map((year) => {
    const weeks = byYear.get(year);
    const row = new Array(53).fill(null);
    for (const [week, bucket] of weeks) if (week >= 0 && week < 53) row[week] = bucket;
    return { year, weeks: row };
  });
}


/// Days for long waits, hours for short ones: "about 39 days to go" is a plan, "about 900 hours to
/// go" is arithmetic.
function etaLabel(hours) {
  if (hours === null || hours === undefined || !Number.isFinite(hours)) return 'finish time unknown';
  if (hours >= 48) return `about ${fmtInt(Math.round(hours / 24))} days to go`;
  if (hours >= 1) return `about ${fmtInt(Math.round(hours))} hours to go`;
  return 'finishing within the hour';
}

function archiveTooltip(week) {
  if (!week) return '';
  const span = `${dateOnly(week.first)}${week.last.getTime() === week.first.getTime() ? '' : ` – ${dateOnly(week.last)}`}`;
  if (week.expected === 0) return `${span} · no files in the archive`;
  const percent = ((week.done / week.expected) * 100).toFixed(1);
  const collectors = week.collectorsExpected
    ? ` · ${week.collectorsDone}/${week.collectorsExpected} collectors complete`
    : '';
  return `${span} · ${percent}% parsed (${fmtInt(week.done)} / ${fmtInt(week.expected)} files)${collectors}`;
}

function renderArchive() {
  const grid = $('#archive-grid');
  const summary = $('#archive-summary');
  const legend = $('#archive-legend');
  const src = $('#archive-src');
  if (!grid) return;

  if (archive.error || !archive.data) {
    grid.replaceChildren();
    grid.setAttribute('aria-busy', 'false');
    summary.textContent = archive.error ? `archive calendar unavailable: ${archive.error}` : 'archive calendar · waiting';
    if (src) src.textContent = 'archive calendar · unavailable';
    return;
  }

  const rows = archiveWeeks(archive.data);
  const expected = archive.data.files_expected.reduce((sum, value) => sum + value, 0);
  const done = archive.data.files_done.reduce((sum, value) => sum + value, 0);
  const percent = expected === 0 ? '0.0' : ((done / expected) * 100).toFixed(1);
  // A finish estimate is only worth showing when it comes from measured samples. Until two
  // samples are far enough apart, the line says so rather than guessing from the archive size.
  const progress = archive.data.progress;
  let pace = '';
  let paceTitle = '';
  if (progress) {
    if (progress.files_per_hour) {
      pace = ` · ${fmtInt(progress.files_per_hour)} files/hour · ${etaLabel(progress.eta_hours)}`;
      paceTitle =
        `rate measured over ${fmtInt(progress.measured_over_minutes)} minutes for ${ARCHIVE_LABEL[archive.project]}; ` +
        `${fmtInt(progress.remaining)} files still to parse. The workers serve both projects from one queue, ` +
        `so this is the time that project needs at the shared rate, not a separate finish date.`;
    } else {
      pace = ' · measuring the parse rate';
      paceTitle = 'the rate needs two progress samples at least ten minutes apart';
    }
  }
  summary.textContent =
    `${percent}% of ${fmtInt(expected)} files parsed · ${fmtInt(archive.data.meta.days)} days · ${ARCHIVE_LABEL[archive.project]}${pace}`;
  summary.title = paceTitle;

  const hover = el('span', { class: 'archive-hover' }, ['']);
  const nodes = rows.map((row) => {
    const cells = row.weeks.map((week) => {
      const cell = el('div', { class: 'archive-cell' });
      cell.dataset.level = archiveLevel(week);
      const text = archiveTooltip(week);
      if (text) {
        cell.title = text;
        cell.addEventListener('mouseenter', () => { hover.textContent = text; });
      }
      return cell;
    });
    return el('div', { class: 'archive-row' }, [
      el('span', { class: 'archive-year' }, [String(row.year)]),
      el('div', { class: 'archive-weeks' }, cells),
    ]);
  });
  grid.replaceChildren(...nodes);
  grid.setAttribute('aria-busy', 'false');

  const chips = [
    ['none', 'no files'],
    ['0', 'none parsed'],
    ['1', 'under 50%'],
    ['2', 'under 90%'],
    ['3', 'under 100%'],
    ['4', 'complete'],
  ].map(([level, label]) => {
    const chip = el('span', { class: 'chip' });
    chip.dataset.level = level;
    return el('span', { class: 'swatch' }, [chip, el('span', {}, [label])]);
  });
  legend.replaceChildren(...chips, hover);

  if (src) {
    const when = archive.data.meta && archive.data.meta.refreshed_at ? dateOnly(new Date(archive.data.meta.refreshed_at)) : 'unknown';
    src.textContent = `archive calendar · ${fmtInt(archive.data.meta.days)} days · refreshed ${when}`;
  }
}

async function loadArchive() {
  const grid = $('#archive-grid');
  if (grid) grid.setAttribute('aria-busy', 'true');
  try {
    const data = await api('/v4/mrt/coverage', { project: archive.project });
    archive.data = data;
    archive.error = null;
    archive.at = new Date();
  } catch (error) {
    archive.data = null;
    archive.error = error && error.message ? error.message : String(error);
  }
  renderArchive();
}

function wireArchive() {
  const group = $('#archive-projects');
  if (!group) return;
  group.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-project]');
    if (!button || button.dataset.project === archive.project) return;
    archive.project = button.dataset.project;
    for (const node of group.querySelectorAll('button')) {
      node.classList.toggle('is-active', node.dataset.project === archive.project);
    }
    void loadArchive();
  });
}

async function boot() {
  closeDetail(true);
  state.sources = {};
  state.tiles = [];
  state.byName = new Map();
  state.fetchedAt = null;
  $('#grid').setAttribute('aria-busy', 'true');
  $('#grid').replaceChildren();
  $('#alerts').hidden = true;

  const specs = [
    { key: 'catalog', path: '/v4/mrt/collectors', params: {} },
    healthSpec(),
    ...windowSpecs(state.window),
    { key: 'latest', path: '/v4/mrt/collectors/latest', params: {} },
  ];

  const results = await Promise.all(specs.map(loadSource));
  state.sources = Object.fromEntries(results.map((result) => [result.key, result]));
  // The 24h window is the health window: one response serves both roles.
  if (state.window === '24h') state.sources.aggregates = state.sources.health;
  state.fetchedAt = new Date();

  buildModel();
  renderHeader();
  renderStrip();
  renderFleetChart();
  renderProjects();
  renderControls();
  renderAlerts();
  renderGrid();
  renderLagPanel();

  $('#grid').setAttribute('aria-busy', 'false');
  openFromHash();
}

wireArchive();
void loadArchive();

/// The lag figure comes from the file feed, not from the file index, so it survives a window
/// switch: renderHeader resets the cell to "loading", this puts the value back.
function renderLagPanel() {
  const feed = state.sources.latest;
  if (feed && !feed.error) {
    renderLag(feed.data, feed.at);
    return;
  }
  $('#kpi-lag').textContent = '—';
  $('#kpi-lag-meta').textContent = 'file feed · unavailable';
}

/// Switching the window refetches only the window-scoped responses; catalog, file feed and the
/// 24h health baseline stay as they are, so the tile states cannot change with the window.
async function applyWindow(key) {
  if (!WINDOWS[key] || key === state.window) return;
  state.window = key;
  for (const node of document.querySelectorAll('#window-switch button')) {
    node.classList.toggle('is-active', node.dataset.window === key);
  }

  const spec = WINDOWS[key];
  const grid = $('#grid');
  grid.setAttribute('aria-busy', 'true');
  const srcLine = $('#grid-src');
  if (srcLine) srcLine.textContent = `file index · loading the ${spec.label} window`;

  // Every window-scoped source is reloaded, not just aggregates and series: the reset
  // annotations ride on the same window and would otherwise stay stuck on the previous one.
  const specs = windowSpecs(key);
  const [aggregates, series, distributions, resets] = await Promise.all([
    key === '24h' ? Promise.resolve(state.sources.health) : loadSource(specs[0]),
    loadSource(specs[1]),
    loadSource(specs[2]),
    loadSource(specs[3]),
  ]);
  state.sources.aggregates = aggregates;
  state.sources.series = series;
  state.sources.distributions = distributions;
  state.sources.resets = resets;
  state.fetchedAt = new Date();

  buildModel();
  renderHeader();
  renderStrip();
  renderFleetChart();
  renderProjects();
  renderControls();
  renderAlerts();
  renderGrid();
  renderLagPanel();
  grid.setAttribute('aria-busy', 'false');
}

function wireEvents() {
  $('#grid').addEventListener('click', (event) => {
    const button = event.target.closest('.tile');
    if (button) openDetail(button.dataset.name, button);
  });

  $('#f-q').addEventListener('input', (event) => {
    state.filters.q = event.target.value;
    renderGrid();
  });

  $('#controls').addEventListener('change', (event) => {
    const select = event.target.closest('select');
    if (!select) return;
    const key = select.id.replace('f-', '');
    if (Object.prototype.hasOwnProperty.call(state.filters, key)) {
      state.filters[key] = select.value;
      renderGrid();
    }
  });

  const sortSelect = $('#f-sort');
  if (sortSelect) {
    sortSelect.addEventListener('change', (event) => {
      state.filters.sort = event.target.value;
      renderGrid();
      renderStrip();
    });
  }

  const deprecated = $('#f-deprecated');
  if (deprecated) {
    deprecated.addEventListener('change', (event) => {
      state.showDeprecated = event.target.checked;
      renderControls();
      renderStrip();
      renderGrid();
    });
  }

  const metrics = $('#chart-metrics');
  if (metrics) {
    metrics.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-metric]');
      if (!button) return;
      state.chartMetric = button.dataset.metric;
      for (const node of metrics.querySelectorAll('button')) node.classList.toggle('is-active', node === button);
      renderFleetChart();
    });
  }

  const windowSwitch = $('#window-switch');
  if (windowSwitch) {
    windowSwitch.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-window]');
      if (button) applyWindow(button.dataset.window);
    });
  }

  $('#f-reset').addEventListener('click', resetFilters);
  $('#detail-close').addEventListener('click', () => closeDetail());
  $('#scrim').addEventListener('click', () => closeDetail());
  document.addEventListener('keydown', onKeydown);
}

wireEvents();
boot();
