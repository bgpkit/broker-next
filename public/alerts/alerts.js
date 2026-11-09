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

/// The last response, kept so the ages can be redrawn without asking the API again. Every age on
/// this page is "how long ago", and a number computed once at load is wrong a minute later.
let alerts = [];
let series = [];
let seriesMeta = { hours: 72 };
let loadedAt = null;

/// Hours from `count` back to the current one, in the format the series endpoint uses. The API only
/// returns hours that had something open; the axis needs every hour, because a quiet hour is a fact
/// and should be drawn as an empty slot rather than collapsed away.
function hourAxis(count) {
    const end = new Date();
    end.setUTCMinutes(0, 0, 0);
    const pad = (value) => String(value).padStart(2, '0');
    const out = [];
    for (let i = count - 1; i >= 0; i -= 1) {
        const at = new Date(end.getTime() - i * 3600000);
        out.push({
            key: `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:00:00Z`,
            at,
        });
    }
    return out;
}

function renderChart() {
    const host = document.getElementById('chart');
    if (!host) return;
    const note = document.getElementById('chart-note');
    const hours = Number(seriesMeta.hours) || 72;
    const projects = [...new Set(series.map((row) => row.project))];
    if (!projects.length) {
        host.replaceChildren(el('p', { class: 'alert-empty', text: `No collector was in alert in the last ${hours} hours.` }));
        if (note) note.textContent = '';
        return;
    }
    // Start where the data starts. The ledger only has a few hours of history so far, and drawing
    // sixty empty hours beside four full ones hides the shape this chart exists to show.
    const earliest = Math.min(...series.map((row) => Date.parse(row.hour)).filter(Number.isFinite));
    const nowHour = new Date();
    nowHour.setUTCMinutes(0, 0, 0);
    const spanHours = Math.min(hours, Math.max(6, Math.round((nowHour.getTime() - earliest) / 3600000) + 1));
    const axis = hourAxis(spanHours);
    const order = ['route-views', 'ripe-ris'];
    projects.sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9) || a.localeCompare(b));

    const lookup = new Map(series.map((row) => [`${row.project}|${row.hour}`, row]));
    let peak = 0;
    for (const row of series) peak = Math.max(peak, row.critical + row.warning);
    const top = Math.max(1, peak);

    const rows = projects.map((project) => {
        const bars = axis.map(({ key, at }) => {
            const hit = lookup.get(`${project}|${key}`) || { critical: 0, warning: 0 };
            const label = `${stampWords(key)} · ${project} · ${hit.critical} stopped, ${hit.warning} late`;
            return el('div', { class: 'chart-bar', title: label }, [
                hit.critical ? el('span', { class: 'crit', style: `height:${(hit.critical / top) * 100}%` }) : null,
                hit.warning ? el('span', { class: 'warn', style: `height:${(hit.warning / top) * 100}%` }) : null,
            ]);
        });
        const name = project === 'route-views' ? 'route-views' : project === 'ripe-ris' ? 'ripe-ris' : project;
        // The bars share one scale so the two projects are comparable, which makes a small value a
        // speck; the number at the end of the row is the current hour, so the reader gets both.
        const lastKey = axis[axis.length - 1].key;
        const last = lookup.get(`${project}|${lastKey}`) || { critical: 0, warning: 0 };
        const current = last.critical ? `${last.critical} stopped` : last.warning ? `${last.warning} late` : 'clear';
        return el('div', { class: 'chart-row' }, [
            el('span', { class: 'chart-name', text: name }),
            el('div', { class: 'chart-bars' }, bars),
            el('span', { class: 'chart-max', text: current }),
        ]);
    });

    // Tick density follows the span: a six-hour window labelled every twelve hours would show one
    // number, which is how this chart first shipped.
    const step = spanHours <= 12 ? 2 : spanHours <= 24 ? 4 : spanHours <= 48 ? 6 : 12;
    const ticks = axis.map(({ at }, index) => {
        const hour = at.getUTCHours();
        const show = index === 0 || index === axis.length - 1 || index % step === 0;
        const label = hour === 0
            ? `${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')} 00:00`
            : `${String(hour).padStart(2, '0')}:00`;
        return el('span', { class: 'chart-hour', text: show ? label : '' });
    });

    host.replaceChildren(...rows, el('div', { class: 'chart-hours' }, ticks));
    if (note) note.textContent = `peak ${peak} collector${peak === 1 ? '' : 's'} · ${spanHours} h · UTC`;
}

function render() {
  // Critical first, then the warnings: a reader scanning the page should meet the stopped
  // collectors before the merely late ones. Within a tier the API already returns newest first.
  const rank = { critical: 0, warning: 1 };
  const bySeverity = (a, b) => (rank[severity(a)] ?? 9) - (rank[severity(b)] ?? 9);
  const isClosed = (alert) => alert.state === 'resolved' || alert.state === 'superseded';
  const open = alerts.filter((alert) => !isClosed(alert)).sort(bySeverity);
  const closed = alerts.filter(isClosed).sort(bySeverity);

  fill('open', open, 'Nothing is open. Every collector the broker watches published its newest file inside the threshold.');
  fill('resolved', closed, 'Nothing closed in the last 30 days.');
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
    fetch(`${API}/v4/meta/alerts/series?hours=72`, { headers: { accept: 'application/json' } }),
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
