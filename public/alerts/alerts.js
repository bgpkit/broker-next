// The alerts page: one fetch of the alert ledger, rendered as two lists and a subscription block.
//
// It reads the same JSON the feed is built from, so a row here and an entry in the Atom feed always
// describe the same alert with the same id, state and onset. Nothing is computed about the fleet:
// this page answers "what is open" and "where do I subscribe", not "is the archive healthy".

const API = 'https://api.bgpkit.com';



/// The same two shapes as the status page: how long ago, and the exact instant in UTC.
function ageWords(minutes) {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return '';
  const total = Math.max(0, Math.round(minutes));
  if (total < 2) return 'just now';
  if (total < 90) return `${total}m ago`;
  const hours = Math.floor(total / 60);
  if (hours < 36) return total % 60 === 0 ? `${hours}h ago` : `${hours}h ${total % 60}m ago`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d ago` : `${days}d ${rest}h ago`;
}

function stampWords(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'unknown';
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}Z`;
}

/// The key is the identifier, the path is the key split on its own separators. Built from the
/// record's fields so a collector name can never be mistaken for a delimiter.
function permalink(alert) {
  const product = String(alert.id || '').split(':')[0] || 'broker';
  return `${API}/v4/meta/alerts/${product}/${alert.condition}/${encodeURIComponent(alert.collector)}/${alert.onset}`;
}

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined) continue;
    if (key === 'text') node.textContent = String(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of children) if (child) node.append(child);
  return node;
}

function severity(alert) {
  if (alert.severity === 'warning' || alert.severity === 'critical') return alert.severity;
  return String(alert.condition || '').endsWith('_late') ? 'warning' : 'critical';
}

/// The state machine says `firing`; what that means depends on the tier: a firing critical alert is
/// a stopped archive, a firing warning is a collector running behind. A closed row says how it
/// closed, because a warning that escalated did not recover.
function what(alert) {
  const stream = alert.data_type === 'rib' ? 'RIB dumps' : 'updates';
  const level = severity(alert);
  let word;
  if (alert.state === 'resolved') word = 'resumed';
  else if (alert.state === 'superseded') word = 'escalated to stopped';
  else if (alert.state === 'recovering') word = level === 'warning' ? 'back on schedule' : 'resumed';
  else if (level === 'warning') word = 'late';
  else word = alert.state === 'firing' ? 'stopped' : alert.state;
  return `${stream} ${word}`;
}

/// One card per collector. A collector has two streams and they carry separate thresholds, so the
/// same collector can be stopped on updates and only late on RIB dumps at the same moment; two rows
/// apart make that look like two problems, one card makes it read as one collector with two facts.
function groupByCollector(rows) {
  const byName = new Map();
  for (const row of rows) {
    if (!byName.has(row.collector)) byName.set(row.collector, []);
    byName.get(row.collector).push(row);
  }
  const worst = (list) => (list.some((row) => severity(row) === 'critical') ? 0 : 1);
  return [...byName.values()].sort((a, b) => worst(a) - worst(b) || a[0].collector.localeCompare(b[0].collector));
}

function streamLine(row) {
  const level = severity(row);
  const closed = row.state === 'resolved' || row.state === 'superseded';
  // Silence runs from the end of the newest file's window, which is what the ledger measured.
  const from = row.detail && row.detail.covered_until ? row.detail.covered_until : row.onset;
  const sinceMs = Date.parse(from);
  const age = Number.isFinite(sinceMs) ? (Date.now() - sinceMs) / 60000 : null;
  const stream = row.data_type === 'rib' ? 'RIB dumps' : 'updates';
  return el('div', { class: `stream-row is-${level}${closed ? ' is-closed' : ''}` }, [
    el('span', { class: 'stream-name', text: stream }),
    // The first column already names the stream, so the second only carries what happened to it.
    el('span', { class: closed ? (row.state === 'resolved' ? 'stream-state is-resolved' : 'stream-state is-superseded') : 'stream-state', text: what(row).replace(/^(updates|RIB dumps) /, '') }),
    el('span', { class: 'stream-time', text: `last file ${stampWords(row.onset)} · silent ${ageWords(age)}` }),
    el('a', { class: 'stream-record', href: permalink(row), text: 'record' }),
  ]);
}

function collectorItem(rows) {
  const open = rows.filter((row) => row.state !== 'resolved' && row.state !== 'superseded');
  const closed = open.length === 0;
  const level = rows.some((row) => severity(row) === 'critical') ? 'critical' : 'warning';
  const count = rows.length;
  const summary = closed
    ? `${count} episode${count === 1 ? '' : 's'}`
    : open.length === rows.length
      ? rows.map((row) => (row.data_type === 'rib' ? 'RIB dumps' : 'updates') + ' ' + what(row).replace(/^(updates|RIB dumps) /, '')).join(' · ')
      : `${open.length} open`;
  const ordered = rows.slice().sort((a, b) => {
    const rank = { critical: 0, warning: 1 };
    return (rank[severity(a)] ?? 9) - (rank[severity(b)] ?? 9) || a.data_type.localeCompare(b.data_type);
  });
  return el('article', { class: `alert-item is-${level} collector-card${closed ? ' is-closed' : ''}` }, [
    el('p', { class: 'line' }, [
      el('span', { class: `sev is-${level}`, text: level }),
      document.createTextNode(' '),
      el('a', { href: `/#${encodeURIComponent(rows[0].collector)}`, text: rows[0].collector }),
      document.createTextNode(' '),
      el('span', { class: closed ? 'state is-resolved' : 'state', text: summary }),
    ]),
    el('div', { class: 'stream-lines' }, [
      ...ordered.slice(0, closed ? 3 : ordered.length).map(streamLine),
      closed && ordered.length > 3
        ? el('div', { class: 'stream-more', text: `+${ordered.length - 3} more episodes` })
        : null,
    ]),
  ]);
}

function fill(hostId, alerts, emptyText) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.replaceChildren();
  if (!alerts.length) {
    host.append(el('p', { class: 'alert-empty', text: emptyText }));
    host.dataset.count = '0';
    return;
  }
  for (const rows of groupByCollector(alerts)) host.append(collectorItem(rows));
  // The list scrolls once it outgrows the viewport; the heading counter says how many rows are in it.
  host.dataset.count = String(alerts.length);
}

function render() {
  // Critical first, then the warnings: a reader scanning the page should meet the stopped
  // collectors before the merely late ones. Within a tier the API already returns newest first.
  const rank = { critical: 0, warning: 1 };
  const bySeverity = (a, b) => (rank[severity(a)] ?? 9) - (rank[severity(b)] ?? 9);
  const isClosed = (alert) => alert.state === 'resolved' || alert.state === 'superseded';
  const open = alerts.filter((alert) => !isClosed(alert)).sort(bySeverity);
  const closed = alerts.filter(isClosed).sort(bySeverity);

  fill('open', open, 'No collector is behind its threshold.');
  fill('resolved', closed, 'Nothing closed in the last 30 days.');
  const openTitle = document.getElementById('open-title');
  const closedTitle = document.getElementById('resolved-title');
  if (openTitle) openTitle.textContent = open.length ? `Open now · ${open.length}` : 'Open now';
  if (closedTitle) closedTitle.textContent = closed.length ? `Closed in the last 30 days · ${closed.length}` : 'Closed in the last 30 days';
  fillCollectorCard(open);
  renderChart();

  const stamp = document.getElementById('as-of');
  if (stamp) {
    stamp.textContent = loadedAt
      ? `read at ${stampWords(loadedAt.toISOString())}, refreshed every minute`
      : '';
  }
}

async function load() {
  const [ledger, chart] = await Promise.allSettled([
    fetch(`${API}/v4/meta/alerts`, { headers: { accept: 'application/json' } }),
    fetch(`${API}/v4/meta/alerts/series?hours=24&bucket_minutes=5`, { headers: { accept: 'application/json' } }),
  ]);
  try {
    if (ledger.status !== 'fulfilled' || !ledger.value.ok) throw new Error(`HTTP ${ledger.value && ledger.value.status}`);
    const body = await ledger.value.json();
    alerts = Array.isArray(body.data) ? body.data : [];
    loadedAt = new Date();
  } catch (error) {
    fill('open', [], `the alert ledger did not answer (${error.message})`);
    fill('resolved', [], '');
  }
  if (chart.status === 'fulfilled' && chart.value.ok) {
    try {
      const body = await chart.value.json();
      series = Array.isArray(body.data) ? body.data : [];
      seriesMeta = body.meta || seriesMeta;
    } catch {
      series = [];
    }
  }
  render();
}

load();
// Two clocks, because they answer different questions: the ages need redrawing every half minute,
// and the ledger itself only changes when the evaluator runs, every five.
setInterval(() => {
  if (!document.hidden) render();
}, 30000);
setInterval(() => {
  if (!document.hidden) load();
}, 60000);
