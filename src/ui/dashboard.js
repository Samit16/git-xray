'use strict';

const { style } = require('../outputs/terminal.js');

function buildDashboardMenu({ repoPath = process.cwd(), metrics = {} } = {}) {
  const items = [
    {
      id: 'log',
      label: 'Commit Log',
      description: 'Review recent commits and authorship trail',
      accent: 'cyan',
    },
    {
      id: 'ownership',
      label: 'Ownership',
      description: 'See per-file author concentration and recent hotspots',
      accent: 'green',
    },
    {
      id: 'churn',
      label: 'Churn',
      description: 'Find files with the most edit activity over time',
      accent: 'yellow',
    },
    {
      id: 'bus-factor',
      label: 'Bus Factor',
      description: 'Highlight files dominated by a single author',
      accent: 'red',
    },
  ];

  return items.map((item, index) => ({
    ...item,
    index,
    repoPath,
    summary: {
      commits: metrics.commits ?? '—',
      files: metrics.files ?? '—',
      status: metrics.status ?? 'Live',
    },
  }));
}

function renderDashboardMenu({ repoPath = process.cwd(), items = [], selectedIndex = 0 } = {}) {
  const selected = items[selectedIndex] || items[0] || {};
  const width = 100;
  const navWidth = 42;
  const detailWidth = width - navWidth - 8;

  const visibleWidth = (text) => String(text).replace(/\u001b\[[0-9;]*m/g, '').length;
  const clamp = (text, max) => {
    const str = String(text);
    if (visibleWidth(str) <= max) return str;
    let trimmed = str;
    while (visibleWidth(trimmed) > max) {
      trimmed = trimmed.slice(0, -1);
    }
    return trimmed;
  };

  const title = style('bold', style('cyan', 'Git X-Ray'));
  const repoText = style('dim', repoPath || process.cwd());
  const statusBadge = style('green', ' LIVE ');

  const navRows = items.map((item, index) => {
    const active = index === selectedIndex;
    const marker = active ? '▶' : ' ';
    const label = active ? style('bold', style(item.accent || 'cyan', item.label)) : item.label;
    const meta = style('dim', item.description);
    const row = `${marker} ${label}  ${meta}`;
    return clamp(row, navWidth);
  });

  const detailLines = [
    clamp(style('bold', style(selected.accent || 'cyan', selected.label || 'Overview')), detailWidth),
    clamp(style('dim', selected.description || 'Open a module to inspect results.'), detailWidth),
    '',
    clamp(`Repo: ${style('bold', repoText)}`, detailWidth),
    clamp(`Commits: ${style('bold', String(selected.summary?.commits ?? '—'))}`, detailWidth),
    clamp(`Files: ${style('bold', String(selected.summary?.files ?? '—'))}`, detailWidth),
    clamp(`Status: ${statusBadge}`, detailWidth),
  ];

  const maxRows = Math.max(navRows.length, detailLines.length);
  const top = `╭${'─'.repeat(navWidth + 2)}┬${'─'.repeat(detailWidth + 2)}╮`;
  const divider = `├${'─'.repeat(navWidth + 2)}┼${'─'.repeat(detailWidth + 2)}┤`;
  const bottom = `╰${'─'.repeat(navWidth + 2)}┴${'─'.repeat(detailWidth + 2)}╯`;

  const rows = [
    top,
    `│ ${padRight(title, width - 4)} │`,
    `│ ${padRight(repoText, width - 4)} │`,
    `│ ${padRight(style('bold', 'Analysis dashboard'), width - 4)} │`,
    divider,
  ];

  for (let i = 0; i < maxRows; i += 1) {
    const leftText = navRows[i] || '';
    const rightText = detailLines[i] || '';
    rows.push(`│ ${padRight(leftText, navWidth)} │ ${padRight(rightText, detailWidth)} │`);
  }

  rows.push(divider);
  rows.push(`│ ${padRight(style('bold', 'Keys: ↑ ↓ move • Enter run • q quit'), width - 4)} │`);
  rows.push(bottom);
  return rows.join('\n');
}

function runInteractiveDashboard({ repoPath, commits, packedCount, diffs, options, onSelect }) {
  if (!process.stdout.isTTY) {
    console.log(renderDashboardMenu({
      repoPath,
      items: buildDashboardMenu({ repoPath, metrics: { commits: commits.length, files: diffs ? diffs.size : '—', status: packedCount > 0 ? 'Partial' : 'Live' } }),
      selectedIndex: 0,
    }));
    console.log(style('dim', 'Non-interactive terminal detected; use a direct command such as gitxray . log or gitxray . ownership.'));
    return;
  }

  const items = buildDashboardMenu({
    repoPath,
    metrics: { commits: commits.length, files: diffs ? diffs.size : '—', status: packedCount > 0 ? 'Partial' : 'Live' },
  });

  let selectedIndex = 0;
  const render = () => {
    console.clear();
    console.log(renderDashboardMenu({ repoPath, items, selectedIndex }));
  };

  render();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const onKey = (key) => {
    if (key === '\u0003' || key.toLowerCase() === 'q') {
      stdin.setRawMode(false);
      stdin.pause();
      console.clear();
      process.exit(0);
    }

    if (key === '\u001b[A') {
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      render();
    }

    if (key === '\u001b[B') {
      selectedIndex = (selectedIndex + 1) % items.length;
      render();
    }

    if (key === '\r' || key === '\n') {
      stdin.setRawMode(false);
      stdin.pause();
      const selected = items[selectedIndex];
      console.clear();
      if (typeof onSelect === 'function') {
        onSelect(selected.id);
      }
    }
  };

  stdin.on('data', onKey);
}

function padRight(str, width) {
  const output = String(str);
  const visible = output.replace(/\u001b\[[0-9;]*m/g, '').length;
  return visible >= width ? output : output + ' '.repeat(width - visible);
}

module.exports = {
  buildDashboardMenu,
  renderDashboardMenu,
  runInteractiveDashboard,
};
