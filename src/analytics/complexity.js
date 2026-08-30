'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Structural Complexity Analyzer
 *
 * Detects structural patterns in source code:
 * - if/else branches
 * - loops (for, while, do-while, foreach)
 * - switch cases
 * - catch blocks
 * - logical operators
 * - ternary operators
 * - function/method declarations
 * - nesting depth
 *
 * Complexity Score Calculation:
 *   Base = (branches + loops + switches + catches + ternaries) × 1
 *   Operators = logical operators × 0.5
 *   Nesting = max nesting depth × 2
 *   Functions = function count (context only, not added to score)
 *
 *   Normalized Score (0–100):
 *     score = min(100, (base + operators + nesting) / scaleFactor)
 *
 * This is NOT cyclomatic complexity or a universal metric.
 * It is a simple heuristic for identifying structurally complex files.
 *
 * @param {string} filePath — absolute path to the source file
 * @returns {{ file, score, complexity, branches, loops, switches, catches, ternaries, logicalOps, maxDepth, functions, language }}
 */
function analyzeComplexity(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const language = detectLanguage(filePath);

  // Remove comments to avoid counting keywords inside them
  const stripped = stripComments(content, language);

  // Count structural patterns
  const branches = (stripped.match(/\b(if|else\s+if|else)\b/g) || []).length;
  const switches = (stripped.match(/\bswitch\b/g) || []).length;
  const cases = (stripped.match(/\bcase\b/g) || []).length;
  const loops = (stripped.match(/\b(for|while|do|foreach)\b/g) || []).length;
  const catches = (stripped.match(/\bcatch\b/g) || []).length;
  const ternaries = (stripped.match(/\?[^?]*:/g) || []).length;
  const logicalOps = (stripped.match(/(?:&&|\|\||!)/g) || []).length;
  const functions = (stripped.match(/\b(?:function|def|fn|=>|async\s+\w+|async\s*\()\b/g) || []).length;

  // Calculate nesting depth (simple approximation)
  const maxDepth = calculateMaxNesting(stripped);

  // Compute base complexity score
  const base = branches + switches + cases + loops + catches + ternaries;
  const operators = logicalOps * 0.5;
  const nesting = Math.max(0, maxDepth - 1) * 2; // Penalize deep nesting

  const rawScore = base + operators + nesting;

  // Normalize to 0–100
  // Scale factor: aim for a reasonably complex file (~10 branches+depth) to score ~30–40
  const scaleFactor = 1.0;
  const normalizedScore = Math.min(100, Math.round(rawScore * scaleFactor));

  // Complexity level
  let complexity;
  if (normalizedScore >= 70) complexity = 'VERY HIGH';
  else if (normalizedScore >= 50) complexity = 'HIGH';
  else if (normalizedScore >= 30) complexity = 'MEDIUM';
  else if (normalizedScore >= 10) complexity = 'LOW';
  else complexity = 'TRIVIAL';

  return {
    file: filePath,
    score: normalizedScore,
    complexity,
    branches,
    loops,
    switches,
    cases,
    catches,
    ternaries,
    logicalOps,
    maxDepth,
    functions,
    language,
    raw: { base, operators, nesting },
  };
}

/**
 * Detect language from file extension
 * @param {string} filePath
 * @returns {string}
 */
function detectLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const langMap = {
    '.js': 'JavaScript',
    '.ts': 'TypeScript',
    '.jsx': 'JSX',
    '.tsx': 'TSX',
    '.py': 'Python',
    '.java': 'Java',
    '.go': 'Go',
    '.rs': 'Rust',
    '.cpp': 'C++',
    '.c': 'C',
    '.cs': 'C#',
    '.php': 'PHP',
    '.rb': 'Ruby',
    '.swift': 'Swift',
    '.kt': 'Kotlin',
  };
  return langMap[ext] || 'Unknown';
}

/**
 * Strip comments from code
 * Handles:
 * - // single-line comments
 * - block comments (multi-line)
 * - # comments (Python, Shell)
 * - -- comments (SQL)
 *
 * @param {string} content
 * @param {string} language
 * @returns {string}
 */
function stripComments(content, language) {
  let result = content;

  // Remove // comments
  result = result.replace(/\/\/.*$/gm, ' ');

  // Remove /* */ comments
  result = result.replace(/\/\*[\s\S]*?\*\//g, ' ');

  // Remove # comments (Python, shell)
  result = result.replace(/#.*$/gm, ' ');

  // Remove -- comments (SQL)
  result = result.replace(/--.*$/gm, ' ');

  // Remove strings to avoid counting keywords in string literals
  // Remove "..." strings
  result = result.replace(/"(?:\\"|[^"])*"/g, ' ');

  // Remove '...' strings
  result = result.replace(/'(?:\\'|[^'])*'/g, ' ');

  // Remove `...` strings (template literals)
  result = result.replace(/`(?:\\`|[^`])*`/g, ' ');

  return result;
}

/**
 * Calculate maximum nesting depth
 * Counts { } { } nesting (simple brace matching)
 *
 * @param {string} content
 * @returns {number}
 */
function calculateMaxNesting(content) {
  let maxDepth = 0;
  let currentDepth = 0;

  for (let i = 0; i < content.length; i++) {
    if (content[i] === '{') {
      currentDepth++;
      maxDepth = Math.max(maxDepth, currentDepth);
    } else if (content[i] === '}') {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  return maxDepth;
}

/**
 * Analyze complexity for all files in a directory/repository
 * @param {string} dirPath — absolute path to directory
 * @returns {Array<{ file, score, complexity, ... }>}
 */
function analyzeDirectoryComplexity(dirPath) {
  const results = [];
  const supportedExts = new Set([
    '.js', '.ts', '.jsx', '.tsx', '.py', '.java', '.go', '.rs',
    '.cpp', '.c', '.cs', '.php', '.rb', '.swift', '.kt',
  ]);

  function walkDir(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);

        // Skip common non-source directories
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
            walkDir(fullPath);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (supportedExts.has(ext)) {
            try {
              const analysis = analyzeComplexity(fullPath);
              results.push(analysis);
            } catch {
              // Skip files that can't be read
            }
          }
        }
      }
    } catch {
      // Skip directories that can't be read
    }
  }

  walkDir(dirPath);

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  return results;
}

module.exports = { analyzeComplexity, analyzeDirectoryComplexity, detectLanguage, stripComments, calculateMaxNesting };
