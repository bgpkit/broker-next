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

function alertItem(alert) {
  const sinceMs = Date.parse(alert.onset);
  const age = Number.isFinite(sinceMs) ? (Date.now() - sinceMs) / 60000 : null;
  const closed = alert.state === 'resolved' || alert.state === 'superseded';
  const level = severity(alert);
  return el('article', { class: 'alert-item' }, [
    el('p', { class: 'line' }, [
      el('span', { class: `sev is-${level}`, text: level }),
      document.createTextNode(' '),
      el('a', { href: `/#${encodeURIComponent(alert.collector)}`, text: alert.collector }),
      document.createTextNode(' '),
      el('span', { class: closed ? (alert.state === 'resolved' ? 'state is-resolved' : 'state is-superseded') : 'state', text: what(alert) }),
    ]),
    el('p', { class: 'meta' }, [
      document.createTextNode('last file '),
      el('span', { class: 'age', text: stampWords(alert.onset) }),
      document.createTextNode(' · '),
      el('span', { class: 'age', text: ageWords(age) }),
      document.createTextNode(' · '),
      el('a', { href: permalink(alert), text: 'record' }),
    ]),
  ]);
}

function fill(hostId, alerts, emptyText) {
  const host = document.getElementById(hostId);
  if (!host) return;
  host.replaceChildren();
  if (!alerts.length) {
    host.append(el('p', { class: 'alert-empty', text: emptyText }));
    return;
  }
  for (const alert of alerts) host.append(alertItem(alert));
}

/// The per-collector card names the collectors that are alerting right now, so the example link is
/// always one that exists rather than a placeholder the reader has to edit.
function fillCollectorCard(alerts) {
  const links = document.getElementById('collector-feed-links');
  const note = document.getElementById('collector-feed-note');
  const names = [...new Set(alerts.map((alert) => alert.collector))].slice(0, 4);
  if (!links || !names.length) return;
  links.replaceChildren();
  for (const name of names) {
    links.append(
      el('a', {
        href: `${API}/feeds/broker/alerts/${encodeURIComponent(name)}.atom`,
        text: name,
      })
    );
  }
  if (note) note.textContent = 'The collectors alerting right now; any name from the status page works.';
}

async function load() {
  let alerts = [];
  try {
    const response = await fetch(`${API}/v4/meta/alerts`, { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    alerts = Array.isArray(body.data) ? body.data : [];
  } catch (error) {
    fill('open', [], `the alert ledger did not answer (${error.message})`);
    fill('resolved', [], '');
    return;
  }
  // Critical first, then the warnings: a reader scanning the page should meet the stopped
  // collectors before the merely late ones. Within a tier the API already returns newest first.
  const rank = { critical: 0, warning: 1 };
  const bySeverity = (a, b) => (rank[severity(a)] ?? 9) - (rank[severity(b)] ?? 9);
  const isClosed = (alert) => alert.state === 'resolved' || alert.state === 'superseded';
  const open = alerts.filter((alert) => !isClosed(alert)).sort(bySeverity);
  const resolved = alerts.filter(isClosed).sort(bySeverity);
  fill('open', open, 'Nothing is open. Every collector the broker watches published its newest file inside the threshold.');
  fill('resolved', resolved, 'Nothing closed in the last 30 days.');
  fillCollectorCard(open);
}

load();
