'use strict';

const {
  style,
  stripAnsi,
  padRight,
  padLeft,
  renderBar,
  BOX,
  BADGES,
} = require('../ui/core.js');
const { renderPanel, renderSection } = require('../ui/components.js');

/**
 * Render a detailed, comprehensive forensic deep-dive view for a single file.
 *
 * @param {Object} params
 * @param {string} params.file - file path
 * @param {Object} [params.hotspot] - hotspot info { riskScore, severity, primaryRisk, churn, ownershipConcentration, recency }
 * @param {Object} [params.ownership] - ownership info { primaryAuthor, authors, distinctAuthors, lastTouched }
 * @param {Object} [params.complexity] - complexity info { score, complexity, branches, maxDepth, functions, language }
 * @param {Object} [params.churn] - churn info { touches }
 * @returns {string}
 */
function renderFileDetail({ file, hotspot, ownership, complexity, churn }) {
  const lines = [];
  const b = BOX.rounded;

  // Header Title
  const riskScore = hotspot?.riskScore ?? 0;
  let severity = hotspot?.severity ?? 'LOW';
  const sevColor = severity === 'CRITICAL' ? 'red' : severity === 'HIGH' ? 'yellow' : severity === 'MEDIUM' ? 'cyan' : 'green';

  lines.push(`${style('bold', style('cyan', 'File Risk Deep Dive'))}  ${style('bold', style(sevColor, `[ ${severity} RISK · ${riskScore}/100 ]`))}`);
  lines.push(`${style('dim', 'path:')} ${style('bold', file)}`);
  lines.push('');

  // 1. Why is this file risky?
  lines.push(style('bold', style('yellow', '⚡ Why is this file considered risky?')));
  const reasons = [];
  if (hotspot?.churn >= 3 || churn?.touches >= 3) {
    const touches = hotspot?.churn || churn?.touches;
    reasons.push(`• ${style('bold', 'High Change Frequency')}: Modified ${touches} times across recent history.`);
  }
  if (ownership?.primaryAuthor?.percentage >= 80 || (hotspot?.ownershipConcentration && hotspot.ownershipConcentration >= 80)) {
    const author = ownership?.primaryAuthor?.name || 'Top Author';
    const pct = ownership?.primaryAuthor?.percentage ?? hotspot?.ownershipConcentration;
    reasons.push(`• ${style('bold', 'Knowledge Concentration (Bus Factor = 1)')}: ${pct}% written by ${author}. High single-person dependency.`);
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

  // 2. Authorship & Knowledge Ownership
  lines.push(style('bold', style('cyan', '👤 Knowledge Ownership & Contributor Distribution')));
  if (ownership && ownership.authors) {
    const sortedAuthors = Object.entries(ownership.authors)
      .sort((a, b) => b[1] - a[1]);
    const totalTouches = sortedAuthors.reduce((sum, [, count]) => sum + count, 0);

    for (const [authorName, count] of sortedAuthors) {
      const pct = Math.round((count / totalTouches) * 100);
      const bar = renderBar(pct, 16);
      lines.push(`  ${padRight(authorName, 22)} ${padLeft(pct + '%', 4)}  ${bar}  ${style('dim', `(${count} edit${count === 1 ? '' : 's'})`)}`);
    }
  } else if (ownership?.primaryAuthor) {
    lines.push(`  Primary Author: ${style('bold', ownership.primaryAuthor.name)} (${ownership.primaryAuthor.percentage}%)`);
  } else {
    lines.push(`  ${style('dim', 'Ownership details not available.')}`);
  }
  lines.push('');

  // 3. Activity & Complexity Breakdown
  lines.push(style('bold', style('cyan', '📊 Activity & Structural Metrics')));
  const touchCount = churn?.touches ?? hotspot?.churn ?? '—';
  lines.push(`  • Revision Count:        ${style('bold', String(touchCount))} commits touched this file`);
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

  // 4. Actionable Recommendation
  lines.push(style('bold', style('cyan', '💡 Recommended Interpretation & Next Steps')));
  if (severity === 'CRITICAL' || severity === 'HIGH') {
    lines.push(`  ${style('yellow', '→')} Pair on upcoming modifications or conduct an architecture review.`);
    lines.push(`  ${style('yellow', '→')} Transfer domain knowledge to secondary team members to eliminate the single-author bottleneck.`);
  } else {
    lines.push(`  ${style('green', '→')} File risk is within healthy engineering tolerances.`);
  }

  return renderPanel({
    lines,
    borderColor: sevColor,
  });
}

module.exports = {
  renderFileDetail,
};
