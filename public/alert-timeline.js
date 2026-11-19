// The alert timeline dialog: one ledger alert, the silence the broker measured, and every state
// change the ledger recorded, on a vertical rail in UTC and the reader's own zone.
//
// Shared by the status page (the collector drawer's alert list) and the alerts page. The list
// endpoints carry the row and its evidence but not alert.event, so the transition history is
// fetched for the one alert being opened; when that fetch fails the dialog says the history is
// missing instead of drawing a timeline from the two instants it already has.
(function () {
  'use strict';

  const API = 'https://api.bgpkit.com';
  const pad2 = (value) => String(value).padStart(2, '0');

  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === null || value === undefined) continue;
      if (key === 'text') node.textContent = String(value);
      else node.setAttribute(key, String(value));
    }
    for (const child of children) if (child) node.append(child);
    return node;
  };

  /// Milliseconds since the epoch, or NaN. Every stamp in the ledger is an ISO-8601 Z string, and a
  /// missing one has to stay missing rather than become 1970.
  const at = (value) => {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : NaN;
  };

  const clock = (ms) => {
    const date = new Date(ms);
    return `${date.getUTCFullYear()}-${pad2(date.getUTCMonth() + 1)}-${pad2(date.getUTCDate())} `
      + `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
  };

  const localClock = (ms) => {
    const date = new Date(ms);
    return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} `
      + `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
  };

  /// The zone's short name at that instant ("PST", "CEST"), because a 30-day retention window can
  /// straddle a DST change and one label in the header would then be wrong for half the rail.
  let zoneFormat = null;
  function zoneName(ms) {
    try {
      zoneFormat = zoneFormat || new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' });
      const part = zoneFormat.formatToParts(new Date(ms)).find((item) => item.type === 'timeZoneName');
      if (part && part.value) return part.value;
    } catch {
      // Fall through to the numeric offset: an engine without Intl still has getTimezoneOffset.
    }
    const offset = -new Date(ms).getTimezoneOffset();
    const sign = offset < 0 ? '-' : '+';
    const size = Math.abs(offset);
    return `UTC${sign}${pad2(Math.floor(size / 60))}:${pad2(size % 60)}`;
  }

  function zoneTitle() {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'this device';
    } catch {
      return 'this device';
    }
  }

  /// Durations are the point of the rail, so they read in the units that carry the information and
  /// drop a trailing zero: 5m exactly is "5m", not "5m 00s", while 5m 01s keeps the second because it
  /// is the difference between a confirmation window and a rounding story.
  function duration(value, exact) {
    const total = Math.max(0, Math.round(value / 1000));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    if (days) return seconds === 0 && minutes === 0 ? `${days}d ${hours}h` : `${days}d ${hours}h ${pad2(minutes)}m`;
    if (hours) {
      if (exact && seconds !== 0) return `${hours}h ${pad2(minutes)}m ${pad2(seconds)}s`;
      if (minutes === 0 && seconds === 0) return `${hours}h`;
      return `${hours}h ${pad2(minutes)}m`;
    }
    if (minutes) return exact && seconds !== 0 ? `${minutes}m ${pad2(seconds)}s` : `${minutes}m`;
    return `${seconds}s`;
  }

  const streamName = (row) => (row.data_type === 'rib' ? 'RIB dumps' : 'updates');

  function severity(row) {
    if (row.severity === 'warning' || row.severity === 'critical') return row.severity;
    return String(row.condition || '').endsWith('_late') ? 'warning' : 'critical';
  }

  const isClosed = (row) => row.state === 'resolved' || row.state === 'superseded';
  const isOpen = (row) => row.state === 'firing' || row.state === 'recovering';

  /// What the state means for this tier, in the same words the lists use: a firing critical alert is
  /// a stopped archive, a firing warning is a collector running behind.
  function stateWord(row) {
    const level = severity(row);
    // A link carries only the id, so the state is unknown until the record arrives; saying
    // "candidate" in that window would publish a claim the ledger never made.
    if (!row.state) return '';
    if (row.state === 'resolved') return 'resumed';
    if (row.state === 'superseded') return 'escalated to stopped';
    if (row.state === 'recovering') return 'resumed, closing';
    if (row.state === 'firing') return level === 'warning' ? 'late' : 'stopped';
    if (row.state === 'held') return 'candidate, held';
    return 'candidate, not published';
  }

  /// The canonical address of one alert as a page, not as an API record: the alerts page reads this
  /// fragment on load and opens the dialog for the row it names.
  function shareUrl(row) {
    return `${location.origin}/alerts/#alert=${row.id}`;
  }

  /// Copying is how this leaves the browser, so it has to work when the async clipboard is refused:
  /// fall back to a selected textarea, and if that also fails say so and print the URL rather than
  /// claim a copy that did not happen.
  async function copyLink() {
    if (!state.row) return;
    const url = shareUrl(state.row);
    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {
      copied = legacyCopy(url);
    }
    state.copy.textContent = copied ? 'Copied' : 'Copy failed';
    state.copy.classList.toggle('is-done', copied);
    if (!copied) state.source.textContent = url;
    clearTimeout(state.copyTimer);
    state.copyTimer = setTimeout(() => {
      state.copy.textContent = 'Copy link';
      state.copy.classList.remove('is-done');
      if (!copied) state.source.textContent = sourceLine();
    }, 2400);
  }

  function legacyCopy(text) {
    const area = el('textarea', { class: 'tl-copy-sink', 'aria-hidden': 'true', tabindex: '-1' });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }

  /// The permalink is the alert's stable identity: product, condition, collector, onset. Built from
  /// the record's own fields so a collector name can never be read as a delimiter.
  function permalink(row) {
    const product = String(row.id || '').split(':')[0] || 'broker';
    return `${API}/v4/meta/alerts/${product}/${row.condition}/${encodeURIComponent(row.collector)}/${row.onset}`;
  }

  const EVENT = {
    pending: ['silence first seen', 'one evaluation past the threshold; nothing published yet'],
    held: ['held off the page', 'the storm gate kept this candidate from being published'],
    released: ['gate reopened', 'back to a candidate; still not published'],
    opened: ['alert published', 'a second evaluation confirmed it, which is when this row became visible'],
    flap: ['firing again', 'a stale file arrived while the silence was still past the threshold'],
    recovering: ['archive publishing again', 'a file newer than the silence appeared; the ledger is confirming the recovery'],
    resolved: ['closed', 'two evaluations found the silence gone'],
    superseded: ['closed as escalated', 'a stopped alert for the same collector and stream took over'],
    escalated: ['escalated', 'another tier took over this collector and stream'],
    dropped: ['withdrawn', 'the candidate did not hold'],
  };

  function toneFor(transition, row) {
    const level = severity(row);
    if (transition === 'pending' || transition === 'held' || transition === 'released') return 'pending';
    if (transition === 'opened' || transition === 'flap') return level;
    if (transition === 'recovering') return 'recovering';
    if (transition === 'resolved') return 'resolved';
    return 'superseded';
  }

  /* ---------- the dialog shell ---------- */

  const state = {
    dialog: null,
    scrim: null,
    body: null,
    stats: null,
    sub: null,
    eyebrow: null,
    source: null,
    json: null,
    copy: null,
    copyTimer: null,
    row: null,
    full: null,
    error: null,
    trigger: null,
    seq: 0,
    open: false,
    tickers: [],
    timer: null,
  };

  function build() {
    if (state.dialog) return;
    const close = el('button', {
      class: 'tl-close',
      type: 'button',
      'aria-label': 'Close the alert timeline',
      text: '×',
    });
    close.addEventListener('click', shutdown);

    state.eyebrow = el('p', { class: 'tl-eyebrow', text: 'alert timeline' });
    state.sub = el('p', { class: 'tl-sub' });
    const head = el('header', { class: 'tl-head' }, [
      el('div', { class: 'tl-id' }, [state.eyebrow, el('h2', { id: 'tl-title' }), state.sub]),
      close,
    ]);

    state.stats = el('div', { class: 'tl-stats' });
    state.body = el('div', { class: 'tl-body' });
    state.source = el('span', { text: 'alert ledger' });
    state.json = el('a', { href: '#', target: '_blank', rel: 'noreferrer', text: 'JSON record ↗' });
    // The link names the alert itself, so a reader who receives it lands on this same timeline
    // rather than on a page they then have to search.
    state.copy = el('button', {
      class: 'tl-copy',
      type: 'button',
      'aria-label': 'Copy a link to this alert timeline',
      text: 'Copy link',
    });
    state.copy.addEventListener('click', copyLink);

    state.dialog = el('div', {
      class: 'tl',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'tl-title',
      'aria-hidden': 'true',
      'data-open': 'false',
      tabindex: '-1',
    }, [
      head,
      state.stats,
      state.body,
      el('footer', { class: 'tl-foot' }, [
        state.source,
        el('span', { class: 'tl-actions' }, [state.copy, state.json]),
      ]),
    ]);

    state.scrim = el('div', { class: 'tl-scrim', 'data-open': 'false', hidden: '' });
    state.scrim.addEventListener('click', shutdown);

    document.body.append(state.scrim, state.dialog);
    document.addEventListener('keydown', onKeydown, true);
  }

  function onKeydown(event) {
    if (!state.open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      // Stop here: the status page closes its own drawer on Escape, and the timeline sits above it.
      event.stopPropagation();
      shutdown();
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...state.dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter((node) => node.getClientRects().length > 0);
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function show() {
    if (state.open) return;
    state.open = true;
    state.scrim.hidden = false;
    state.scrim.dataset.open = 'true';
    state.dialog.dataset.open = 'true';
    state.dialog.setAttribute('aria-hidden', 'false');
    document.body.classList.add('tl-open');
    const close = state.dialog.querySelector('.tl-close');
    if (close) close.focus();
    state.timer = setInterval(tick, 1000);
  }

  function shutdown() {
    if (!state.open) return;
    state.open = false;
    state.dialog.dataset.open = 'false';
    state.dialog.setAttribute('aria-hidden', 'true');
    state.scrim.dataset.open = 'false';
    state.scrim.hidden = true;
    document.body.classList.remove('tl-open');
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
    state.tickers = [];
    if (state.trigger && state.trigger.isConnected && typeof state.trigger.focus === 'function') {
      state.trigger.focus();
    }
    document.dispatchEvent(new CustomEvent('alerttimeline:close', { detail: { id: state.row && state.row.id } }));
  }

  /* ---------- reading the record ---------- */

  async function fetchRecord(row) {
    const response = await fetch(permalink(row), { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    if (!body || !body.data) throw new Error('empty record');
    return body.data;
  }

  function open(row, trigger) {
    if (!row) return;
    build();
    const same = state.open && state.row && state.row.id === row.id;
    if (!same) {
      state.seq += 1;
      state.row = row;
      state.full = null;
      state.error = null;
    }
    state.trigger = trigger instanceof HTMLElement ? trigger : document.activeElement;
    show();
    if (state.body) state.body.setAttribute('aria-busy', 'true');
    render();
    // The page owns the address bar: the alerts page turns this into #alert=<id> so the open dialog
    // is the URL, and the status page keeps its own #<collector> fragment untouched.
    document.dispatchEvent(new CustomEvent('alerttimeline:open', { detail: { id: row.id } }));

    const seq = state.seq;
    fetchRecord(row)
      .then((full) => {
        if (seq !== state.seq) return;
        state.full = full;
        state.error = null;
        render();
      })
      .catch((error) => {
        if (seq !== state.seq) return;
        state.error = error;
        render();
      });
  }

  /* ---------- rendering ---------- */

  function render() {
    // The record wins over the row: a link carries nothing but the id, and the list row carries no
    // transition history, so every field the record has replaces what the row said.
    const row = Object.assign({}, state.row, state.full || {});
    if (!row.id) return;
    const full = state.full;
    const level = severity(row);

    state.eyebrow.textContent = `${row.project || 'broker'} · alert timeline`;
    state.dialog.querySelector('#tl-title').textContent = row.collector;
    const reason = row.closed_reason || (full && full.closed_reason) || '';
    const reasonLine = reason && row.state !== 'superseded' ? `closed as ${reason}` : '';
    const whatLine = [streamName(row), stateWord(row)].filter(Boolean).join(' ');
    state.sub.replaceChildren(
      el('span', { class: `tl-chip is-${level}`, text: level }),
      // The rest is a sentence, not a row of tabs: what the stream did, and how the row closed.
      el('span', {
        class: 'tl-sub-text',
        text: [whatLine, reasonLine].filter(Boolean).join(' · '),
      })
    );

    renderStats(row, full);
    renderBody(row, full);
  }

  function stat(label, value, title) {
    return el('div', { class: 'tl-stat', title: title || null }, [
      el('span', { class: 'tl-stat-value', text: value }),
      el('span', { class: 'tl-stat-label', text: label }),
    ]);
  }

  /// The instant the silence is measured from. `coveredUntil` in the alert worker adds one publishing
  /// slot to the newest updates file, because a file named 21:55 covers 21:55 to 22:00; a RIB dump is
  /// a snapshot and covers nothing past its own stamp. The ledger records both, so read the coverage
  /// end and fall back to the onset only when the record does not carry it.
  function silenceStartMs(detail, fallbackMs) {
    const covered = at(detail.covered_until);
    return Number.isFinite(covered) ? covered : fallbackMs;
  }

  function renderStats(row, full) {
    const detail = (full && full.detail) || row.detail || {};
    const silenceMs = silenceStartMs(detail, at((full && full.onset) || row.onset));
    const eventMs = firstWriteMs(full, row);
    // A closed row's last write is the close: `resolved_at` is on the record, `updated_at` on every
    // list row, and without both the duration would run to the browser's clock and call a closed
    // alert still open.
    const closedMs = at(full && full.resolved_at) || at(row.resolved_at)
      || (isClosed(row) ? at((full && full.updated_at) || row.updated_at) : NaN);
    const endMs = Number.isFinite(closedMs) ? closedMs : Date.now();
    const open = !isClosed(row) && isOpen(row);

    state.stats.replaceChildren();
    state.tickers = [];

    if (Number.isFinite(silenceMs)) {
      const node = el('span', { class: 'tl-stat-value', text: duration(endMs - silenceMs, true) });
      state.stats.append(
        el('div', { class: 'tl-stat', title: `silence measured from ${clock(silenceMs)}Z` }, [
          node,
          el('span', { class: 'tl-stat-label', text: 'silent for' }),
        ])
      );
      if (open) state.tickers.push({ node, text: (now) => duration(now - silenceMs, true) });
    }

    if (Number.isFinite(silenceMs) && Number.isFinite(eventMs)) {
      state.stats.append(
        stat(
          'detected after',
          duration(eventMs - silenceMs, true),
          `silence start ${clock(silenceMs)}Z, first ledger write ${clock(eventMs)}Z`
        )
      );
    }

    if (Number.isFinite(eventMs)) {
      const node = el('span', { class: 'tl-stat-value', text: duration(endMs - eventMs, true) });
      state.stats.append(
        el('div', { class: 'tl-stat', title: `first ledger write ${clock(eventMs)}Z` }, [
          node,
          el('span', { class: 'tl-stat-label', text: open ? 'open for' : 'was open' }),
        ])
      );
      if (open) state.tickers.push({ node, text: (now) => duration(now - eventMs, true) });
    }

    if (Number.isFinite(detail.gap_seconds) && detail.gap_seconds > 0) {
      state.stats.append(
        stat('threshold', duration(Number(detail.gap_seconds) * 1000, true), 'the silence this rule accepts')
      );
    }
  }

  /// The first instant the ledger wrote about this row: `alert.event`'s first revision when the
  /// history loaded, otherwise `opened_at`, which every list row carries.
  function firstWriteMs(full, row) {
    const events = Array.isArray(full && full.events) ? full.events : [];
    if (events.length) {
      const first = events.map((event) => at(event.at)).filter(Number.isFinite).sort((a, b) => a - b)[0];
      if (Number.isFinite(first)) return first;
    }
    return at((full && full.opened_at) || row.opened_at);
  }

  function renderBody(row, full) {
    const detail = (full && full.detail) || row.detail || {};
    const events = Array.isArray(full && full.events) ? full.events.slice() : [];
    const steps = [];
    const onsetMs = at((full && full.onset) || row.onset);
    const startMs = silenceStartMs(detail, onsetMs);
    const level = severity(row);

    // The first step is the evidence the rule measured, not a state change: silence begins where the
    // newest file's coverage ends, which is one publishing slot after the file's own stamp for
    // updates and the same instant for a RIB dump. Printing both instants makes the threshold
    // arithmetic checkable instead of asserted.
    if (Number.isFinite(startMs)) {
      const newestMs = at(detail.newest_entry);
      const coveredMs = at(detail.covered_until);
      let note;
      if (Number.isFinite(newestMs)) {
        const file = row.data_type === 'rib'
          ? `newest RIB dump ${clock(newestMs)}Z`
          : `newest updates file ${clock(newestMs)}Z`;
        note = Number.isFinite(coveredMs) && coveredMs !== newestMs ? `${file}; its window ends here` : file;
      } else {
        note = 'the end of the last file the archive listed';
      }
      steps.push({ at: startMs, tone: 'silence', title: 'silence starts', note });
    }

    events.sort((a, b) => (Number(a.revision) || 0) - (Number(b.revision) || 0));
    for (const event of events) {
      const when = at(event.at);
      if (!Number.isFinite(when)) continue;
      const words = EVENT[event.transition] || [String(event.transition || 'state change'), ''];
      let note = words[1];
      const transition = String(event.transition || '');
      if (transition === 'opened') {
        const gap = Number(detail.gap_seconds);
        if (Number.isFinite(gap) && gap > 0) {
          note = `${note}; the threshold is ${duration(gap * 1000, true)} of silence`;
        }
      }
      if (transition === 'resolved' && (event.closed_reason || full.closed_reason || row.closed_reason)) {
        note = `${words[1]}; closed as ${event.closed_reason || full.closed_reason || row.closed_reason}`;
      }
      steps.push({ at: when, tone: toneFor(transition, row), title: words[0], note });
    }

    // Without alert.event the rail still shows what the row itself proves: the onset and the first
    // write. It is labelled as a partial history rather than padded with invented transitions.
    if (!events.length) {
      const openedMs = at((full && full.opened_at) || row.opened_at);
      if (Number.isFinite(openedMs)) {
        steps.push({
          at: openedMs,
          tone: 'pending',
          title: 'first ledger write',
          note: state.error
            ? 'the transition history did not load, so only this instant is certain'
            : 'the ledger has no transition events for this row',
        });
      }
    }

    // An open alert's rail ends at now, so the reader sees the silence still running rather than a
    // line that stops at the last state change.
    let nowNode = null;
    if (!isClosed(row) && Number.isFinite(startMs) && row.state) {
      const now = Date.now();
      nowNode = {
        at: now,
        tone: level,
        title: 'now',
        now: true,
        note: isOpen(row) ? 'the alert is open; the silence is still being measured' : 'still a candidate; nothing published',
      };
      steps.push(nowNode);
    }

    const nodes = [];
    let previous = null;
    for (const step of steps) {
      const delta = previous === null ? null : step.at - previous;
      const durNode = el('span', { class: 'tl-dur' });
      if (step.now) {
        // A now step can only follow something: the silence step is pushed under the same condition.
        durNode.textContent = `+${duration(step.at - (previous || step.at), true)}`;
        state.tickers.push({ node: durNode, text: (now) => `+${duration(now - (previous || now), true)}` });
      } else if (delta !== null) {
        durNode.textContent = `+${duration(delta, true)}`;
      }
      const utcNode = el('span', { text: clock(step.at) });
      const localNode = el('span', { text: localClock(step.at) });
      if (step.now) {
        state.tickers.push({ node: utcNode, text: (now) => clock(now) });
        state.tickers.push({ node: localNode, text: (now) => localClock(now) });
      }
      nodes.push(
        el('li', { class: `tl-step${step.now ? ' is-now' : ''}`, 'data-tone': step.tone }, [
          el('span', { class: 'tl-dot', 'aria-hidden': 'true' }),
          el('div', { class: 'tl-line' }, [
            el('p', { class: 'tl-what' }, [
              el('span', { class: 'tl-title', text: step.title }),
              delta === null ? null : durNode,
            ]),
            el('p', { class: 'tl-when' }, [
              el('span', { class: 'tl-clock' }, [el('i', { text: 'UTC' }), utcNode]),
              el('span', { class: 'tl-clock is-local' }, [el('i', { text: zoneName(step.at) }), localNode]),
            ]),
            step.note ? el('p', { class: 'tl-note', text: step.note }) : null,
          ]),
        ])
      );
      previous = step.at;
    }

    const facts = [];
    const gap = Number(detail.gap_seconds);
    if (Number.isFinite(gap) && gap > 0) facts.push(['threshold', duration(gap * 1000, true)]);
    const factNewest = at(detail.newest_entry);
    const factCovered = at(detail.covered_until);
    if (Number.isFinite(factNewest)) facts.push(['newest entry', `${clock(factNewest)}Z`]);
    if (Number.isFinite(factCovered) && factCovered !== factNewest) facts.push(['covered through', `${clock(factCovered)}Z`]);
    if (Number.isFinite(at(detail.crawler_alive_at))) facts.push(['our crawler alive', `${clock(at(detail.crawler_alive_at))}Z`]);
    if (full && Number.isFinite(Number(full.revision))) facts.push(['ledger revisions', String(full.revision)]);
    if (detail.index_missing === true) facts.push(['archive index', 'missing']);

    const notes = [];
    notes.push(
      el('p', { class: 'tl-note tl-legend', text: `times in UTC and your local zone (${zoneTitle()}); durations run between the steps above` })
    );
    if (state.error) {
      notes.push(
        el('p', { class: 'tl-warn', text: `the ledger record did not load (${state.error.message}), so the transition history is missing` })
      );
    } else if (full && events.length === 0) {
      notes.push(el('p', { class: 'tl-note', text: 'the ledger holds no transition events for this row' }));
    }

    const blocks = [
      el('ol', { class: 'tl-steps' }, nodes),
      facts.length
        ? el('dl', { class: 'tl-facts' }, facts.flatMap(([key, value]) => [el('dt', { text: key }), el('dd', { text: value })]))
        : null,
      ...notes,
    ];

    state.body.replaceChildren(...blocks.filter(Boolean));
    state.body.setAttribute('aria-busy', 'false');

    state.json.href = permalink(row);
    state.source.textContent = sourceLine();
  }

  /// What the footer says about where the timeline came from. A failed copy temporarily replaces it
  /// with the URL, so it has to be rebuildable rather than written once.
  function sourceLine() {
    const full = state.full;
    if (!full) return 'alert ledger row';
    const count = Array.isArray(full.events) ? full.events.length : 0;
    return `alert.event · ${count} revision${count === 1 ? '' : 's'}${full.ruleset_version ? ` · ${full.ruleset_version}` : ''}`;
  }

  function tick() {
    if (!state.open || document.hidden || !state.tickers.length) return;
    const now = Date.now();
    for (const item of state.tickers) item.node.textContent = item.text(now);
  }

  window.AlertTimeline = { open, close: shutdown, permalink, severity };
})();
