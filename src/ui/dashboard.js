'use strict';

const path = require('node:path');
const fs = require('node:fs');
const {
  style,
  visibleLength,
  getTerminalWidth,
  padRight,
  padLeft,
  truncate,
  BOX,
  renderBar,
} = require('./core.js');
const { renderLogo } = require('./logo.js');
const {
  computeOwnership,
  buildFileFolderList,
  computeContributorBreakdown,
  normalizePath,
} = require('../analytics/ownership.js');
const { renderFileDetail } = require('../outputs/file-detail.js');
const { analyzeComplexity } = require('../analytics/complexity.js');

/**
 * Build menu items reframed around user questions and Cyber Cyan navigation.
 */
function buildDashboardMenu({ repoPath = process.cwd(), metrics = {}, overview = null } = {}) {
  const topHotspot = overview?.topHotspots?.[0];
  const atRiskCount = overview?.busFactorAlerts?.atRiskCount ?? 0;
  const criticalCount = overview?.criticalFiles?.length ?? 0;

  const items = [
    {
      id: 'overview',
      label: 'Repository Overview',
      question: 'What is the overall health & risk score?',
      description: 'Repository health, risk score, and diagnosis',
      accent: 'cyan',
      preview: [
        `Risk Status:    ${overview?.overallRisk ? style(overview.overallRisk === 'CRITICAL' ? 'red' : 'yellow', `${overview.overallRisk} (${overview.riskScore}/100)`) : '—'}`,
        `Contributors:   ${String(metrics.contributors ?? '—')} active authors`,
        `Tracked Files:  ${String(metrics.files ?? '—')} files across repository`,
      ],
    },
    {
      id: 'ownership',
      label: 'Ownership',
      question: 'How is code ownership distributed across authors?',
      description: 'Contributor distribution and file/folder explorer',
      accent: 'cyan',
      preview: [
        `Contributors:   ${String(metrics.contributors ?? '—')} active authors`,
        `Tracked Files:  ${String(metrics.files ?? '—')} files and folders`,
        `Metric:         File & folder contributor breakdown (Ownership)`,
      ],
    },
    {
      id: 'hotspots',
      label: 'Hotspots',
      question: 'Which files combine churn, dominance & recency risk?',
      description: 'Frequently changed files with elevated risk',
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
      id: 'churn',
      label: 'What Changes Most?',
      question: 'Which files undergo frequent code modifications?',
      description: 'Revision frequency and volatility analysis',
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
      description: 'Branch density, nesting depth, and code risk',
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
 * Render the interactive dashboard menu in Cyber Cyan theme.
 */
function renderDashboardMenu({ repoPath = process.cwd(), items = [], selectedIndex = 0, overview = null } = {}) {
  const termWidth = getTerminalWidth(80);
  const width = Math.max(48, Math.min(termWidth - 2, 88));
  const innerWidth = width - 4;
  const b = BOX.rounded;

  const repoName = path.basename(repoPath) || repoPath;
  const branchName = overview?.branch || 'main';

  const titleHeader = ' G I T - X R A Y ';
  const topRem = Math.max(0, width - 2 - visibleLength(titleHeader));
  const topBorder = style('cyan', `${b.tl}${b.h}${titleHeader}${b.h.repeat(Math.max(0, topRem - 1))}${b.tr}`);
  const divider = style('cyan', `${b.vl}${b.h.repeat(width - 2)}${b.vr}`);
  const bottomBorder = style('cyan', `${b.bl}${b.h.repeat(width - 2)}${b.br}`);

  const headerRows = [
    style('cyan', b.v) + ` ${padRight(`${style('bold', style('cyan', 'Git X-Ray'))} ${style('dim', '· Repository Intelligence')}`, innerWidth)} ` + style('cyan', b.v),
    style('cyan', b.v) + ` ${padRight(`${style('bold', repoName)} ${style('dim', '•')} ${style('dim', 'Branch:')} ${style('bold', branchName)}`, innerWidth)} ` + style('cyan', b.v),
  ];

  const contentRows = [
    style('cyan', b.v) + ` ${padRight(style('bold', style('cyan', 'ANALYSIS MODULES')), innerWidth)} ` + style('cyan', b.v),
    style('cyan', b.v) + ` ${padRight('', innerWidth)} ` + style('cyan', b.v),
  ];

  const isNarrow = width < 68;
  const labelColWidth = isNarrow ? 22 : 26;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const active = i === selectedIndex;
    const marker = active ? style('bold', style('cyan', '❯')) : ' ';
    const labelStyled = active ? style('bold', style('cyan', item.label)) : item.label;

    if (isNarrow) {
      const line = `${marker} ${labelStyled}`;
      contentRows.push(style('cyan', b.v) + ` ${padRight(truncate(line, innerWidth), innerWidth)} ` + style('cyan', b.v));
    } else {
      const paddedLabel = padRight(labelStyled, labelColWidth);
      const descStyled = style('dim', item.description);
      const availableForDesc = Math.max(10, innerWidth - labelColWidth - 4);
      const line = `${marker} ${paddedLabel}  ${truncate(descStyled, availableForDesc)}`;
      contentRows.push(style('cyan', b.v) + ` ${padRight(truncate(line, innerWidth), innerWidth)} ` + style('cyan', b.v));
    }
  }

  contentRows.push(style('cyan', b.v) + ` ${padRight('', innerWidth)} ` + style('cyan', b.v));

  const footerText = isNarrow
    ? '↑↓ Navigate  Enter Open  q Quit'
    : '↑↓ Navigate  Enter Open  e Back  q Quit';
  const footerRow = style('cyan', b.v) + ` ${padRight(style('dim', footerText), innerWidth)} ` + style('cyan', b.v);

  return [
    renderLogo({ showSubtitle: false }),
    '',
    topBorder,
    ...headerRows,
    divider,
    ...contentRows,
    divider,
    footerRow,
    bottomBorder,
  ].join('\n');
}

/**
 * Render the file/folder selection list with search filtering and hierarchy indentation.
 *
 * @param {Object} params
 * @param {Array<{ type: 'folder'|'file', path: string }>} params.items
 * @param {number} params.selectedIndex
 * @param {string} [params.repoPath]
 * @param {string} [params.searchQuery]
 * @param {boolean} [params.searchMode]
 * @returns {string}
 */
function renderFileFolderList({
  items = [],
  selectedIndex = 0,
  repoPath = process.cwd(),
  searchQuery = '',
  searchMode = false,
} = {}) {
  const termWidth = getTerminalWidth(80);
  const width = Math.max(48, Math.min(termWidth - 2, 88));
  const innerWidth = width - 4;
  const b = BOX.rounded;

  const repoName = path.basename(repoPath) || repoPath;
  const titleHeader = ' FILE & FOLDER EXPLORER ';
  const topRem = Math.max(0, width - 2 - visibleLength(titleHeader));
  const top = style('cyan', `${b.tl}${b.h}${titleHeader}${b.h.repeat(Math.max(0, topRem - 1))}${b.tr}`);
  const divider = style('cyan', `${b.vl}${b.h.repeat(width - 2)}${b.vr}`);
  const bottom = style('cyan', `${b.bl}${b.h.repeat(width - 2)}${b.br}`);

  const breadcrumbs = `${style('bold', style('cyan', 'Git-XRay'))} ${style('dim', '│')} ${style('bold', style('cyan', 'Individual Contributions'))}`;
  const repoText = `${style('bold', repoName)} ${style('dim', '•')} ${style('dim', 'repo:')} ${style('bold', repoPath || process.cwd())}`;

  const headerRows = [
    style('cyan', b.v) + ` ${padRight(breadcrumbs, innerWidth)} ` + style('cyan', b.v),
    style('cyan', b.v) + ` ${padRight(repoText, innerWidth)} ` + style('cyan', b.v),
  ];

  const contentRows = [];

  if (searchMode) {
    const promptText = `${style('bold', style('yellow', 'Search: '))} ${searchQuery}${style('cyan', '█')} ${style('dim', '(Enter confirm · Esc clear)')}`;
    contentRows.push(style('cyan', b.v) + ` ${padRight(promptText, innerWidth)} ` + style('cyan', b.v));
  } else if (searchQuery) {
    const filterText = `${style('dim', 'Filter:')} ${style('bold', style('yellow', `"${searchQuery}"`))} ${style('dim', `(${items.length} matching) · [/ edit · Esc clear]`)}`;
    contentRows.push(style('cyan', b.v) + ` ${padRight(filterText, innerWidth)} ` + style('cyan', b.v));
  } else {
    const introText = style('dim', 'Select a file or folder to view contributor breakdown (press / to filter):');
    contentRows.push(style('cyan', b.v) + ` ${padRight(introText, innerWidth)} ` + style('cyan', b.v));
  }
  contentRows.push(style('cyan', b.v) + ` ${padRight('', innerWidth)} ` + style('cyan', b.v));

  if (items.length === 0) {
    const emptyMsg = searchQuery
      ? `  No files or folders matching "${searchQuery}" (Esc to clear)`
      : '  (no files or folders found)';
    contentRows.push(
      style('cyan', b.v) + ` ${padRight(style('dim', emptyMsg), innerWidth)} ` + style('cyan', b.v)
    );
  } else {
    const pageSize = Math.min(14, items.length);
    const half = Math.floor(pageSize / 2);
    let startIdx = selectedIndex - half;
    if (startIdx < 0) startIdx = 0;
    if (startIdx + pageSize > items.length) {
      startIdx = Math.max(0, items.length - pageSize);
    }
    const endIdx = Math.min(items.length, startIdx + pageSize);

    for (let i = startIdx; i < endIdx; i++) {
      const item = items[i];
      const active = i === selectedIndex;
      const marker = active ? style('bold', style('cyan', '▶ ')) : '  ';
      const icon = item.type === 'folder' ? '📁 ' : '📄 ';
      const pathSuffix = item.type === 'folder' ? '/' : '';
      const displayPath = `${item.path}${pathSuffix}`;
      const depth = Math.max(0, item.path.split('/').length - 1);
      const indent = '  '.repeat(Math.min(depth, 3));
      const pathStyled = active
        ? style('bold', style('cyan', displayPath))
        : displayPath;
      const tag = style('dim', item.type === 'folder' ? '[folder]' : '[file]');
      const rowText = `${marker}${indent}${icon}${pathStyled} ${tag}`;
      contentRows.push(
        style('cyan', b.v) + ` ${padRight(truncate(rowText, innerWidth), innerWidth)} ` + style('cyan', b.v)
      );
    }

    if (items.length > pageSize) {
      const counter = style('dim', `  [Showing ${startIdx + 1}–${endIdx} of ${items.length} items]`);
      contentRows.push(
        style('cyan', b.v) + ` ${padRight(counter, innerWidth)} ` + style('cyan', b.v)
      );
    }
  }

  const footerText = searchMode
    ? 'Type to filter  •  [Backspace] Delete  •  [Enter] Confirm  •  [Esc] Clear'
    : (width < 75
        ? 'Navigation: [↑ / ↓] Navigate  •  [Enter] Select  •  [e / Esc] Back  •  [q] Quit'
        : 'Navigation: [↑ / ↓] Navigate  •  [Enter] Select  •  [d] File Details  •  [/] Search  •  [e / Esc] Back  •  [q] Quit');

  const footer = style('cyan', b.v) + ` ${padRight(style('dim', footerText), innerWidth)} ` + style('cyan', b.v);

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
 * Render tree-style contributor breakdown for a selected file or folder in Cyber Cyan.
 *
 * @param {Object} params
 * @param {string} params.target - path
 * @param {'folder'|'file'} [params.type]
 * @param {Array<{ name: string, percentage: number, contribution: number }>} params.contributors
 * @param {number} params.totalContribution
 * @param {string} [params.repoPath]
 * @param {string|null} [params.lastTouched]
 * @returns {string}
 */
function renderContributorBreakdown({
  target = '',
  type = 'file',
  contributors = [],
  totalContribution = 0,
  repoPath = process.cwd(),
  lastTouched = null,
} = {}) {
  const termWidth = getTerminalWidth(80);
  const width = Math.max(48, Math.min(termWidth - 2, 88));
  const innerWidth = width - 4;
  const b = BOX.rounded;

  const topBorder = style('cyan', `${b.tl}${b.h} CONTRIBUTOR OWNERSHIP ${b.h.repeat(Math.max(0, width - 25))}${b.tr}`);
  const divider = style('cyan', `${b.vl}${b.h.repeat(width - 2)}${b.vr}`);
  const bottomBorder = style('cyan', `${b.bl}${b.h.repeat(width - 2)}${b.br}`);

  const targetIcon = type === 'folder' ? '📁' : '📄';
  const targetLabel = type === 'folder' ? 'Folder' : 'File';
  const targetSuffix = type === 'folder' ? '/' : '';

  const headerRows = [
    style('cyan', b.v) + ` ${padRight(`${style('dim', `${targetLabel}:`)} ${style('bold', `${targetIcon} ${target}${targetSuffix}`)}`, innerWidth)} ` + style('cyan', b.v),
    style('cyan', b.v) + ` ${padRight(`${style('dim', 'Metric:')} ${style('bold', 'Commit touches across Git history')}`, innerWidth)} ` + style('cyan', b.v),
  ];

  const contentRows = [];

  if (!contributors || contributors.length === 0) {
    const emptyLine = `  ${style('dim', '└── (no contributor data available for this path)')}`;
    contentRows.push(style('cyan', b.v) + ` ${padRight(emptyLine, innerWidth)} ` + style('cyan', b.v));
  } else {
    const isNarrow = width < 70;
    const nameWidth = isNarrow ? 14 : 20;
    const barWidth = isNarrow ? 10 : 16;

    for (let i = 0; i < contributors.length; i++) {
      const c = contributors[i];
      const isLast = i === contributors.length - 1;
      const isLeading = i === 0;
      const branch = isLast ? '└── ' : '├── ';
      const rank = String(i + 1).padStart(2, '0');
      const pctValue = typeof c.percentage === 'number' ? c.percentage : 0;
      const pctStr = `${pctValue.toFixed(1)}%`;
      const bar = renderBar(pctValue, barWidth);
      const commitCount = c.contribution ?? c.commits ?? 0;
      const countStr = isNarrow
        ? style('dim', `(${commitCount})`)
        : style('dim', `${commitCount} touch${commitCount === 1 ? '' : 'es'}`);

      const authorName = isLeading ? style('bold', c.name) : c.name;
      // ├── 01 Member A  ███████████████ 60.0%  120 touches
      const lineText = `  ${style('cyan', branch)}${style('dim', rank)} ${padRight(authorName, nameWidth)} ${bar} ${padLeft(pctStr, 6)}  ${countStr}`;
      contentRows.push(
        style('cyan', b.v) + ` ${padRight(truncate(lineText, innerWidth), innerWidth)} ` + style('cyan', b.v)
      );
    }
  }

  contentRows.push(style('cyan', b.v) + ` ${padRight('', innerWidth)} ` + style('cyan', b.v));
  const totalCount = contributors ? contributors.length : 0;
  const leadingName = contributors && contributors[0]
    ? `${contributors[0].name} (${contributors[0].percentage.toFixed(1)}%)`
    : 'None';

  const summaryLine = `Total contributors: ${style('bold', String(totalCount))} ${style('dim', '•')} Leading contributor: ${style('bold', leadingName)}`;
  contentRows.push(
    style('cyan', b.v) + ` ${padRight(truncate(summaryLine, innerWidth), innerWidth)} ` + style('cyan', b.v)
  );
  contentRows.push(
    style('cyan', b.v) + ` ${padRight(`Activity: ${style('bold', `${totalContribution} commit touch${totalContribution === 1 ? '' : 'es'}`)}`, innerWidth)} ` + style('cyan', b.v)
  );
  contentRows.push(
    style('cyan', b.v) + ` ${padRight(style('dim', 'Metric: Commit touches across Git history (edit frequency)'), innerWidth)} ` + style('cyan', b.v)
  );

  if (lastTouched) {
    contentRows.push(
      style('cyan', b.v) + ` ${padRight(`${style('dim', 'Last active:')} ${style('bold', lastTouched)}`, innerWidth)} ` + style('cyan', b.v)
    );
  }

  const footerText = type === 'file'
    ? 'Navigation: [d] File Details  •  [e / Esc] Back to File/Folder List  •  [q] Quit'
    : 'Navigation: [e / Esc] Back to File/Folder List  •  [q] Quit';
  const footerRow = style('cyan', b.v) + ` ${padRight(style('dim', footerText), innerWidth)} ` + style('cyan', b.v);

  return [
    renderLogo({ showSubtitle: false }),
    '',
    topBorder,
    ...headerRows,
    divider,
    ...contentRows,
    divider,
    footerRow,
    bottomBorder,
  ].join('\n');
}

/**
 * Controller/state machine for 3-state interactive dashboard navigation:
 * State 1: 'menu' (Main options menu)
 * State 2: 'file_list' (File/folder selection list with search filtering)
 * State 3: 'contributor_view' (Tree-style contributor breakdown)
 * State 4: 'subview' (Other dashboard views like overview, hotspots, etc.)
 */
class DashboardNavigator {
  constructor({
    repoPath = process.cwd(),
    commits = [],
    diffs = null,
    packedCount = 0,
    options = {},
    overview = null,
    ownershipData = null,
    onSelect = null,
    output = process.stdout,
  } = {}) {
    this.repoPath = repoPath;
    this.commits = commits;
    this.diffs = diffs;
    this.packedCount = packedCount;
    this.options = options;
    this.overview = overview;
    this.onSelect = onSelect;
    this.output = output;

    this.ownershipData =
      ownershipData ||
      (commits && commits.length > 0 && diffs ? computeOwnership(commits, diffs) : []);

    this.menuItems = buildDashboardMenu({
      repoPath,
      metrics: {
        commits: commits.length,
        files: diffs ? diffs.size : this.ownershipData.length,
        contributors: overview?.contributorCount ?? '—',
        status: packedCount > 0 ? 'Partial' : 'Live',
      },
      overview,
    });
    this.menuSelectedIndex = 0;

    this.fileList = buildFileFolderList(this.ownershipData);
    this.fileSelectedIndex = 0;
    this.searchQuery = '';
    this.searchMode = false;

    this.state = 'menu';
    this.selectedTarget = null;
    this.detailSourceState = 'file_list';
  }

  getFilteredFileList() {
    if (!this.searchQuery) return this.fileList;
    const q = this.searchQuery.toLowerCase();
    return this.fileList.filter(
      (item) => item.path.toLowerCase().includes(q) || item.name.toLowerCase().includes(q)
    );
  }

  handleKey(key) {
    if (!key) return { action: 'noop', state: this.state };

    if (key === '\u0003' || (!this.searchMode && key.toLowerCase() === 'q')) {
      return { action: 'exit' };
    }

    switch (this.state) {
      case 'menu': {
        if (key === '\u001b[A' || key === 'k') {
          this.menuSelectedIndex =
            (this.menuSelectedIndex - 1 + this.menuItems.length) % this.menuItems.length;
          return { action: 'render', state: this.state };
        }
        if (key === '\u001b[B' || key === 'j') {
          this.menuSelectedIndex = (this.menuSelectedIndex + 1) % this.menuItems.length;
          return { action: 'render', state: this.state };
        }
        if (key === '\r' || key === '\n' || key === ' ') {
          const selected = this.menuItems[this.menuSelectedIndex];
          if (selected.id === 'ownership' || selected.id === 'contribution') {
            this.state = 'file_list';
            this.fileList = buildFileFolderList(this.ownershipData);
            this.searchQuery = '';
            this.searchMode = false;
            if (this.fileSelectedIndex >= this.fileList.length) {
              this.fileSelectedIndex = 0;
            }
            return { action: 'render', state: this.state };
          }
          this.state = 'subview';
          return { action: 'subview', selectedId: selected.id };
        }
        break;
      }

      case 'file_list': {
        const filtered = this.getFilteredFileList();

        if (this.searchMode) {
          // Esc cancels search input and clears query
          if (key === '\u001b') {
            this.searchMode = false;
            this.searchQuery = '';
            this.fileSelectedIndex = 0;
            return { action: 'render', state: this.state };
          }
          // Enter confirms current query and returns to navigation
          if (key === '\r' || key === '\n') {
            this.searchMode = false;
            return { action: 'render', state: this.state };
          }
          // Backspace / Delete
          if (key === '\u0008' || key === '\u007f') {
            this.searchQuery = this.searchQuery.slice(0, -1);
            this.fileSelectedIndex = 0;
            return { action: 'render', state: this.state };
          }
          // Printable characters
          if (key.length === 1 && key >= ' ' && key <= '~') {
            this.searchQuery += key;
            this.fileSelectedIndex = 0;
            return { action: 'render', state: this.state };
          }
          return { action: 'noop', state: this.state };
        }

        // Arrow navigation
        if (key === '\u001b[A' || key === 'k') {
          if (filtered.length > 0) {
            this.fileSelectedIndex =
              (this.fileSelectedIndex - 1 + filtered.length) % filtered.length;
          }
          return { action: 'render', state: this.state };
        }
        if (key === '\u001b[B' || key === 'j') {
          if (filtered.length > 0) {
            this.fileSelectedIndex = (this.fileSelectedIndex + 1) % filtered.length;
          }
          return { action: 'render', state: this.state };
        }
        if (key === '/') {
          this.searchMode = true;
          return { action: 'render', state: this.state };
        }
        if (key === '\r' || key === '\n') {
          if (filtered.length > 0) {
            this.selectedTarget = filtered[this.fileSelectedIndex];
            this.state = 'contributor_view';
          }
          return { action: 'render', state: this.state };
        }
        if (!this.searchMode && key.toLowerCase() === 'd') {
          if (filtered.length > 0) {
            const item = filtered[this.fileSelectedIndex];
            if (item.type === 'file') {
              this.selectedTarget = item;
              this.detailSourceState = 'file_list';
              this.state = 'file_detail';
              return { action: 'render', state: this.state };
            }
          }
        }
        if (key.toLowerCase() === 'e') {
          this.searchQuery = '';
          this.searchMode = false;
          this.state = 'menu';
          return { action: 'render', state: this.state };
        }
        if (key === '\u001b') {
          if (this.searchQuery) {
            this.searchQuery = '';
            this.fileSelectedIndex = 0;
            return { action: 'render', state: this.state };
          }
          this.state = 'menu';
          return { action: 'render', state: this.state };
        }
        break;
      }

      case 'contributor_view': {
        if (key.toLowerCase() === 'd') {
          const target = this.selectedTarget || this.fileList[this.fileSelectedIndex];
          if (target && target.type === 'file') {
            this.detailSourceState = 'contributor_view';
            this.state = 'file_detail';
            return { action: 'render', state: this.state };
          }
        }
        if (key.toLowerCase() === 'e' || key === '\u001b') {
          this.state = 'file_list';
          return { action: 'render', state: this.state };
        }
        break;
      }

      case 'file_detail': {
        if (key.toLowerCase() === 'e' || key === '\u001b') {
          this.state = this.detailSourceState || 'file_list';
          return { action: 'render', state: this.state };
        }
        break;
      }

      case 'subview': {
        this.state = 'menu';
        return { action: 'render', state: this.state };
      }
    }

    return { action: 'noop', state: this.state };
  }

  getCurrentView() {
    switch (this.state) {
      case 'menu':
        return renderDashboardMenu({
          repoPath: this.repoPath,
          items: this.menuItems,
          selectedIndex: this.menuSelectedIndex,
          overview: this.overview,
        });
      case 'file_list': {
        const filtered = this.getFilteredFileList();
        return renderFileFolderList({
          items: filtered,
          selectedIndex: this.fileSelectedIndex,
          repoPath: this.repoPath,
          searchQuery: this.searchQuery,
          searchMode: this.searchMode,
        });
      }
      case 'contributor_view': {
        const target =
          this.selectedTarget ||
          this.fileList[this.fileSelectedIndex] || { path: '', type: 'file' };
        const breakdown = computeContributorBreakdown(
          target.path,
          this.ownershipData,
          target.type === 'folder'
        );
        return renderContributorBreakdown({
          target: target.path,
          type: target.type,
          contributors: breakdown.contributors,
          totalContribution: breakdown.totalContribution,
          repoPath: this.repoPath,
          lastTouched: breakdown.lastTouched,
        });
      }
      case 'file_detail': {
        const target =
          this.selectedTarget ||
          this.fileList[this.fileSelectedIndex] || { path: '', type: 'file' };
        const normTarget = normalizePath(target.path);
        const ownershipEntry = (this.ownershipData || []).find(
          (e) => normalizePath(e.path) === normTarget
        );
        const hotspotEntry = (this.overview?.topHotspots || []).find(
          (h) => normalizePath(h.file) === normTarget
        );

        let complexityEntry = null;
        try {
          const fullPath = path.resolve(this.repoPath, target.path);
          if (fs.existsSync(fullPath) && fs.statSync(fullPath).isFile()) {
            complexityEntry = analyzeComplexity(fullPath);
          }
        } catch {
          // ignore complexity read errors
        }

        const churnEntry = hotspotEntry ? { touches: hotspotEntry.churn } : null;

        const termWidth = getTerminalWidth(80);
        const width = Math.min(termWidth - 2, 96);
        const b = BOX.rounded;

        const breadcrumbs = `${style('bold', style('green', 'Git-XRay'))} ${style('dim', '│')} ${style('dim', 'Individual Contributions')} ${style('dim', '│')} ${style('bold', style('cyan', target.path))} ${style('dim', '[File Detail]')}`;
        const repoText = `${style('dim', 'repo:')} ${style('bold', this.repoPath || process.cwd())}`;

        const headerRows = [
          style('cyan', b.v) + ` ${padRight(breadcrumbs, width - 4)} ` + style('cyan', b.v),
          style('cyan', b.v) + ` ${padRight(repoText, width - 4)} ` + style('cyan', b.v),
        ];

        const top = style('cyan', `${b.tl}${b.h.repeat(width - 2)}${b.tr}`);
        const divider = style('cyan', `${b.vl}${b.h.repeat(width - 2)}${b.vr}`);
        const bottom = style('cyan', `${b.bl}${b.h.repeat(width - 2)}${b.br}`);

        const footer = style('cyan', b.v) + ` ${padRight(style('bold', 'Navigation: [e / Esc] Back  •  [q] Quit'), width - 4)} ` + style('cyan', b.v);

        const renderedDetail = renderFileDetail({
          file: target.path,
          hotspot: hotspotEntry,
          ownership: ownershipEntry,
          complexity: complexityEntry,
          churn: churnEntry,
        });

        return [
          renderLogo({ showSubtitle: false }),
          '',
          top,
          ...headerRows,
          divider,
          footer,
          bottom,
          '',
          renderedDetail,
        ].join('\n');
      }
      default:
        return '';
    }
  }
}

/**
 * Run interactive keyboard navigation loop supporting 3-state navigation:
 * Main Menu <-> File/Folder List <-> Contributor Breakdown.
 */
function runInteractiveDashboard({
  repoPath,
  commits = [],
  packedCount = 0,
  diffs = null,
  options = {},
  overview = null,
  ownershipData = null,
  onSelect,
  input = process.stdin,
  output = process.stdout,
} = {}) {
  const navigator = new DashboardNavigator({
    repoPath,
    commits,
    packedCount,
    diffs,
    options,
    overview,
    ownershipData,
    onSelect,
    output,
  });

  if (!process.stdout.isTTY || !input.isTTY) {
    output.write(
      renderDashboardMenu({
        repoPath,
        items: navigator.menuItems,
        selectedIndex: 0,
        overview,
      }) + '\n'
    );
    output.write(
      style(
        'dim',
        '\nNon-interactive terminal detected; use direct commands (e.g., gitxray . overview or gitxray . hotspots).\n'
      )
    );
    return navigator;
  }

  const renderCurrent = () => {
    output.write('\u001b[2J\u001b[0;0H');
    output.write(navigator.getCurrentView() + '\n');
  };

  renderCurrent();

  // Listen for terminal resize to dynamically re-render
  if (output && typeof output.on === 'function') {
    output.on('resize', renderCurrent);
  }

  if (typeof input.setRawMode === 'function') {
    input.setRawMode(true);
  }
  input.resume();
  input.setEncoding('utf8');

  const onKey = (key) => {
    const res = navigator.handleKey(key);
    if (res.action === 'exit') {
      if (typeof input.setRawMode === 'function') {
        input.setRawMode(false);
      }
      input.pause();
      if (output && typeof output.removeListener === 'function') {
        output.removeListener('resize', renderCurrent);
      }
      output.write('\u001b[2J\u001b[0;0H');
      process.exit(0);
    } else if (res.action === 'subview') {
      output.write('\u001b[2J\u001b[0;0H');
      if (typeof onSelect === 'function') {
        onSelect(res.selectedId);
        output.write(
          style('dim', '\n─── Press [e / Esc] or any key to return to dashboard menu (or [q] to exit) ───\n')
        );
      }
    } else if (res.action === 'render') {
      renderCurrent();
    }
  };

  input.on('data', onKey);
  return navigator;
}

module.exports = {
  buildDashboardMenu,
  renderDashboardMenu,
  renderFileFolderList,
  renderContributorBreakdown,
  DashboardNavigator,
  runInteractiveDashboard,
};

