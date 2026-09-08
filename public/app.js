/**
 * Dashboard rendering.
 *
 * The charts are hand-drawn SVG rather than a charting library: the specs this
 * dashboard follows (2px strokes, 4px rounded data-ends, a 2px surface ring on
 * overlapping markers, a crosshair that snaps to the nearest bucket) are all
 * things a library would need fighting to produce.
 *
 * Colours are never hard-coded here — every mark takes a CSS custom property,
 * so light/dark is settled entirely in the stylesheet.
 */

const SVG_NS = 'http://www.w3.org/2000/svg';

const RANGE_LABELS = {
  weekly: 'Last 7 days',
  monthly: 'Last 30 days',
  yearly: 'Last 12 months',
};

const COMPARISON_LABELS = {
  weekly: 'Previous 7 days',
  monthly: 'Previous 30 days',
  yearly: 'Same period last year',
};

const KPI_TILES = [
  { range: 'weekly', label: 'This week', sub: 'Last 7 days' },
  { range: 'monthly', label: 'This month', sub: 'Last 30 days' },
  { range: 'yearly', label: 'This year', sub: 'Last 12 months' },
];

const state = {
  range: 'monthly',
  overview: null,
  /** Guards against an earlier response landing after a later one. */
  requestSeq: 0,
};

/* Auto-refresh pacing. The server decides when its cache goes stale and tells
 * us in `meta.nextRefreshAt`; these are only the guard rails around that. */
const MIN_REFRESH_MS = 60 * 1000;
const FALLBACK_REFRESH_MS = 30 * 60 * 1000;
const RETRY_REFRESH_MS = 5 * 60 * 1000;
const REFRESH_JITTER_MS = 30 * 1000;

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

const fullNumber = new Intl.NumberFormat('en-GB');
const compactNumber = new Intl.NumberFormat('en-GB', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

const formatFull = (n) => fullNumber.format(Math.round(n));
const formatCompact = (n) => (Math.abs(n) < 1000 ? formatFull(n) : compactNumber.format(n));

function formatPercent(value) {
  if (value === null || value === undefined) return null;
  const rounded = Math.abs(value) < 0.05 ? 0 : value;
  return `${rounded > 0 ? '+' : ''}${rounded.toFixed(1)}%`;
}

function formatDuration(seconds) {
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  return `${Math.floor(total / 60)}m ${String(total % 60).padStart(2, '0')}s`;
}

/** Bucket keys are YYYY-MM-DD (days) or YYYYMM (months). */
function parseBucket(bucket) {
  if (bucket.includes('-')) {
    const [y, m, d] = bucket.split('-').map(Number);
    return { date: new Date(Date.UTC(y, m - 1, d)), granularity: 'day' };
  }
  const y = Number(bucket.slice(0, 4));
  const m = Number(bucket.slice(4, 6));
  return { date: new Date(Date.UTC(y, m - 1, 1)), granularity: 'month' };
}

function formatBucketTick(bucket) {
  const { date, granularity } = parseBucket(bucket);
  if (granularity === 'month') {
    return date.toLocaleDateString('en-GB', { month: 'short', timeZone: 'UTC' });
  }
  return date.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function formatBucketLong(bucket) {
  const { date, granularity } = parseBucket(bucket);
  if (granularity === 'month') {
    return date.toLocaleDateString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  }
  return date.toLocaleDateString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

function formatDayRange(window) {
  const fmt = (iso) => {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-GB', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  };
  return `${fmt(window.start)} – ${fmt(window.end)}`;
}

/* ------------------------------------------------------------------ *
 * SVG helpers
 * ------------------------------------------------------------------ */

function svgEl(tag, attrs = {}, styles = {}) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value !== null && value !== undefined) node.setAttribute(key, String(value));
  }
  // Colours go through style, not presentation attributes: var() only resolves
  // in a style declaration.
  for (const [key, value] of Object.entries(styles)) node.style.setProperty(key, value);
  return node;
}

let measureCtx;
function measureText(text, font) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  return measureCtx.measureText(text).width;
}

/** Truncate to fit a pixel width, with a real ellipsis rather than a clip. */
function truncateToWidth(text, maxWidth, font) {
  if (measureText(text, font) <= maxWidth) return text;
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (measureText(`${text.slice(0, mid)}…`, font) <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return `${text.slice(0, low)}…`;
}

/**
 * Pick the axis maximum from a clean *step*, not by rounding the max.
 * Rounding 2,900 up to 5,000 and dividing by four gives ticks of 1.3K / 2.5K /
 * 3.8K; choosing the step first gives 1K / 2K / 3K / 4K and less dead space.
 */
function niceScale(maxValue, tickCount) {
  if (maxValue <= 0) return { max: tickCount, step: 1 };
  const rough = maxValue / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  const normalised = rough / magnitude;
  const step =
    (normalised <= 1 ? 1 : normalised <= 2 ? 2 : normalised <= 2.5 ? 2.5 : normalised <= 5 ? 5 : 10) *
    magnitude;
  return { max: step * tickCount, step };
}

/**
 * Tick indices at a regular stride, always including the first and last.
 *
 * Rounding evenly spaced fractions to integers instead would drop one label
 * out of the middle of an otherwise complete run (11 ticks across 12 months
 * leaves a hole where March should be), which reads as a bug rather than as
 * thinning.
 */
function pickTickIndices(length, capacity) {
  if (length <= capacity) return Array.from({ length }, (_, i) => i);
  const stride = Math.max(1, Math.ceil((length - 1) / Math.max(1, capacity - 1)));
  const indices = [];
  for (let i = 0; i < length; i += stride) indices.push(i);
  if (indices[indices.length - 1] !== length - 1) {
    // Drop the penultimate tick if keeping the last one would crowd it.
    if (length - 1 - indices[indices.length - 1] < stride / 2) indices.pop();
    indices.push(length - 1);
  }
  return indices;
}

/* ------------------------------------------------------------------ *
 * Tooltip
 * ------------------------------------------------------------------ */

const tooltipEl = document.getElementById('tooltip');

/**
 * @param {{title: string, rows: Array<{name: string, value: string, color?: string}>, note?: string}} content
 */
function showTooltip(content, clientX, clientY) {
  tooltipEl.replaceChildren();

  const title = document.createElement('div');
  title.className = 'tooltip-title';
  // Bucket labels and page titles come from the API — always textContent.
  title.textContent = content.title;
  tooltipEl.append(title);

  for (const row of content.rows) {
    const line = document.createElement('div');
    line.className = 'tooltip-row';
    if (row.color) {
      const key = document.createElement('span');
      key.className = 'tooltip-key';
      key.style.background = row.color;
      line.append(key);
    }
    const value = document.createElement('span');
    value.className = 'tooltip-value';
    value.textContent = row.value;
    const name = document.createElement('span');
    name.className = 'tooltip-name';
    name.textContent = row.name;
    line.append(value, name);
    tooltipEl.append(line);
  }

  if (content.note) {
    const note = document.createElement('div');
    note.className = 'tooltip-note';
    note.textContent = content.note;
    tooltipEl.append(note);
  }

  tooltipEl.hidden = false;
  const box = tooltipEl.getBoundingClientRect();
  const margin = 12;
  let left = clientX + margin;
  if (left + box.width > window.innerWidth - margin) left = clientX - box.width - margin;
  let top = clientY - box.height - margin;
  if (top < margin) top = clientY + margin;
  tooltipEl.style.left = `${Math.max(margin, left)}px`;
  tooltipEl.style.top = `${top}px`;
}

function hideTooltip() {
  tooltipEl.hidden = true;
}

/* ------------------------------------------------------------------ *
 * KPI tiles
 * ------------------------------------------------------------------ */

/**
 * A tile whose period could not be loaded. It keeps its place in the row — a
 * disappearing tile reads as "this metric no longer exists" rather than "this
 * did not load" — and gives the reason in muted text rather than a status
 * colour, since a missing number is not a bad number.
 */
function unavailableTile({ label }, reason) {
  const card = document.createElement('div');
  card.className = 'kpi kpi-unavailable';

  const heading = document.createElement('div');
  heading.className = 'kpi-label';
  heading.textContent = label;

  const value = document.createElement('div');
  value.className = 'kpi-value';
  value.textContent = '—';

  const note = document.createElement('div');
  note.className = 'kpi-meta';
  note.textContent = reason || 'Could not be loaded.';

  card.append(heading, value, note);
  return card;
}

function renderKpis(headline, { errors = {}, fallbackMessage = null } = {}) {
  const row = document.getElementById('kpi-row');
  row.replaceChildren();

  for (const tile of KPI_TILES) {
    const data = headline?.[tile.range] ?? null;
    if (!data) {
      row.append(unavailableTile(tile, errors[tile.range]?.message || fallbackMessage));
      continue;
    }

    const card = document.createElement('div');
    card.className = 'kpi';

    const label = document.createElement('div');
    label.className = 'kpi-label';
    label.textContent = tile.label;

    const value = document.createElement('div');
    value.className = 'kpi-value';
    value.textContent = formatFull(data.visitors);
    value.title = `${formatFull(data.visitors)} visitors`;

    const meta = document.createElement('div');
    meta.className = 'kpi-meta';

    const change = formatPercent(data.change.visitors);
    if (change) {
      const delta = document.createElement('span');
      delta.className = 'delta';
      // More visitors is good here, so direction and sentiment agree.
      delta.dataset.direction =
        data.change.visitors > 0.05 ? 'up' : data.change.visitors < -0.05 ? 'down' : 'flat';
      delta.textContent = change;
      meta.append(delta);
    }

    const context = document.createElement('span');
    context.textContent = change
      ? `vs ${COMPARISON_LABELS[tile.range].toLowerCase()}`
      : `${tile.sub} · no comparison available`;
    meta.append(context);

    const window = document.createElement('div');
    window.className = 'kpi-meta';
    window.textContent = formatDayRange(data.window.current);

    card.append(label, value, meta, window);
    row.append(card);
  }
}

/* ------------------------------------------------------------------ *
 * Trend chart — line, current period vs the comparison period
 * ------------------------------------------------------------------ */

const AXIS_FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';

function renderTrend() {
  const container = document.getElementById('trend-chart');
  const { trend, meta } = state.overview;
  container.replaceChildren();
  if (!trend.length) return;

  const comparisonLabel = COMPARISON_LABELS[meta.range];

  // Legend first: two series, so identity never rests on colour alone.
  const legend = document.createElement('ul');
  legend.className = 'legend';
  for (const item of [
    { name: RANGE_LABELS[meta.range], color: 'var(--series-1)' },
    { name: comparisonLabel, color: 'var(--series-context)' },
  ]) {
    const li = document.createElement('li');
    const key = document.createElement('span');
    key.className = 'legend-key';
    key.style.background = item.color;
    const text = document.createElement('span');
    text.textContent = item.name;
    li.append(key, text);
    legend.append(li);
  }
  container.append(legend);

  const width = Math.max(container.clientWidth || 640, 320);
  const plotHeight = 260;
  // The right margin holds the endpoint label; on a phone it would otherwise
  // eat a fifth of the plot, so both side margins tighten with the viewport.
  const narrow = width < 480;
  const margin = { top: 18, right: narrow ? 46 : 68, bottom: 30, left: narrow ? 40 : 52 };
  const innerWidth = width - margin.left - margin.right;
  const height = plotHeight + margin.top + margin.bottom;

  const tickCount = 4;
  const maxValue = Math.max(
    ...trend.map((d) => Math.max(d.visitors, d.previousVisitors ?? 0)),
  );
  const { max: yMax } = niceScale(maxValue, tickCount);

  const xAt = (i) => margin.left + (trend.length === 1 ? innerWidth / 2 : (i / (trend.length - 1)) * innerWidth);
  const yAt = (v) => margin.top + plotHeight - (v / yMax) * plotHeight;

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `Visitors per ${meta.granularity} for ${RANGE_LABELS[meta.range].toLowerCase()}, compared with ${comparisonLabel.toLowerCase()}.`,
  });

  // Gridlines and y ticks — solid hairlines, one step off the surface.
  for (let i = 0; i <= tickCount; i += 1) {
    const value = (yMax / tickCount) * i;
    const y = yAt(value);
    svg.append(
      svgEl(
        'line',
        { x1: margin.left, x2: margin.left + innerWidth, y1: y, y2: y, 'shape-rendering': 'crispEdges' },
        { stroke: i === 0 ? 'var(--axis)' : 'var(--grid)', 'stroke-width': '1' },
      ),
    );
    const label = svgEl(
      'text',
      { x: margin.left - 10, y: y + 4, 'text-anchor': 'end', 'font-size': '12' },
      { fill: 'var(--text-muted)', 'font-variant-numeric': 'tabular-nums' },
    );
    label.textContent = formatCompact(value);
    svg.append(label);
  }

  // X tick labels — never one per point. Capacity comes from the widest label
  // actually being drawn, so short month names get more ticks than long dates.
  const tickLabels = trend.map((d) => formatBucketTick(d.bucket));
  const widestTick = Math.max(...tickLabels.map((label) => measureText(label, AXIS_FONT)));
  const capacity = Math.max(2, Math.floor(innerWidth / (widestTick + 24)));
  for (const i of pickTickIndices(trend.length, capacity)) {
    const label = svgEl(
      'text',
      {
        x: xAt(i),
        y: margin.top + plotHeight + 20,
        'text-anchor': i === 0 ? 'start' : i === trend.length - 1 ? 'end' : 'middle',
        'font-size': '12',
      },
      { fill: 'var(--text-muted)' },
    );
    label.textContent = tickLabels[i];
    svg.append(label);
  }

  const linePath = (accessor) =>
    trend
      .map((d, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(2)},${yAt(accessor(d)).toFixed(2)}`)
      .join(' ');

  // Comparison series sits underneath, in the de-emphasis grey.
  if (trend.some((d) => d.previousVisitors !== null)) {
    svg.append(
      svgEl(
        'path',
        { d: linePath((d) => d.previousVisitors ?? 0), fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' },
        { stroke: 'var(--series-context)', 'stroke-width': '2' },
      ),
    );
  }

  // Current series: a 10% wash under a 2px line.
  const areaPath = `${linePath((d) => d.visitors)} L${xAt(trend.length - 1).toFixed(2)},${yAt(0).toFixed(2)} L${xAt(0).toFixed(2)},${yAt(0).toFixed(2)} Z`;
  svg.append(svgEl('path', { d: areaPath, stroke: 'none' }, { fill: 'var(--series-1)', 'fill-opacity': '0.1' }));
  svg.append(
    svgEl(
      'path',
      { d: linePath((d) => d.visitors), fill: 'none', 'stroke-linejoin': 'round', 'stroke-linecap': 'round' },
      { stroke: 'var(--series-1)', 'stroke-width': '2' },
    ),
  );

  // One direct label, on the endpoint — the axis and tooltip carry the rest.
  const lastIndex = trend.length - 1;
  const last = trend[lastIndex];
  svg.append(
    svgEl(
      'circle',
      { cx: xAt(lastIndex), cy: yAt(last.visitors), r: 4.5 },
      { fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': '2' },
    ),
  );
  const endLabel = svgEl(
    'text',
    { x: xAt(lastIndex) + 10, y: yAt(last.visitors) + 4, 'font-size': '12', 'font-weight': '600' },
    { fill: 'var(--text-primary)' },
  );
  endLabel.textContent = formatCompact(last.visitors);
  svg.append(endLabel);

  /* --- Hover layer: crosshair snapping to the nearest bucket --- */

  const crosshair = svgEl(
    'line',
    { y1: margin.top, y2: margin.top + plotHeight, 'shape-rendering': 'crispEdges', visibility: 'hidden' },
    { stroke: 'var(--axis)', 'stroke-width': '1' },
  );
  const focusCurrent = svgEl(
    'circle',
    { r: 4.5, visibility: 'hidden' },
    { fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': '2' },
  );
  const focusPrevious = svgEl(
    'circle',
    { r: 4.5, visibility: 'hidden' },
    { fill: 'var(--series-context)', stroke: 'var(--surface-1)', 'stroke-width': '2' },
  );
  svg.append(crosshair, focusPrevious, focusCurrent);

  let activeIndex = null;

  function highlight(index, clientX, clientY) {
    const point = trend[index];
    activeIndex = index;
    const x = xAt(index);
    crosshair.setAttribute('x1', x);
    crosshair.setAttribute('x2', x);
    crosshair.setAttribute('visibility', 'visible');
    focusCurrent.setAttribute('cx', x);
    focusCurrent.setAttribute('cy', yAt(point.visitors));
    focusCurrent.setAttribute('visibility', 'visible');

    if (point.previousVisitors !== null) {
      focusPrevious.setAttribute('cx', x);
      focusPrevious.setAttribute('cy', yAt(point.previousVisitors));
      focusPrevious.setAttribute('visibility', 'visible');
    } else {
      focusPrevious.setAttribute('visibility', 'hidden');
    }

    const rows = [
      { name: RANGE_LABELS[meta.range], value: formatFull(point.visitors), color: 'var(--series-1)' },
    ];
    if (point.previousVisitors !== null) {
      rows.push({
        name: comparisonLabel,
        value: formatFull(point.previousVisitors),
        color: 'var(--series-context)',
      });
    }
    rows.push({ name: 'page views', value: formatFull(point.pageViews) });

    const rect = svg.getBoundingClientRect();
    showTooltip(
      {
        title: formatBucketLong(point.bucket),
        rows,
        note: point.partial ? 'This period is still in progress.' : undefined,
      },
      clientX ?? rect.left + x,
      clientY ?? rect.top + yAt(point.visitors),
    );
  }

  function clearHighlight() {
    activeIndex = null;
    crosshair.setAttribute('visibility', 'hidden');
    focusCurrent.setAttribute('visibility', 'hidden');
    focusPrevious.setAttribute('visibility', 'hidden');
    hideTooltip();
  }

  const overlay = svgEl('rect', {
    x: margin.left,
    y: margin.top,
    width: innerWidth,
    height: plotHeight,
    fill: 'transparent',
    tabindex: '0',
    role: 'application',
    'aria-label': 'Visitor trend. Use the left and right arrow keys to read each point.',
  });

  overlay.addEventListener('pointermove', (event) => {
    const rect = svg.getBoundingClientRect();
    const ratio = (event.clientX - rect.left - margin.left) / innerWidth;
    const index = Math.max(0, Math.min(trend.length - 1, Math.round(ratio * (trend.length - 1))));
    highlight(index, event.clientX, event.clientY);
  });
  overlay.addEventListener('pointerleave', clearHighlight);
  overlay.addEventListener('focus', () => highlight(activeIndex ?? trend.length - 1));
  overlay.addEventListener('blur', clearHighlight);
  overlay.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    event.preventDefault();
    const step = event.key === 'ArrowRight' ? 1 : -1;
    const next = Math.max(0, Math.min(trend.length - 1, (activeIndex ?? trend.length - 1) + step));
    highlight(next);
  });
  svg.append(overlay);

  container.append(svg);
}

/* ------------------------------------------------------------------ *
 * Top pages — horizontal bars, one hue (nominal categories)
 * ------------------------------------------------------------------ */

function renderPages() {
  const container = document.getElementById('pages-chart');
  const { topPages } = state.overview;
  container.replaceChildren();

  if (!topPages.length) {
    const empty = document.createElement('p');
    empty.className = 'footnote';
    empty.textContent = 'No page data for this period.';
    container.append(empty);
    return;
  }

  const width = Math.max(container.clientWidth || 640, 320);
  const narrow = width < 480;
  const rowHeight = 34;
  const barThickness = 20; // capped well under 24px, leaving the band as air
  const labelWidth = Math.min(300, Math.max(narrow ? 104 : 140, Math.round(width * 0.32)));
  // Reserve exactly what the longest value needs, rather than a fixed column —
  // on a phone "42K" should not hold back the same width as "590.8K".
  const valueWidth =
    Math.ceil(Math.max(...topPages.map((p) => measureText(formatCompact(p.views), AXIS_FONT)))) + 12;
  const paddingLeft = 4;
  const barLeft = paddingLeft + labelWidth + 14;
  const barMax = Math.max(40, width - barLeft - valueWidth - 8);
  const height = topPages.length * rowHeight + 8;

  const maxViews = Math.max(...topPages.map((p) => p.views), 1);

  const svg = svgEl('svg', {
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': `The ${topPages.length} most visited pages by page views.`,
  });

  topPages.forEach((page, i) => {
    const top = i * rowHeight + 4;
    const barY = top + (rowHeight - barThickness) / 2 - 2;
    // The 2px surface gap between neighbours comes from the band being taller
    // than the bar, not from a stroke around the mark.
    const barWidth = Math.max(2, (page.views / maxViews) * barMax);

    const label = svgEl(
      'text',
      { x: paddingLeft, y: barY + barThickness / 2 + 4, 'font-size': '12' },
      { fill: 'var(--text-primary)' },
    );
    label.textContent = truncateToWidth(page.path, labelWidth, AXIS_FONT);
    svg.append(label);

    // Rounded at the data end, square at the baseline: two rects, the outer one
    // rounded and an inner square patch pinning the baseline edge.
    const bar = svgEl(
      'rect',
      { x: barLeft, y: barY, width: barWidth, height: barThickness, rx: 4, ry: 4 },
      { fill: 'var(--series-1)' },
    );
    svg.append(bar);
    if (barWidth > 4) {
      svg.append(
        svgEl(
          'rect',
          { x: barLeft, y: barY, width: 4, height: barThickness },
          { fill: 'var(--series-1)' },
        ),
      );
    }

    // Value at the tip, outside the bar, so it can never be clipped by it.
    const value = svgEl(
      'text',
      { x: barLeft + barWidth + 8, y: barY + barThickness / 2 + 4, 'font-size': '12' },
      { fill: 'var(--text-secondary)', 'font-variant-numeric': 'tabular-nums' },
    );
    value.textContent = formatCompact(page.views);
    svg.append(value);

    // A hit target spanning the whole band, not just the painted bar.
    const hit = svgEl('rect', {
      x: 0,
      y: top - 2,
      width,
      height: rowHeight,
      fill: 'transparent',
      tabindex: '0',
      role: 'button',
      'aria-label': `${page.path}: ${formatFull(page.views)} page views, ${formatFull(page.visitors)} visitors.`,
    });

    const tooltipFor = (clientX, clientY) => {
      const rect = svg.getBoundingClientRect();
      showTooltip(
        {
          title: page.title ? `${page.path} · ${page.title}` : page.path,
          rows: [
            { name: 'page views', value: formatFull(page.views), color: 'var(--series-1)' },
            { name: 'visitors', value: formatFull(page.visitors) },
            { name: 'avg. engagement', value: formatDuration(page.avgEngagementSeconds) },
          ],
        },
        clientX ?? rect.left + barLeft + barWidth,
        clientY ?? rect.top + barY,
      );
    };

    const lift = () => bar.style.setProperty('fill-opacity', '0.78');
    const settle = () => bar.style.removeProperty('fill-opacity');

    hit.addEventListener('pointermove', (event) => {
      lift();
      tooltipFor(event.clientX, event.clientY);
    });
    hit.addEventListener('pointerleave', () => {
      settle();
      hideTooltip();
    });
    hit.addEventListener('focus', () => {
      lift();
      tooltipFor();
    });
    hit.addEventListener('blur', () => {
      settle();
      hideTooltip();
    });

    svg.append(hit);
  });

  container.append(svg);
}

/**
 * Replace a chart with the reason it is missing. The other panels are separate
 * reports and keep rendering — one failed query costs the reader that panel,
 * not the page.
 */
function renderCardError(containerId, message) {
  const container = document.getElementById(containerId);
  container.replaceChildren();
  const box = document.createElement('p');
  box.className = 'card-error';
  box.textContent = message || 'This panel could not be loaded.';
  container.append(box);
}

/**
 * Draw whatever arrived. Called after every load, and again on a theme change
 * or a resize, so the null-handling lives in exactly one place.
 */
function renderPanels() {
  const data = state.overview;
  if (!data) return;
  const errors = data.errors || {};

  if (data.trend) renderTrend();
  else renderCardError('trend-chart', errors.trend?.message);

  if (data.topPages) renderPages();
  else renderCardError('pages-chart', errors.topPages?.message);

  document.getElementById('trend-footnote').textContent = data.trend?.some((d) => d.partial)
    ? `The final ${data.meta.granularity} is still in progress, so it reads lower than a complete one.`
    : '';

  renderTables();
}

/* ------------------------------------------------------------------ *
 * Table views — every value in a chart is reachable without hovering
 * ------------------------------------------------------------------ */

function buildTable(columns, rows) {
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const column of columns) {
    const th = document.createElement('th');
    if (column.numeric) th.className = 'num';
    th.textContent = column.label;
    headRow.append(th);
  }
  thead.append(headRow);

  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    columns.forEach((column, i) => {
      const td = document.createElement('td');
      if (column.numeric) td.className = 'num';
      else if (i === 0) td.className = 'path';
      td.textContent = row[i];
      tr.append(td);
    });
    tbody.append(tr);
  }

  table.append(thead, tbody);
  return table;
}

function unavailableNote(message) {
  const note = document.createElement('p');
  note.className = 'card-error';
  note.textContent = message || 'No data to show.';
  return note;
}

function renderTables() {
  const { trend, topPages, meta, errors = {} } = state.overview;

  document.getElementById('trend-table').replaceChildren(
    trend
      ? buildTable(
          [
            { label: meta.granularity === 'month' ? 'Month' : 'Day' },
            { label: 'Visitors', numeric: true },
            { label: COMPARISON_LABELS[meta.range], numeric: true },
            { label: 'Page views', numeric: true },
          ],
          trend.map((d) => [
            formatBucketLong(d.bucket) + (d.partial ? ' (in progress)' : ''),
            formatFull(d.visitors),
            d.previousVisitors === null ? '—' : formatFull(d.previousVisitors),
            formatFull(d.pageViews),
          ]),
        )
      : unavailableNote(errors.trend?.message),
  );

  document.getElementById('pages-table').replaceChildren(
    topPages
      ? buildTable(
          [
            { label: 'Page' },
            { label: 'Title' },
            { label: 'Page views', numeric: true },
            { label: 'Visitors', numeric: true },
            { label: 'Avg. engagement', numeric: true },
          ],
          topPages.map((p) => [
            p.path,
            p.title || '—',
            formatFull(p.views),
            formatFull(p.visitors),
            formatDuration(p.avgEngagementSeconds),
          ]),
        )
      : unavailableNote(errors.topPages?.message),
  );
}

/* ------------------------------------------------------------------ *
 * Chrome
 * ------------------------------------------------------------------ */

function renderRangeControl() {
  const control = document.getElementById('range-control');
  control.replaceChildren();
  for (const [range, label] of Object.entries(RANGE_LABELS)) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.setAttribute('aria-pressed', String(range === state.range));
    button.addEventListener('click', () => {
      if (state.range === range) return;
      const previousRange = state.range;
      state.range = range;
      renderRangeControl();
      // If the new range can't be loaded at all, the control must not keep
      // claiming it — the charts below still show the old range's data.
      loadOverview({ revertTo: previousRange });
    });
    control.append(button);
  }
}

function showNotice(message, tone) {
  const notice = document.getElementById('notice');
  notice.replaceChildren();
  if (!message) {
    notice.hidden = true;
    return;
  }
  const strong = document.createElement('strong');
  strong.textContent = tone === 'error' ? 'Could not load data. ' : 'Sample data. ';
  const text = document.createTextNode(message);
  notice.append(strong, text);
  notice.dataset.tone = tone;
  notice.hidden = false;
}

function setStale(isStale) {
  // Refetch keeps the frame: the previous render stays put at reduced opacity.
  for (const id of ['trend-chart', 'pages-chart']) {
    document.getElementById(id).classList.toggle('is-stale', isStale);
  }
}

async function fetchJson(url) {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/* ------------------------------------------------------------------ *
 * Refresh scheduling
 *
 * The page pulls again when the server's cached copy expires — but only while
 * somebody is actually looking at it. A hidden tab arms nothing and spends no
 * requests; it catches up the moment it is brought back to the front.
 * ------------------------------------------------------------------ */

let refreshTimer = null;
let refreshOverdue = false;

function scheduleRefresh(meta, { fallbackMs = FALLBACK_REFRESH_MS } = {}) {
  window.clearTimeout(refreshTimer);

  const target = meta?.nextRefreshAt
    ? new Date(meta.nextRefreshAt).getTime()
    : Date.now() + fallbackMs;

  // Jitter so a wall of open tabs doesn't wake in lockstep and stampede the
  // server the instant its cache lapses.
  const delay = Math.max(MIN_REFRESH_MS, target - Date.now()) + Math.random() * REFRESH_JITTER_MS;

  refreshTimer = window.setTimeout(() => {
    if (document.visibilityState === 'visible') {
      refreshAll();
      return;
    }
    // Nobody is looking. Don't spend a request on a hidden tab; leave a flag
    // for the visibilitychange handler instead of re-arming a timer.
    refreshOverdue = true;
  }, delay);
}

function refreshAll() {
  refreshOverdue = false;
  loadHeadline();
  loadOverview({ silent: true });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && refreshOverdue) refreshAll();
});

/**
 * Failures are reported in the tiles themselves rather than the page banner:
 * `loadOverview` owns the banner, and a headline problem is specific to these
 * three numbers. It never throws, so a background refresh can't swallow the
 * failure silently by catching it and moving on.
 */
async function loadHeadline() {
  try {
    const data = await fetchJson('/api/headline');
    renderKpis(data.headline, { errors: data.errors || {} });
  } catch (error) {
    renderKpis(null, { fallbackMessage: error.message });
  }
}

async function loadOverview({ silent = false, revertTo = null } = {}) {
  const seq = (state.requestSeq += 1);
  // A background refresh must not flicker the charts; only a load the reader
  // asked for holds the frame at reduced opacity.
  if (!silent) setStale(true);
  try {
    const data = await fetchJson(`/api/overview?range=${encodeURIComponent(state.range)}`);
    // A range clicked mid-flight supersedes this response.
    if (seq !== state.requestSeq) return;
    state.overview = data;
    // Either the sample-data banner, or nothing — this also clears an error
    // notice left by a previous attempt that has now recovered.
    showNotice(data.meta.usingMockData ? data.meta.mockReason : null, 'info');

    document.getElementById('range-window').textContent = formatDayRange(data.meta.current);
    document.getElementById('trend-sub').textContent =
      `Visitors per ${data.meta.granularity}, against ${COMPARISON_LABELS[data.meta.range].toLowerCase()}`;
    document.getElementById('pages-sub').textContent =
      `By page views · ${formatDayRange(data.meta.current)}`;
    document.getElementById('page-sub').textContent = data.summary
      ? `${formatFull(data.summary.visitors)} visitors · ${RANGE_LABELS[data.meta.range].toLowerCase()}`
      : RANGE_LABELS[data.meta.range];
    // `generatedAt` is when the data was fetched from Google, not when this
    // response was served — with a cache in front, those differ.
    const updatedAt = new Date(data.meta.generatedAt).toLocaleTimeString('en-GB', {
      hour: '2-digit',
      minute: '2-digit',
    });
    const source = data.meta.usingMockData ? 'Sample data' : 'Google Analytics 4';
    // Only worth stating in whole minutes; a sub-minute TTL (used in tests)
    // would otherwise print as "every 0.016666666666666666 min".
    const ttlMinutes = data.meta.cacheTtlMinutes;
    const cadence =
      ttlMinutes >= 1 ? ` · refreshes every ${Math.round(ttlMinutes)} min while open` : '';
    document.getElementById('page-foot').textContent =
      `${source} · times in ${data.meta.timeZone} · updated ${updatedAt}${cadence}`;

    renderPanels();
    // The SVG the tooltip was describing has just been replaced.
    hideTooltip();

    scheduleRefresh(data.meta);
  } catch (error) {
    if (seq !== state.requestSeq) return;
    // Nothing loaded, so the data on screen is still the previous range's.
    // Put the selector back to match it rather than leave the two disagreeing.
    if (revertTo) {
      state.range = revertTo;
      renderRangeControl();
    }
    showNotice(error.message, 'error');
    // Keep trying: a transient upstream failure shouldn't leave an open
    // dashboard frozen until someone reloads it by hand.
    scheduleRefresh(null, { fallbackMs: RETRY_REFRESH_MS });
  } finally {
    if (seq === state.requestSeq) setStale(false);
  }
}

function setupTableToggles() {
  for (const button of document.querySelectorAll('[data-table-toggle]')) {
    button.addEventListener('click', () => {
      const target = document.getElementById(`${button.dataset.tableToggle}-table`);
      const nowOpen = target.hidden;
      target.hidden = !nowOpen;
      button.setAttribute('aria-pressed', String(nowOpen));
    });
  }
}

function setupTheme() {
  const toggle = document.getElementById('theme-toggle');
  const stored = localStorage.getItem('dashboard-theme');
  if (stored === 'dark' || stored === 'light') document.documentElement.dataset.theme = stored;

  const isDark = () =>
    document.documentElement.dataset.theme === 'dark' ||
    (!document.documentElement.dataset.theme &&
      window.matchMedia('(prefers-color-scheme: dark)').matches);

  const sync = () => {
    toggle.textContent = isDark() ? 'Light mode' : 'Dark mode';
    toggle.setAttribute('aria-pressed', String(isDark()));
  };

  toggle.addEventListener('click', () => {
    const next = isDark() ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    localStorage.setItem('dashboard-theme', next);
    sync();
    // The charts bake surface-coloured rings into their marks, so redraw them.
    renderPanels();
  });

  sync();
}

function setupResize() {
  let lastWidth = window.innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(window.innerWidth - lastWidth) < 2 || !state.overview) return;
    lastWidth = window.innerWidth;
    renderPanels();
  });
}

renderRangeControl();
setupTableToggles();
setupTheme();
setupResize();
loadHeadline();
loadOverview();
