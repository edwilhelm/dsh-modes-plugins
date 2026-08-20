// ============================================================================
// auto-diff review panel — BROWSER HALF  (pass as the `client` arg to cordis_define)
// ============================================================================
// Evaluated in every open web page as the body of an async function whose
// symbol surface is (React, console, styles, host). No JSX, no TS, no module
// imports. It returns a Cordis plugin that:
//   * registers a `settings.trigger` row (sidebar-foot Settings trigger),
//   * registers a `settings.section` review panel (id 'auto-diff-review').
// The panel asks the host half (via host.call) for $DSH_HOME/sessions patches,
// lists them, and renders per-file colored hunks for the selected patch.
// ============================================================================

const { useState, useEffect, useMemo } = React;

// ---- unified-diff -> per-file blocks ----
// Returns [{ headers: [], hunks: [{ lines: [{ text, kind }] }] }]
function parseUnifiedDiff(text) {
  if (!text) return [];
  const files = [];
  let current = null;
  let hunk = null;

  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('--- ')) {
      // A file block really starts at its `--- old` header. Any `diff --git`
      // preamble/`---`/`+++` belongs to the same block; a previous block is
      // complete once a new `--- ` arrives.
      if (hunk && current) current.hunks.push(hunk);
      if (current) files.push(current);
      current = { headers: [line], hunks: [] };
      hunk = null;
      continue;
    }
    if (line.startsWith('diff --git ')) {
      // Preamble of the upcoming block; irrelevant to grouping (the `--- ` line
      // opens the real block). Pure no-op.
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('index ') || line.startsWith('new file mode ') || line.startsWith('deleted file mode ')) {
      // A header of the CURRENT block; without a current block the diff still
      // opens here (no `---`), so construct one.
      if (!current) current = { headers: [line], hunks: [] };
      else current.headers.push(line);
      continue;
    }
    if (line.startsWith('@@')) {
      if (hunk && current) current.hunks.push(hunk);
      hunk = current ? { lines: [] } : null;
      if (current) current.headers.push(line);
      continue;
    }
    if (!current || !hunk) continue;
    hunk.lines.push({
      text: line,
      kind: line.startsWith('+') ? '+' : line.startsWith('-') ? '-' : ' ',
    });
  }
  if (current && hunk) current.hunks.push(hunk);
  if (current) files.push(current);
  return files;
}

// ---- per-file diff renderer ----
function DiffFile({ block }) {
  return React.createElement('div', {
    style: { marginBottom: 18, fontFamily: 'var(--ds-font-mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)', fontSize: 12 }
  },
    ...block.headers.map((h, i) => React.createElement('div', {
      key: 'h' + i,
      style: { color: 'var(--dsw-text-muted, #8b8b9e)', padding: '2px 0', whiteSpace: 'pre-wrap' }
    }, h)),
    ...block.hunks.flatMap((hunk, hi) => hunk.lines.map((ln, li) => React.createElement('div', {
      key: hi + '-' + li,
      style: {
        display: 'flex',
        whiteSpace: 'pre-wrap',
        padding: '0 6px',
        color: ln.kind === '+' ? '#2ea043' : ln.kind === '-' ? '#cf222e' : 'var(--dsw-text, #e6e6ec)',
        background: ln.kind === '+' ? 'rgba(46,160,67,0.12)' : ln.kind === '-' ? 'rgba(207,34,46,0.12)' : 'transparent'
      }
    }, ln.text))));
}

function DiffViewer({ patch }) {
  const [byFile, setByFile] = useState(null);
  useEffect(() => {
    let live = true;
    setByFile(null);
    host.call('readPatch', { path: patch.patchPath }).then((r) => {
      if (!live) return;
      if (r && r.ok) setByFile(parseUnifiedDiff(r.text));
      else setByFile([]);
    }).catch(() => { if (live) setByFile([]); });
    return () => { live = false; };
  }, [patch.patchPath]);

  if (byFile === null) return React.createElement('div', { style: { color: 'var(--dsw-text-muted,#8b8b9e)' } }, 'Loading diff\u2026');

  const empty = byFile.length === 0 || !byFile.some((b) => b.hunks.some((h) => h.lines.length > 0));
  if (empty) return React.createElement('div', { style: { color: 'var(--dsw-text-muted,#8b8b9e)' } }, 'No hunks in this patch.');

  return React.createElement('div', null, byFile.map((block, i) => React.createElement('div', { key: i },
    React.createElement('div', { style: { fontWeight: 600, margin: '12px 0 4px', color: 'var(--dsw-text,#e6e6ec)' } },
      (block.headers.find((h) => h.startsWith('+++ ')) || block.headers[0] || '').replace(/^(\+\+\+|\-\-\-) [ab]\//, '').replace(/^\+\+\+ /, '')),
    React.createElement(DiffFile, { block: block }))));
}

function SessionList({ patches, selected, onSelect }) {
  // group by project
  const groups = useMemo(() => {
    const m = new Map();
    for (const p of patches) {
      if (!m.has(p.project)) m.set(p.project, []);
      m.get(p.project).push(p);
    }
    return [...m.entries()].map(([project, list]) => ({ project, list }));
  }, [patches]);
  const groupEls = groups.map((g) => {
    const rows = g.list.map((p) => {
      const sel = selected && selected.patchPath === p.patchPath;
      const sizeLabel = (p.size != null ? String(p.size) : '') + ' bytes';
      return React.createElement(
        'button',
        {
          key: p.patchPath,
          onClick: () => onSelect(p),
          style: {
            display: 'block', width: '100%', textAlign: 'left',
            padding: '5px 8px', marginBottom: 4, cursor: 'pointer', borderRadius: 6,
            border: sel ? '1px solid var(--dsw-accent,#6ea8fe)' : '1px solid transparent',
            background: sel ? 'rgba(110,168,254,0.12)' : 'transparent',
            color: 'var(--dsw-text,#e6e6ec)', fontFamily: 'inherit', fontSize: 12.5,
          },
        },
        React.createElement('span', null, p.sessionId),
        React.createElement('span', {
          style: { color: 'var(--dsw-text-muted,#8b8b9e)', marginLeft: 8, fontSize: 11 },
        }, sizeLabel),
      );
    });
    return React.createElement(
      'div',
      { key: g.project, style: { marginBottom: 14 } },
      React.createElement('div', {
        style: { fontWeight: 600, marginBottom: 6, color: 'var(--dsw-text-muted,#8b8b9e)' },
      }, g.project),
      rows,
    );
  });

  return React.createElement('div', null, groupEls);
}

function ReviewPanel() {
  const [patches, setPatches] = useState(null);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(null);

  const load = () => {
    setPatches(null); setError(null);
    host.call('listPatches').then((r) => {
      if (r && r.ok) setPatches(r.patches || []);
      else setError((r && r.error) || 'listPatches failed');
    }).catch((e) => setError(String((e && e.message) || e)));
  };
  useEffect(load, []);

  return React.createElement('div', { style: { padding: 8 } },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', marginBottom: 12 } },
      React.createElement('h2', { style: { margin: 0, fontSize: 15, color: 'var(--dsw-text,#e6e6ec)' } }, 'Auto-Diff Review'),
      React.createElement('button', { onClick: load, style: { marginLeft: 'auto', cursor: 'pointer' } }, 'Refresh')),
    error && React.createElement('div', { style: { color: '#cf222e', marginBottom: 8 } }, error),
    !patches && !error && React.createElement('div', { style: { color: 'var(--dsw-text-muted,#8b8b9e)' } }, 'Scanning sessions\u2026'),
    patches && patches.length === 0 && React.createElement('div', { style: { color: 'var(--dsw-text-muted,#8b8b9e)' } },
      'No auto-diff.patch files found under $DSH_HOME/sessions.'),
    patches && patches.length > 0 && React.createElement('div', { style: { display: 'flex', gap: 12 } },
      React.createElement('div', { style: { width: 320, flexShrink: 0, overflow: 'auto', maxHeight: 520 } },
        React.createElement(SessionList, { patches: patches, selected: selected, onSelect: setSelected })),
      React.createElement('div', { style: { flex: 1, overflow: 'auto', maxHeight: 520, borderLeft: '1px solid var(--dsw-border,#2a2a36)', paddingLeft: 12 } },
        selected ? React.createElement(DiffViewer, { patch: selected }) :
          React.createElement('div', { style: { color: 'var(--dsw-text-muted,#8b8b9e)' } }, 'Select a session to view its per-file diff.'))));
}

return {
  name: 'auto-diff-review-ui',
  inject: ['slots'],
  apply(ctx) {
    // The review panel, as its own Settings section page (a nav item labelled
    // "Auto-Diff Review" appears in the Settings sidebar). Avoids shadowing the
    // shipped single-seat settings.trigger / sidebar.settings slots.
    ctx.slots.inject('settings.section', () =>
      ctx.slots.register({
        name: 'settings.section',
        id: 'auto-diff-review',
        order: 900,
        label: 'Auto-Diff Review',
      }, () => React.createElement(ReviewPanel)));
  },
};