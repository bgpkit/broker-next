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
    // The first column names the stream, the second carries what happened to it plus its JSON
    // record, and the last line carries the timing. One row fewer than a separate link line.
    el('span', { class: closed ? (row.state === 'resolved' ? 'stream-state is-resolved' : 'stream-state is-superseded') : 'stream-state' }, [
      document.createTextNode(what(row).replace(/^(updates|RIB dumps) /, '')),
      document.createTextNode(' · '),
      el('a', { class: 'stream-json', href: permalink(row), text: 'json' }),
    ]),
    el('span', { class: 'stream-time', text: `last file ${stampWords(row.onset)} · ${ageWords(age)}` }),
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

/// Hours from `count` back to the current one, in the format the series endpoint uses. The API only
/// returns hours that had something open; the axis needs every hour, because a quiet hour is a fact
/// and should be drawn as an empty slot rather than collapsed away.
/// Buckets between the first and last snapshot the server actually returned. Ending the axis at the
/// browser's clock instead would draw one bucket the response predates, and that empty bar reads as
/// "everything recovered" when it only means "the edge cache answered from a minute ago".
function bucketAxis(firstMs, lastMs, stepMinutes) {
    const step = stepMinutes * 60000;
    const end = new Date(lastMs);
    const start = new Date(firstMs);
    const pad = (value) => String(value).padStart(2, '0');
    const stamp = (at) =>
        `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:00Z`;
    const out = [];
    for (let at = start.getTime(); at <= end.getTime(); at += step) {
        const date = new Date(at);
        out.push({ key: stamp(date), at: date });
    }
    return out;
}

/// Open alerts by project and severity, straight from the ledger the list is built from.
function liveCounts(project) {
    let critical = 0;
    let warning = 0;
    for (const row of alerts) {
        if (row.project !== project) continue;
        if (row.state === 'resolved' || row.state === 'superseded') continue;
        if (severity(row) === 'critical') critical += 1;
        else warning += 1;
    }
    return { critical, warning };
}

function renderChart() {
    const host = document.getElementById('chart');
    if (!host) return;
    const note = document.getElementById('chart-note');
    const hours = Number(seriesMeta.hours) || 24;
    const stepMinutes = Number(seriesMeta.bucket_minutes) || 5;
    const projects = [...new Set(series.map((row) => row.project))];
    if (!projects.length) {
        host.replaceChildren(el('p', { class: 'alert-empty', text: `No collector was in alert in the last ${hours} hours.` }));
        if (note) note.textContent = '';
        return;
    }
    // Start where the data starts. The ledger only has a few hours of history so far, and drawing
    // sixty empty hours beside four full ones hides the shape this chart exists to show.
    const stamps = series.map((row) => Date.parse(row.hour)).filter(Number.isFinite);
    const earliest = Math.min(...stamps);
    const latest = Math.max(...stamps);
    const axis = bucketAxis(earliest, latest, stepMinutes);
    const order = ['route-views', 'ripe-ris'];
    projects.sort((a, b) => (order.indexOf(a) + 1 || 9) - (order.indexOf(b) + 1 || 9) || a.localeCompare(b));

    const lookup = new Map(series.map((row) => [`${row.project}|${row.hour}`, row]));
    let peak = 0;
    for (const row of series) peak = Math.max(peak, row.critical + row.warning);
    const top = Math.max(1, peak);

    const rows = projects.map((project) => {
        const bars = axis.map(({ key, at }) => {
            const hit = lookup.get(`${project}|${key}`) || { critical: 0, warning: 0 };
            const label = `${stampWords(key)} · ${project} · ${hit.critical} critical, ${hit.warning} warning`;
            // Stopped sits at the bottom: it is the slow-moving part of the picture, so the baseline
            // stays still while the late segment moves above it.
            return el('div', { class: 'chart-bar', title: label }, [
                hit.warning ? el('span', { class: 'warn', style: `height:${(hit.warning / top) * 100}%` }) : null,
                hit.critical ? el('span', { class: 'crit', style: `height:${(hit.critical / top) * 100}%` }) : null,
            ]);
        });
        const name = project === 'route-views' ? 'route-views' : project === 'ripe-ris' ? 'ripe-ris' : project;
        // The bars share one scale so the two projects are comparable, which makes a small value a
        // speck; the number at the end of the row is the current hour, so the reader gets both.
        // Live counts, not the last bucket: the bucket is at least a scrape old and its window can
        // miss an alert that opened since, which is exactly how a summary ends up saying zero while
        // two warnings sit in the list below it.
        const live = liveCounts(project);
        // Both counts, always: a row that says only "3 critical" hides the nineteen collectors that
        // are merely behind behind it.
        const current = live.critical + live.warning === 0 ? 'clear' : `${live.critical} critical · ${live.warning} warning`;
        // Counts live under the project name: the bars keep the full width, and the row needs no
        // second column whose width would depend on the numbers and knock the axis out of line.
        return el('div', { class: 'chart-row' }, [
            el('span', { class: 'chart-name' }, [
                el('span', { class: 'chart-proj', text: name }),
                el('span', { class: 'chart-count', text: current }),
            ]),
            el('div', { class: 'chart-bars' }, bars),
        ]);
    });

    // Tick density follows the span: a six-hour window labelled every twelve hours would show one
    // number, which is how this chart first shipped.
    // Tick density follows the bucket: one label every twelve buckets, always the first and last.
    const every = Math.max(1, Math.round(12));
    const ticks = axis.map(({ at }, index) => {
        const show = index === 0 || index === axis.length - 1 || index % every === 0;
        const pad = (value) => String(value).padStart(2, '0');
        const label = at.getUTCMinutes() === 0 && at.getUTCHours() === 0
            ? `${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} 00:00`
            : `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
        return el('span', { class: index === axis.length - 1 ? 'chart-hour is-last' : 'chart-hour' }, [
            show ? el('span', { text: label }) : null,
        ]);
    });

    // The axis rides the same grid as the rows, so the ticks line up with the bars whatever width
    // the row-end label takes.
    const axisNode = el('div', { class: 'chart-row chart-axis' }, [
        el('span', { class: 'chart-name' }),
        el('div', { class: 'chart-hours' }, ticks),
    ]);
    host.replaceChildren(...rows, axisNode);
    // Drop labels that would collide, measured after layout: a computed step cannot know how wide
    // the rendered text is, and on a phone every twelfth bucket is twenty pixels apart.
    thinTicks(axisNode);
    if (note) {
        note.textContent = `peak ${peak} alert${peak === 1 ? '' : 's'} · ${axis.length} × ${stepMinutes} min · UTC`;
    }
}

/// Keep the first and last tick, then keep a middle tick only while it clears the last kept one. The
/// result depends on the width actually available, so it reads correctly at any viewport.
function thinTicks(axisNode) {
    const cells = [...axisNode.querySelectorAll('.chart-hour')].filter((cell) => cell.firstElementChild);
    if (cells.length < 3) return;
    const first = cells[0].firstElementChild.getBoundingClientRect();
    const last = cells[cells.length - 1].firstElementChild.getBoundingClientRect();
    let keptRight = first.right;
    for (let i = 1; i < cells.length - 1; i += 1) {
        const rect = cells[i].firstElementChild.getBoundingClientRect();
        if (rect.left >= keptRight + 8 && rect.right <= last.left - 8) {
            keptRight = rect.right;
            continue;
        }
        cells[i].firstElementChild.remove();
    }
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
    // Five-minute buckets are 288 bars: on a phone each bar is narrower than the gap between bars,
    // so the plot needs a wider canvas than the screen has. A quarter-hour bucket keeps the shape
    // and fits.
    fetch(`${API}/v4/meta/alerts/series?hours=24&bucket_minutes=${window.innerWidth < 640 ? 15 : 5}`, {
      headers: { accept: 'application/json' },
    }),
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
