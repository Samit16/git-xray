'use strict';

const { computeChurn } = require('./churn.js');
const { computeOwnership } = require('./ownership.js');
const { computeBusFactor } = require('./bus-factor.js');
const { computeHotspots } = require('./hotspots.js');

/**
 * Compute Executive Overview metrics for a repository.
 *
 * Provides:
 * - Basic stats: commits count, contributor count, tracked files count
 * - Overall risk score & severity rating (LOW / MEDIUM / HIGH / CRITICAL)
 * - Knowledge concentration metrics (gini/top author dominance)
 * - Bus-factor alerts (files with high single-author concentration)
 * - Critical files & Top hotspots (risk ranked)
 *
 * @param {string} repoPath
 * @param {ParsedCommit[]} commits
 * @param {Map<string, { added, modified, deleted }>} diffs
 * @param {number} threshold - bus factor threshold (default: 80)
 * @returns {ExecutiveOverview}
 */
function computeOverview(repoPath, commits, diffs, threshold = 80, branch = null) {
  const churnList = computeChurn(commits, diffs);
  const ownershipList = computeOwnership(commits, diffs);
  const busFactorList = computeBusFactor(ownershipList, threshold);
  const hotspotsList = computeHotspots(commits, diffs);

  // 1. Contributor count & author distribution
  const authorSet = new Set();
  const authorCommitCount = new Map();

  for (const commit of commits) {
    const authorKey = `${commit.author.name} <${commit.author.email}>`;
    authorSet.add(authorKey);
    authorCommitCount.set(authorKey, (authorCommitCount.get(authorKey) || 0) + 1);
  }

  const contributorCount = authorSet.size;
  const fileCount = ownershipList.length;
  const commitCount = commits.length;

  // 2. Bus-factor alerts (files >= threshold)
  const busFactorAlerts = busFactorList.filter((b) => b.atRisk);

  // 3. Critical & High risk files
  const criticalFiles = hotspotsList.filter((h) => h.severity === 'CRITICAL');
  const highRiskFiles = hotspotsList.filter((h) => h.severity === 'HIGH');
  const topHotspots = hotspotsList.slice(0, 5);

  // 4. Knowledge Concentration calculation
  // Find top committer across repo and their share of all commits
  let topCommitter = 'None';
  let topCommitterCommits = 0;
  for (const [authorKey, count] of authorCommitCount.entries()) {
    if (count > topCommitterCommits) {
      topCommitterCommits = count;
      topCommitter = authorKey.split(' <')[0];
    }
  }

  const topCommitterShare = commitCount > 0 ? (topCommitterCommits / commitCount) * 100 : 0;

  // Average ownership dominance across all files
  let avgMaxOwnership = 0;
  if (ownershipList.length > 0) {
    const sumDominance = ownershipList.reduce((acc, curr) => acc + (curr.primaryAuthor?.percentage || 0), 0);
    avgMaxOwnership = sumDominance / ownershipList.length;
  }

  // 5. Overall Repository Risk Scoring (0-100)
  // Factors:
  // - Critical & High hotspots ratio
  // - Bus factor at-risk percentage
  // - Contributor count & commit distribution
  let riskScore = 0;

  if (fileCount > 0) {
    const criticalRatio = criticalFiles.length / fileCount;
    const highRatio = highRiskFiles.length / fileCount;
    const atRiskRatio = busFactorAlerts.length / fileCount;

    const hotspotFactor = Math.min(100, (criticalRatio * 100 * 0.5) + (highRatio * 100 * 0.3) + ((topHotspots[0]?.riskScore || 0) * 0.2));
    const busFactorScore = atRiskRatio * 100;
    const concentrationScore = avgMaxOwnership;

    riskScore = Math.round(
      (hotspotFactor * 0.40) +
      (busFactorScore * 0.35) +
      (concentrationScore * 0.25)
    );
  }

  let overallRisk = 'LOW';
  if (riskScore >= 75) overallRisk = 'CRITICAL';
  else if (riskScore >= 50) overallRisk = 'HIGH';
  else if (riskScore >= 25) overallRisk = 'MEDIUM';

  let branchName = branch;
  if (!branchName) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const headFile = path.join(repoPath, '.git', 'HEAD');
      if (fs.existsSync(headFile)) {
        const content = fs.readFileSync(headFile, 'utf8').trim();
        if (content.startsWith('ref: refs/heads/')) {
          branchName = content.replace('ref: refs/heads/', '').trim();
        } else if (content.startsWith('ref: ')) {
          branchName = content.slice(5).trim();
        }
      }
    } catch {
      // ignore
    }
  }

  const activitySeries = computeActivitySeries(commits, diffs, 7);

  return {
    repository: repoPath,
    branch: branchName || 'main',
    commitCount,
    contributorCount,
    fileCount,
    overallRisk,
    riskScore,
    activitySeries,
    knowledgeConcentration: {
      topCommitter,
      topCommitterShare: Math.round(topCommitterShare * 10) / 10,
      avgMaxOwnership: Math.round(avgMaxOwnership * 10) / 10,
      concentrationLevel: avgMaxOwnership >= 80 ? 'HIGH' : avgMaxOwnership >= 50 ? 'MODERATE' : 'BALANCED',
    },
    busFactorAlerts: {
      threshold,
      atRiskCount: busFactorAlerts.length,
      percentage: fileCount > 0 ? Math.round((busFactorAlerts.length / fileCount) * 1000) / 10 : 0,
      topAlerts: busFactorAlerts.slice(0, 5),
    },
    criticalFiles: criticalFiles.map((c) => ({
      file: c.file,
      riskScore: c.riskScore,
      primaryRisk: c.primaryRisk,
    })),
    topHotspots: topHotspots.map((h) => ({
      file: h.file,
      riskScore: h.riskScore,
      severity: h.severity,
      churn: h.churn,
      ownershipConcentration: Math.round(h.ownershipConcentration),
      primaryRisk: h.primaryRisk,
    })),
  };
}

/**
 * Partition commit history into discrete intervals to generate activity and churn time-series.
 * @param {Array} commits
 * @param {Map<string, { added, modified, deleted }>} diffs
 * @param {number} intervals
 */
function computeActivitySeries(commits, diffs, intervals = 7) {
  if (!Array.isArray(commits) || commits.length < 2) {
    return null;
  }

  const timestamps = commits.map((c) => c.author?.timestamp || 0).filter((t) => t > 0);
  if (timestamps.length < 2) {
    return null;
  }

  const newest = Math.max(...timestamps);
  const oldest = Math.min(...timestamps);

  if (newest <= oldest) {
    return null;
  }

  const duration = newest - oldest;
  const bucketDuration = duration / intervals;

  const commitBuckets = new Array(intervals).fill(0);
  const churnBuckets = new Array(intervals).fill(0);

  for (const commit of commits) {
    const t = commit.author?.timestamp || 0;
    if (t < oldest) continue;
    let idx = Math.floor((t - oldest) / bucketDuration);
    if (idx >= intervals) idx = intervals - 1;

    commitBuckets[idx] += 1;

    if (diffs && diffs.has(commit.hash)) {
      const diff = diffs.get(commit.hash);
      const touches = (diff.added?.length || 0) + (diff.modified?.length || 0) + (diff.deleted?.length || 0);
      churnBuckets[idx] += touches;
    }
  }

  return {
    intervals,
    commitActivity: commitBuckets,
    fileChurn: churnBuckets,
    oldestTimestamp: oldest,
    newestTimestamp: newest,
  };
}

module.exports = { computeOverview, computeActivitySeries };
