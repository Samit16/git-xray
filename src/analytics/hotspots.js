'use strict';

/**
 * Risk Hotspots Analyzer
 *
 * Identifies files that represent engineering or knowledge risk.
 *
 * Risk Formula:
 *   Risk Score = (churn_weight × 0.4) + (ownership_concentration_weight × 0.35) + (recency_weight × 0.25)
 *
 * Each weight is normalized to 0–100:
 *   - Churn: file touch count relative to max churn
 *   - Ownership concentration: inverse of bus factor (how much one author dominates)
 *   - Recency: how recently the file was last touched
 *
 * Severity Levels:
 *   - CRITICAL: 80–100
 *   - HIGH:     60–79
 *   - MEDIUM:   40–59
 *   - LOW:      0–39
 *
 * @param {ParsedCommit[]} commits — from walkCommits()
 * @param {Map<string, { added, modified, deleted }>} diffs — from computeAllDiffs()
 * @returns {Array<{ file, riskScore, severity, churn, ownershipConcentration, recency, primaryRisk }>}
 */
function computeHotspots(commits, diffs) {
  // Build per-file metrics
  const fileMetrics = new Map();

  // Iterate through commits in chronological order to track recency
  for (let i = commits.length - 1; i >= 0; i--) {
    const commit = commits[i];
    const diff = diffs.get(commit.hash) || { added: [], modified: [], deleted: [] };

    const allFiles = new Set([...diff.added, ...diff.modified, ...diff.deleted]);
    for (const file of allFiles) {
      if (!fileMetrics.has(file)) {
        fileMetrics.set(file, {
          path: file,
          touches: 0,
          authorTouches: new Map(),
          lastCommitIndex: i,
          touchDates: [],
        });
      }

      const metric = fileMetrics.get(file);
      metric.touches++;
      metric.lastCommitIndex = Math.min(metric.lastCommitIndex, i);
      metric.touchDates.push(commit.author.timestamp);

      const author = commit.author.name;
      metric.authorTouches.set(author, (metric.authorTouches.get(author) || 0) + 1);
    }
  }

  // Compute normalized weights
  const maxChurn = Math.max(...Array.from(fileMetrics.values()).map((m) => m.touches), 1);
  const now = Math.max(...commits.map((c) => c.author.timestamp), Date.now() / 1000);
  const thirtyDaysAgo = now - 30 * 24 * 60 * 60;

  const hotspots = [];

  for (const metric of fileMetrics.values()) {
    // 1. Churn weight: normalized by max churn
    const churnWeight = (metric.touches / maxChurn) * 100;

    // 2. Ownership concentration weight: max author touch percentage
    const maxAuthorTouches = Math.max(...metric.authorTouches.values(), 1);
    const ownershipConcentration = (maxAuthorTouches / metric.touches) * 100;
    const ownershipWeight = ownershipConcentration; // Higher = riskier

    // 3. Recency weight: how recently touched
    const lastTouchTime = Math.max(...metric.touchDates, 0);
    const daysSinceLastTouch = Math.max(0, (now - lastTouchTime) / (24 * 60 * 60));
    // Decay: recent = 100, old = lower
    const recencyWeight = Math.max(0, 100 - daysSinceLastTouch * 2); // Decays 2 points per day

    // Compute composite risk score
    const riskScore = churnWeight * 0.4 + ownershipWeight * 0.35 + recencyWeight * 0.25;

    // Determine severity
    let severity;
    if (riskScore >= 80) severity = 'CRITICAL';
    else if (riskScore >= 60) severity = 'HIGH';
    else if (riskScore >= 40) severity = 'MEDIUM';
    else severity = 'LOW';

    // Identify primary risk reason
    const reasons = [];
    if (churnWeight >= 70) reasons.push('High change frequency');
    if (ownershipWeight >= 80) reasons.push('Knowledge concentrated in one author');
    if (recencyWeight >= 70) reasons.push('Recently modified frequently');

    const primaryRisk = reasons.length > 0 ? reasons[0] : 'Moderate risk profile';

    hotspots.push({
      file: metric.path,
      riskScore: Math.round(riskScore),
      severity,
      churn: metric.touches,
      ownershipConcentration: Math.round(ownershipConcentration),
      recency: daysSinceLastTouch,
      primaryRisk,
      topAuthor: Array.from(metric.authorTouches.entries()).sort((a, b) => b[1] - a[1])[0],
    });
  }

  // Sort by risk score descending
  hotspots.sort((a, b) => b.riskScore - a.riskScore);

  return hotspots;
}

/**
 * Filter hotspots by minimum risk score
 * @param {Array} hotspots — from computeHotspots()
 * @param {string} minSeverity — "CRITICAL", "HIGH", "MEDIUM", "LOW"
 * @returns {Array}
 */
function filterBySeverity(hotspots, minSeverity) {
  const severityMap = { CRITICAL: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
  const minLevel = severityMap[minSeverity] || 0;
  return hotspots.filter((h) => severityMap[h.severity] >= minLevel);
}

module.exports = { computeHotspots, filterBySeverity };
