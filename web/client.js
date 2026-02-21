(function () {
  const SAMPLE_INTERVAL_MS = 4000;
  const nodesRoot = document.getElementById('nodes-root');
  const rangeSelect = document.getElementById('range-select');

  const rangeMap = {
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
  };

  function escapeHtml(input) {
    return String(input == null ? '' : input)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDuration(ms) {
    const s = Math.max(0, Math.floor((ms || 0) / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return h + 'h ' + m + 'm';
    if (m > 0) return m + 'm ' + sec + 's';
    return sec + 's';
  }

  function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (d > 0) return d + 'd ' + h + 'h ' + m + 'm';
    if (h > 0) return h + 'h ' + m + 'm ' + s + 's';
    if (m > 0) return m + 'm ' + s + 's';
    return s + 's';
  }

  function getWindowAxisLabels(windowMs) {
    function formatAgo(ms) {
      const days = ms / (24 * 60 * 60 * 1000);
      if (days >= 60) return Math.round(days / 30) + 'mo ago';
      if (days >= 2) return Math.round(days) + 'd ago';
      return Math.round(ms / (60 * 60 * 1000)) + 'h ago';
    }
    return { start: formatAgo(windowMs), mid: formatAgo(windowMs / 2) };
  }

  function renderTimelineBars(barsData) {
    if (!barsData.length) return '<div class="muted">No checks yet.</div>';
    const bars = barsData.map((s, i) => {
      const h0 = ((i * 24) / barsData.length).toFixed(1);
      const h1 = (((i + 1) * 24) / barsData.length).toFixed(1);
      const tip = escapeHtml(h0 + 'h-' + h1 + 'h - ' + s.label);
      if (s.level === 'mixed') {
        const pct = Math.round((s.downRatio || 0) * 100);
        return '<span class="bar bar-mixed" style="background:linear-gradient(to top,var(--red) ' + pct + '%,var(--green) ' + pct + '%);" title="' + tip + '"></span>';
      }
      return '<span class="bar bar-' + s.level + '" title="' + tip + '"></span>';
    }).join('');
    return '<div class="timeline">' + bars + '</div>';
  }

  function renderPingGraph(history, windowMs) {
    if (!history.length) return '<div class="muted small">No ping data yet.</div>';
    const W = 760;
    const H = 110;
    const P = 12;
    const latencies = history.filter((s) => s.online && !s.maintenance && Number.isFinite(s.latencyMs)).map((s) => s.latencyMs);
    const maxLat = Math.max(150, ...(latencies.length ? latencies : [150]));
    const uw = W - P * 2;
    const uh = H - P * 2;
    const stepX = history.length > 1 ? uw / (history.length - 1) : 0;

    const points = history.map((s, i) => {
      const x = P + i * stepX;
      if (!s.online || s.maintenance || !Number.isFinite(s.latencyMs)) return { x, y: null };
      const norm = s.latencyMs / Math.max(1, maxLat);
      return { x, y: H - P - norm * uh };
    });

    let pathStr = '';
    const paths = [];
    for (const pt of points) {
      if (pt.y == null) {
        if (pathStr) {
          paths.push(pathStr);
          pathStr = '';
        }
        continue;
      }
      pathStr += (pathStr ? ' L' : 'M') + pt.x.toFixed(1) + ' ' + pt.y.toFixed(1);
    }
    if (pathStr) paths.push(pathStr);

    const fillPaths = paths.map((d) => {
      const first = d.match(/M([\d.]+) ([\d.]+)/);
      const last = d.match(/.*L([\d.]+) ([\d.]+)$/) || first;
      if (!first || !last) return '';
      return '<path d="' + d + ' L' + last[1] + ' ' + (H - P) + ' L' + first[1] + ' ' + (H - P) + ' Z" class="ping-fill"/>';
    });

    let maintenanceBands = [];
    let maintStart = null;
    for (let i = 0; i < history.length; i++) {
      if (history[i].maintenance) {
        if (maintStart == null) maintStart = i;
      } else if (maintStart != null) {
        maintenanceBands.push({ s: maintStart, e: i - 1 });
        maintStart = null;
      }
    }
    if (maintStart != null) maintenanceBands.push({ s: maintStart, e: history.length - 1 });

    const maintenanceRects = maintenanceBands.map((b) => {
      const half = Math.max(2, stepX / 2);
      const sx = Math.max(P, P + b.s * stepX - half);
      const ex = Math.min(W - P, P + b.e * stepX + half);
      const maintDurationMs = Math.max(SAMPLE_INTERVAL_MS, Number(history[b.e].ts || 0) - Number(history[b.s].ts || 0));
      const tip = escapeHtml(history[b.s].at + ' -> ' + history[b.e].at + ' - maintenance ' + formatDuration(maintDurationMs));
      return '<rect x="' + sx.toFixed(1) + '" y="' + P + '" width="' + Math.max(2, ex - sx).toFixed(1) + '" height="' + uh + '" class="maintenance-band"><title>' + tip + '</title></rect>';
    }).join('');

    let bands = [];
    let outStart = null;
    for (let i = 0; i < history.length; i++) {
      if (!history[i].online) {
        if (outStart == null) outStart = i;
      } else if (outStart != null) {
        bands.push({ s: outStart, e: i - 1 });
        outStart = null;
      }
    }
    if (outStart != null) bands.push({ s: outStart, e: history.length - 1 });

    const oRects = bands.map((b) => {
      const half = Math.max(2, stepX / 2);
      const sx = Math.max(P, P + b.s * stepX - half);
      const ex = Math.min(W - P, P + b.e * stepX + half);
      const downDurationMs = Math.max(SAMPLE_INTERVAL_MS, Number(history[b.e].ts || 0) - Number(history[b.s].ts || 0));
      const tip = escapeHtml(history[b.s].at + ' -> ' + history[b.e].at + ' - down ' + formatDuration(downDurationMs));
      return '<rect x="' + sx.toFixed(1) + '" y="' + P + '" width="' + Math.max(2, ex - sx).toFixed(1) + '" height="' + uh + '" class="outage-band"><title>' + tip + '</title></rect>';
    }).join('');

    const pingDots = (history.length <= 180 ? points.filter((p) => p.y != null) : [])
      .map((p) => '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="2" class="ping-dot"/>')
      .join('');

    const hitW = Math.max(4, stepX || 4);
    const hits = history.map((s, i) => {
      const x = P + i * stepX - hitW / 2;
      let tip = s.at + ' - offline' + (s.error ? ' (' + s.error + ')' : '');
      if (s.maintenance) tip = s.at + ' - maintenance';
      else if (s.online && Number.isFinite(s.latencyMs)) tip = s.at + ' - ' + s.latencyMs + 'ms';
      return '<rect x="' + x.toFixed(1) + '" y="' + P + '" width="' + hitW.toFixed(1) + '" height="' + uh + '" fill="transparent"><title>' + escapeHtml(tip) + '</title></rect>';
    }).join('');

    const gridY = [P, H / 2, H - P];
    const gridLabels = [maxLat, Math.round(maxLat / 2), 0].map((v, i) =>
      '<text x="' + (W - P - 2) + '" y="' + (gridY[i] + 4) + '" class="axis-lbl">' + v + 'ms</text>'
    ).join('');

    const gridLines = gridY.map((y) => '<line x1="' + P + '" y1="' + y + '" x2="' + (W - P) + '" y2="' + y + '" class="grid-line"/>').join('');
    const axis = getWindowAxisLabels(windowMs);

    return '<div class="graph-wrap">'
      + '<svg class="ping-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">'
      + '<defs><linearGradient id="fillGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5a7dff" stop-opacity="0.35"/><stop offset="100%" stop-color="#5a7dff" stop-opacity="0.02"/></linearGradient></defs>'
      + gridLines + maintenanceRects + oRects + fillPaths.join('') + paths.map((d) => '<path d="' + d + '" class="ping-line"/>').join('') + pingDots + gridLabels + hits
      + '</svg><div class="graph-scale"><span>' + axis.start + '</span><span>' + axis.mid + '</span><span>Now</span></div></div>';
  }

  function statusBadge(label) {
    const cls = label === 'Operational' ? 'badge-ok' : label === 'Maintenance' ? 'badge-warn' : 'badge-bad';
    const dot = label === 'Operational' ? 'dot-ok' : label === 'Maintenance' ? 'dot-warn' : 'dot-bad';
    return '<span class="badge ' + cls + '"><span class="dot ' + dot + '"></span>' + label + '</span>';
  }

  function renderNodeCard(node, rangeLabel, windowMs) {
    const timeline = renderTimelineBars(node.uptimeBars || []);
    const graph = renderPingGraph(node.history || [], windowMs);
    const pingDisplay = node.latencyMs != null ? node.latencyMs + 'ms' : '—';
    const avgPingDisplay = node.avgLatencyMs != null ? node.avgLatencyMs + 'ms' : '—';
    const checkedAtDisplay = node.lastCheckedAt ? new Date(node.lastCheckedAt).toLocaleTimeString() : '—';
    const axis = getWindowAxisLabels(windowMs);

    return '<div class="node-card">'
      + '<div class="node-head"><div class="node-title"><span class="node-name">' + escapeHtml(node.name) + '</span><span class="node-id">#' + node.id + '</span></div>' + statusBadge(node.statusLabel) + '</div>'
      + '<div class="node-fqdn">' + escapeHtml(node.fqdn || 'No FQDN') + '</div>'
      + '<div class="node-stats">'
      + '<div class="stat-chip"><span class="chip-label">RAM</span><span class="chip-val">' + (node.memoryMb / 1024).toFixed(1) + ' GB</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Disk</span><span class="chip-val">' + (node.diskMb / 1024).toFixed(0) + ' GB</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Ping</span><span class="chip-val">' + pingDisplay + '</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Avg Ping</span><span class="chip-val">' + avgPingDisplay + '</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Uptime ' + rangeLabel + '</span><span class="chip-val">' + node.uptimePercent + '%</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Checks</span><span class="chip-val">' + node.checks + '</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Incidents</span><span class="chip-val">' + node.downIncidents + '</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Downtime</span><span class="chip-val">' + formatDuration(node.downDurationMs) + '</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Longest Outage</span><span class="chip-val">' + formatDuration(node.longestDownMs) + '</span></div>'
      + '<div class="stat-chip"><span class="chip-label">Last Check</span><span class="chip-val">' + checkedAtDisplay + '</span></div>'
      + '</div>'
      + graph
      + '<div class="timeline-wrap">' + timeline + '<div class="timeline-meta"><span>' + axis.start + '</span><span class="uptime-pct">' + node.uptimePercent + '% uptime</span><span>Now</span></div></div>'
      + '</div>';
  }

  function computeSummary(nodes) {
    const operational = nodes.filter((n) => n.statusLabel === 'Operational').length;
    const maintenance = nodes.filter((n) => n.statusLabel === 'Maintenance').length;
    const offline = nodes.filter((n) => n.statusLabel === 'Offline').length;
    const online = operational + maintenance;
    const availability = nodes.length ? Math.round((online / nodes.length) * 100) : 0;
    const fleetAvgUptime = nodes.length
      ? (nodes.reduce((sum, n) => sum + Number(n.uptimePercent || 0), 0) / nodes.length).toFixed(2)
      : '0.00';
    const pingValues = nodes.map((n) => n.avgLatencyMs).filter((v) => Number.isFinite(v));
    const fleetAvgPing = pingValues.length ? Math.round(pingValues.reduce((sum, v) => sum + v, 0) / pingValues.length) + 'ms' : '—';
    return { operational, maintenance, offline, online, availability, fleetAvgUptime, fleetAvgPing };
  }

  function renderFromPayload(payload) {
    const nodes = Array.isArray(payload.nodes) ? payload.nodes : [];
    const summary = computeSummary(nodes);
    const anyDown = nodes.some((n) => n.statusLabel === 'Offline');
    const allOnline = nodes.every((n) => n.statusLabel === 'Operational' || n.statusLabel === 'Maintenance');
    const overallLabel = anyDown ? 'Partial Outage' : (allOnline ? 'All Systems Operational' : 'Checking...');

    const banner = document.getElementById('overall-banner');
    const icon = document.getElementById('overall-icon');
    const label = document.getElementById('overall-label');
    const sub = document.getElementById('overall-sub');

    banner.classList.remove('overall-ok', 'overall-bad');
    banner.classList.add(anyDown ? 'overall-bad' : 'overall-ok');
    icon.textContent = anyDown ? '⚠️' : '✅';
    label.textContent = overallLabel;

    const checkedText = payload.monitor && payload.monitor.lastUpdated
      ? new Date(payload.monitor.lastUpdated).toLocaleTimeString()
      : '—';
    const intervalSec = payload.monitor && payload.monitor.sampleIntervalMs
      ? Math.round(payload.monitor.sampleIntervalMs / 1000)
      : 4;
    sub.textContent = 'Last checked ' + checkedText + ' · Auto-updating every ' + intervalSec + 's';

    const statusEl = document.getElementById('metric-status');
    statusEl.textContent = payload.status === 'ok' ? 'Online' : 'Degraded';
    statusEl.className = 'value ' + (payload.status === 'ok' ? 'value-ok' : 'value-warn');

    document.getElementById('metric-uptime').textContent = formatUptime(Number(payload.uptimeSeconds || 0));
    document.getElementById('metric-nodes-online').innerHTML = summary.online + '<span style="font-size:14px;color:var(--muted)">/' + nodes.length + '</span>';
    document.getElementById('metric-operational').textContent = String(summary.operational);
    document.getElementById('metric-maintenance').textContent = String(summary.maintenance);
    document.getElementById('metric-offline').textContent = String(summary.offline);
    document.getElementById('metric-fleet-uptime').textContent = summary.fleetAvgUptime + '%';
    document.getElementById('metric-fleet-ping').textContent = summary.fleetAvgPing;
    document.getElementById('metric-availability').textContent = summary.availability + '%';
    document.getElementById('metric-availability-bar').style.width = summary.availability + '%';

    const rangeLabel = payload.monitor && payload.monitor.rangeLabel ? payload.monitor.rangeLabel : '24h';
    const windowMs = payload.monitor && payload.monitor.rangeWindowMs ? payload.monitor.rangeWindowMs : rangeMap['24h'];
    if (payload.monitor && payload.monitor.lastError) {
      nodesRoot.innerHTML = '<div class="error-box">⚠ Failed to load node data: ' + escapeHtml(payload.monitor.lastError) + '</div>';
      return;
    }
    nodesRoot.innerHTML = nodes.length ? nodes.map((node) => renderNodeCard(node, rangeLabel, windowMs)).join('') : '<div class="muted">No nodes found.</div>';
  }

  let selectedRange = '24h';
  let pollTimer = null;

  async function fetchAndRender() {
    const response = await fetch('/api/status?range=' + encodeURIComponent(selectedRange), { cache: 'no-store' });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const payload = await response.json();
    renderFromPayload(payload);
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      fetchAndRender().catch(() => {});
    }, SAMPLE_INTERVAL_MS);
  }

  rangeSelect.addEventListener('change', function () {
    selectedRange = rangeSelect.value;
    fetchAndRender().catch(() => {});
  });

  const initial = window.__STATUS_INITIAL__ || null;
  if (initial) {
    renderFromPayload(initial);
  }
  startPolling();
})();
