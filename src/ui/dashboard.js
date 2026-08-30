'use strict';

const {
  style,
  stripAnsi,
  visibleLength,
  getTerminalWidth,
  padRight,
  padLeft,
  truncate,
  BOX,
} = require('./core.js');
const { renderLogo } = require('./logo.js');

/**
 * Build menu items reframed around user questions.
 */
function buildDashboardMenu({ repoPath = process.cwd(), metrics = {}, overview = null } = {}) {
  const topHotspot = overview?.topHotspots?.[0];
  const atRiskCount = overview?.busFactorAlerts?.atRiskCount ?? 0;
  const criticalCount = overview?.criticalFiles?.length ?? 0;

  const items = [
    {
      id: 'overview',
      label: 'Repository Health',
      question: 'What is the overall health & risk score?',
      description: 'High-level risk diagnosis, contributors, and key findings',
      accent: 'cyan',
      preview: [
        `Risk Status:    ${overview?.overallRisk ? style(overview.overallRisk === 'CRITICAL' ? 'red' : 'yellow', `${overview.overallRisk} (${overview.riskScore}/100)`) : '—'}`,
        `Contributors:   ${String(metrics.contributors ?? '—')} active authors`,
        `Tracked Files:  ${String(metrics.files ?? '—')} files across repository`,
      ],
    },
    {
      id: 'hotspots',
      label: 'Where Is The Risk?',
      question: 'Which files combine churn, dominance & recency risk?',
      description: 'Ranked hotspots and fragile files needing attention',
      accent: 'red',
      preview: [
        `Critical Files: ${style('bold', style(criticalCount > 0 ? 'red' : 'green', `${criticalCount} critical`))}`,
        `Top Threat:     ${topHotspot ? truncate(topHotspot.file, 28) : 'None'}`,
        `Primary Reason: ${topHotspot ? truncate(topHotspot.primaryRisk, 28) : 'Balanced'}`,
      ],
    },
    {
      id: 'bus-factor',
      label: 'Who Owns The Knowledge?',
      question: 'Where is knowledge concentrated in single authors?',
      description: 'Single-author bottlenecks and Bus Factor = 1 alerts',
      accent: 'yellow',
      preview: [
        `Bus Factor = 1: ${style('bold', style(atRiskCount > 0 ? 'red' : 'green', `${atRiskCount} files at risk`))}`,
        `Top Author:     ${overview?.knowledgeConcentration?.topCommitter || '—'}`,
        `Avg Dominance:  ${overview?.knowledgeConcentration?.avgMaxOwnership ? `${overview.knowledgeConcentration.avgMaxOwnership}%` : '—'}`,
      ],
    },
    {
      id: 'ownership',
      label: 'Authorship Distribution',
      question: 'How is code ownership distributed across authors?',
      description: 'Per-file author breakdown and contributor counts',
      accent: 'green',
      preview: [
        `Contributors:   ${String(metrics.contributors ?? '—')} active authors`,
        `Tracked Files:  ${String(metrics.files ?? '—')} files mapped`,
        `Metric:         Dominant author & edit percentage`,
      ],
    },
    {
      id: 'churn',
      label: 'What Changes Most?',
      question: 'Which files undergo frequent code modifications?',
      description: 'Change frequency rankings and volatility analysis',
      accent: 'cyan',
      preview: [
        `Total Commits:  ${String(metrics.commits ?? '—')}`,
        `Tracked Files:  ${String(metrics.files ?? '—')}`,
        `Activity:       Ranked by revision frequency`,
      ],
    },
    {
      id: 'complexity',
      label: 'What Is Most Complex?',
      question: 'Which source files have highest branching & nesting?',
      description: 'Cyclomatic branches, max depth, and code risk',
      accent: 'magenta',
      preview: [
        `Language AST:   JavaScript / TypeScript`,
        `Evaluates:      Branch density & nesting depth`,
        `Action:         Locates refactoring targets`,
      ],
    },
    {
      id: 'log',
      label: 'Repository History',
      question: 'What is the full reconstructed commit history?',
      description: 'Chronological commit graph and authorship trail',
      accent: 'white',
      preview: [
        `Total Commits:  ${String(metrics.commits ?? '—')}`,
        `Engine Mode:    Zero-dependency direct reader`,
        `Status:         ${metrics.status ?? 'Live'}`,
      ],
    },
  ];

  return items.map((item, index) => ({
    ...item,
    index,
    repoPath,
  }));
}

/**
 * Render the interactive dashboard menu with structured question framing.
 */
function renderDashboardMenu({ repoPath = process.cwd(), items = [], selectedIndex = 0, overview = null } = {}) {
  const selected = items[selectedIndex] || items[0] || {};
  const termWidth = getTerminalWidth(80);
  const width = Math.min(termWidth - 2, 96);
  const navWidth = Math.min(42, Math.floor(width * 0.44));
  const detailWidth = width - navWidth - 7;

  const b = BOX.rounded;

  const title = style('bold', style('green', 'GIT X-RAY')) + ' ' + style('dim', '· Codebase Intelligence Dashboard');
  const repoText = style('dim', 'repo: ') + style('bold', repoPath || process.cwd());

  const navRows = items.map((item, index) => {
    const active = index === selectedIndex;
    const marker = active ? style('bold', style(item.accent || 'cyan', '▶')) : ' ';
    const labelText = active
      ? style('bold', style(item.accent || 'cyan', item.label))
      : style('dim', item.label);
    const row = `${marker} ${labelText}`;
    return padRight(truncate(row, navWidth), navWidth);
  });

  const detailLines = [
    style('bold', style(selected.accent || 'cyan', selected.label)),
    style('bold', style('dim', `"${selected.question}"`)),
    style('dim', selected.description),
    '',
    ...(selected.preview || []),
    '',
    style('cyan', '▶ Press [Enter] to inspect this analysis'),
  ];

  const maxRows = Math.max(navRows.length, detailLines.length);

  const top = style('cyan', `${b.tl}${b.h.repeat(navWidth + 2)}${b.ht}${b.h.repeat(detailWidth + 2)}${b.tr}`);
  const divider = style('cyan', `${b.vl}${b.h.repeat(navWidth + 2)}${b.x}${b.h.repeat(detailWidth + 2)}${b.vr}`);
  const bottom = style('cyan', `${b.bl}${b.h.repeat(navWidth + 2)}${b.hb}${b.h.repeat(detailWidth + 2)}${b.br}`);

  const headerRows = [
    style('cyan', b.v) + ` ${padRight(title, width - 4)} ` + style('cyan', b.v),
    style('cyan', b.v) + ` ${padRight(repoText, width - 4)} ` + style('cyan', b.v),
  ];

  const contentRows = [];
  for (let i = 0; i < maxRows; i += 1) {
    const leftText = navRows[i] || padRight('', navWidth);
    const rightText = padRight(truncate(detailLines[i] || '', detailWidth), detailWidth);
    contentRows.push(
      style('cyan', b.v) + ` ${leftText} ` + style('cyan', b.v) + ` ${rightText} ` + style('cyan', b.v)
    );
  }

  const footer = style('cyan', b.v) + ` ${padRight(style('bold', 'Navigation: [↑ / ↓] Select Question  •  [Enter] Inspect  •  [q] Quit'), width - 4)} ` + style('cyan', b.v);

  return [
    renderLogo({ showSubtitle: false }),
    '',
    top,
    ...headerRows,
    divider,
    ...contentRows,
    divider,
    footer,
    bottom,
  ].join('\n');
}

/**
 * Run interactive keyboard navigation loop.
 */
function runInteractiveDashboard({ repoPath, commits, packedCount, diffs, options, overview, onSelect }) {
  if (!process.stdout.isTTY) {
    console.log(renderDashboardMenu({
      repoPath,
      items: buildDashboardMenu({
        repoPath,
        metrics: {
          commits: commits.length,
          files: diffs ? diffs.size : '—',
          contributors: overview?.contributorCount ?? '—',
          status: packedCount > 0 ? 'Partial' : 'Live'
        },
        overview,
      }),
      selectedIndex: 0,
      overview,
    }));
    console.log(style('dim', '\nNon-interactive terminal detected; use direct commands (e.g., gitxray . overview or gitxray . hotspots).'));
    return;
  }

  const items = buildDashboardMenu({
    repoPath,
    metrics: {
      commits: commits.length,
      files: diffs ? diffs.size : '—',
      contributors: overview?.contributorCount ?? '—',
      status: packedCount > 0 ? 'Partial' : 'Live'
    },
    overview,
  });

  let selectedIndex = 0;
  let inSubView = false;

  const renderMenu = () => {
    inSubView = false;
    process.stdout.write('\u001b[2J\u001b[0;0H');
    console.log(renderDashboardMenu({ repoPath, items, selectedIndex, overview }));
  };

  renderMenu();

  const stdin = process.stdin;
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const onKey = (key) => {
    if (key === '\u0003' || key.toLowerCase() === 'q') {
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write('\u001b[2J\u001b[0;0H');
      process.exit(0);
    }

    if (inSubView) {
      // Any key returns to the interactive menu
      renderMenu();
      return;
    }

    if (key === '\u001b[A' || key === 'k') {
      selectedIndex = (selectedIndex - 1 + items.length) % items.length;
      renderMenu();
    } else if (key === '\u001b[B' || key === 'j') {
      selectedIndex = (selectedIndex + 1) % items.length;
      renderMenu();
    } else if (key === '\r' || key === '\n' || key === ' ') {
      const selected = items[selectedIndex];
      process.stdout.write('\u001b[2J\u001b[0;0H');
      if (typeof onSelect === 'function') {
        inSubView = true;
        onSelect(selected.id);
        console.log(style('dim', '\n─── Press any key to return to dashboard menu (or [q] to exit) ───'));
      }
    }
  };

  stdin.on('data', onKey);
}

module.exports = {
  buildDashboardMenu,
  renderDashboardMenu,
  runInteractiveDashboard,
};
