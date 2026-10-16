'use strict';

const {
  style,
  padRight,
  padLeft,
  renderBar,
  getTerminalWidth,
} = require('../ui/core.js');
const { renderPanel } = require('../ui/components.js');

/**
 * Render a detailed, comprehensive forensic deep-dive view for a single file.
 * Clearly separates measured Git history facts from heuristic risk assessments.
 *
 * @param {Object} params
 * @param {string} params.file - file path
 * @param {Object} [params.hotspot] - heuristic hotspot info { riskScore, severity, primaryRisk, churn, ownershipConcentration, recency }
 * @param {Object} [params.ownership] - measured ownership info { primaryAuthor, authors, distinctAuthors, lastTouched }
 * @param {Object} [params.complexity] - structural AST info { score, complexity, branches, maxDepth, functions, language }
 * @param {Object} [params.churn] - measured churn info { touches }
 * @returns {string}
 */
function renderFileDetail({ file, hotspot, ownership, complexity, churn }) {
  const lines = [];
  const termWidth = getTerminalWidth(80);

  // Header Title
  const riskScore = hotspot?.riskScore ?? 0;
  const severity = hotspot?.severity ?? 'LOW';
  const sevColor = severity === 'CRITICAL' ? 'red' : severity === 'HIGH' ? 'yellow' : severity === 'MEDIUM' ? 'cyan' : 'green';

  lines.push(`${style('bold', style('cyan', 'File Risk Deep Dive'))}  ${style('bold', style(sevColor, `[ ${severity} RISK · ${riskScore}/100 ]`))}`);
  lines.push(`${style('dim', 'path:')} ${style('bold', file)}`);
  lines.push('');

  // 1. Heuristic Risk Assessment
  lines.push(style('bold', style('yellow', '⚡ Why is this file considered risky? (Heuristic Assessment)')));
  const reasons = [];
  const touchCount = churn?.touches ?? hotspot?.churn ?? (ownership?.authors ? (Array.isArray(ownership.authors) ? ownership.authors.reduce((s, a) => s + (a.commits || a.contribution || 0), 0) : null) : null);

  if (touchCount && touchCount >= 3) {
    reasons.push(`• ${style('bold', 'High Change Frequency')}: Modified ${touchCount} times across recent history.`);
  }
  const topPct = ownership?.primaryAuthor?.percentage ?? hotspot?.ownershipConcentration;
  if (topPct && topPct >= 80) {
    const author = ownership?.primaryAuthor?.name || hotspot?.topAuthor?.[0] || 'Top Author';
    reasons.push(`• ${style('bold', 'Knowledge Concentration (Bus Factor = 1)')}: ${Math.round(topPct)}% written by ${author}. High single-person dependency.`);
  }
  if (complexity && (complexity.complexity === 'VERY HIGH' || complexity.complexity === 'HIGH')) {
    reasons.push(`• ${style('bold', 'Structural Complexity')}: ${complexity.branches} branching decision points (Max Nesting Depth: ${complexity.maxDepth}).`);
  }
  if (hotspot?.primaryRisk && reasons.length === 0) {
    reasons.push(`• ${style('bold', 'Primary Signal')}: ${hotspot.primaryRisk}`);
  }
  if (reasons.length === 0) {
    reasons.push('• Balanced risk profile with shared authorship and manageable complexity.');
  }
  lines.push(reasons.join('\n'));
  lines.push('');

  // 2. Measured Authorship & Contributor Distribution
  lines.push(style('bold', style('cyan', '👤 Knowledge Ownership & Contributor Distribution (Measured Facts)')));

  // Normalize author list whether provided as an Array or an Object map
  let authorList = [];
  if (Array.isArray(ownership?.authors)) {
    authorList = ownership.authors.map((a) => ({
      name: a.name || 'Unknown',
      count: typeof a.commits === 'number' ? a.commits : (a.contribution || 0),
    }));
  } else if (ownership?.authors && typeof ownership.authors === 'object') {
    authorList = Object.entries(ownership.authors).map(([name, count]) => ({
      name,
      count: Number(count) || 0,
    }));
  }

  if (authorList.length > 0) {
    authorList.sort((a, b) => b.count - a.count);
    const totalTouches = authorList.reduce((sum, a) => sum + a.count, 0);

    const nameColWidth = termWidth < 70 ? 14 : 22;
    const barColWidth = termWidth < 70 ? 10 : 16;

    for (const author of authorList) {
      const pct = totalTouches > 0 ? Math.round((author.count / totalTouches) * 100) : 0;
      const bar = renderBar(pct, barColWidth);
      lines.push(`  ${padRight(author.name, nameColWidth)} ${padLeft(pct + '%', 4)}  ${bar}  ${style('dim', `(${author.count} edit${author.count === 1 ? '' : 's'})`)}`);
    }
    lines.push(`  ${style('dim', 'Metric: Commit touches across Git history (edit frequency)')}`);
  } else if (ownership?.primaryAuthor) {
    lines.push(`  Primary Author: ${style('bold', ownership.primaryAuthor.name)} (${Math.round(ownership.primaryAuthor.percentage)}%)`);
  } else {
    lines.push(`  ${style('dim', 'Ownership details not available.')}`);
  }
  lines.push('');

  // 3. Measured Git Activity & Structural Metrics
  lines.push(style('bold', style('cyan', '📊 Activity & Structural Metrics (Measured Facts)')));
  const displayTouches = touchCount !== null && touchCount !== undefined ? touchCount : '—';
  lines.push(`  • Revision Count:        ${style('bold', String(displayTouches))} commits touched this file`);
  if (ownership?.lastTouched) {
    const lastDate = new Date(ownership.lastTouched * 1000).toISOString().slice(0, 10);
    lines.push(`  • Last Active:           ${style('bold', lastDate)}`);
  }
  if (complexity) {
    const compColor = complexity.complexity === 'VERY HIGH' ? 'red' : complexity.complexity === 'HIGH' ? 'yellow' : 'green';
    lines.push(`  • Complexity Score:      ${style('bold', style(compColor, `${complexity.score}/100 (${complexity.complexity})`))}`);
    lines.push(`  • Code Structure:        ${complexity.branches} branches · ${complexity.maxDepth} nesting levels · ${complexity.functions} functions (${complexity.language})`);
  }
  lines.push('');

  // 4. Actionable Recommendation & Contextual Qualification
  lines.push(style('bold', style('cyan', '💡 Recommended Interpretation & Next Steps')));
  if (severity === 'CRITICAL' || severity === 'HIGH') {
    lines.push(`  ${style('yellow', '→')} Pair on upcoming modifications or conduct an architecture review.`);
    lines.push(`  ${style('yellow', '→')} Transfer domain knowledge to secondary team members to eliminate the single-author bottleneck.`);
  } else {
    lines.push(`  ${style('green', '→')} File risk is within healthy engineering tolerances.`);
  }
  lines.push(`  ${style('dim', 'Note: Git history touch concentration does not necessarily imply an organizational failure without team context.')}`);

  return renderPanel({
    lines,
    borderColor: sevColor,
  });
}

module.exports = {
  renderFileDetail,
};
