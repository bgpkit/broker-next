// The alerts page: one fetch of the alert ledger, rendered as two lists and a subscription block.
//
// It reads the same JSON the feed is built from, so a row here and an entry in the Atom feed always
// describe the same alert with the same id, state and onset. Nothing is computed about the fleet:
// this page answers "what is open" and "where do I subscribe", not "is the archive healthy".

const API = 'https://api.bgpkit.com';

const STATE_WORD = {
  firing: 'stopped',
  recovering: 'resumed',
  pending: 'pending',
  held: 'held',
};

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

function what(alert) {
  const stream = alert.data_type === 'rib' ? 'RIB dumps' : 'updates';
  return `${stream} ${STATE_WORD[alert.state] || alert.state}`;
}

function alertItem(alert) {
  const sinceMs = Date.parse(alert.onset);
  const age = Number.isFinite(sinceMs) ? (Date.now() - sinceMs) / 60000 : null;
  const resolved = alert.state === 'resolved';
  return el('article', { class: 'alert-item' }, [
    el('p', { class: 'line' }, [
      el('a', { href: `/#${encodeURIComponent(alert.collector)}`, text: alert.collector }),
      document.createTextNode(' '),
      el('span', { class: resolved ? 'state is-resolved' : 'state', text: what(alert) }),
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
  const open = alerts.filter((alert) => alert.state !== 'resolved');
  const resolved = alerts.filter((alert) => alert.state === 'resolved');
  fill('open', open, 'Nothing is open. Every collector the broker watches published its newest file inside the threshold.');
  fill('resolved', resolved, 'No alert resolved in the last 30 days.');
  fillCollectorCard(open);
}

load();
