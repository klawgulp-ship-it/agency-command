#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const API_BASE = 'https://scintillating-gratitude-production.up.railway.app';
const FOOTER = '\n\x1b[2m Powered by SnipeLink Dev Tools \u2014 https://scintillating-gratitude-production.up.railway.app/tools\x1b[0m\n';

function postJSON(urlStr, data) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const options = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 30000
    };
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(body)); }
          catch { resolve({ review: body }); }
        } else {
          reject(new Error(`API returned ${res.statusCode}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')); });
    req.write(JSON.stringify(data));
    req.end();
  });
}

const SEVERITY = {
  error: '\x1b[31m[ERROR]\x1b[0m',
  warning: '\x1b[33m[WARN]\x1b[0m',
  info: '\x1b[36m[INFO]\x1b[0m',
  suggestion: '\x1b[32m[TIP]\x1b[0m'
};

function localReview(code, filename) {
  const lines = code.split('\n');
  const ext = path.extname(filename).toLowerCase();
  const issues = [];
  let score = 100;

  // --- Security checks ---
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (/eval\s*\(/.test(line)) {
      issues.push({ line: ln, severity: 'error', message: 'Use of eval() is a security risk. Consider alternatives.', category: 'Security' });
      score -= 10;
    }
    if (/innerHTML\s*=/.test(line)) {
      issues.push({ line: ln, severity: 'warning', message: 'Direct innerHTML assignment can lead to XSS. Use textContent or sanitize input.', category: 'Security' });
      score -= 5;
    }
    if (/\b(password|secret|apikey|api_key|token)\s*[:=]\s*['"][^'"]+['"]/i.test(line)) {
      issues.push({ line: ln, severity: 'error', message: 'Possible hardcoded secret/credential detected.', category: 'Security' });
      score -= 15;
    }
    if (/new\s+Function\s*\(/.test(line)) {
      issues.push({ line: ln, severity: 'error', message: 'new Function() is similar to eval(). Avoid dynamic code execution.', category: 'Security' });
      score -= 10;
    }
  });

  // --- Code quality checks ---
  lines.forEach((line, i) => {
    const ln = i + 1;
    if (line.length > 120) {
      issues.push({ line: ln, severity: 'info', message: `Line is ${line.length} chars long. Consider breaking it up for readability.`, category: 'Style' });
      score -= 1;
    }
    if (/console\.(log|warn|error|debug)\s*\(/.test(line) && !filename.includes('test') && !filename.includes('spec')) {
      issues.push({ line: ln, severity: 'info', message: 'Console statement found. Remove before production or use a proper logger.', category: 'Quality' });
      score -= 2;
    }
    if (/\/\/\s*TODO/i.test(line) || /\/\/\s*FIXME/i.test(line) || /\/\/\s*HACK/i.test(line)) {
      issues.push({ line: ln, severity: 'warning', message: 'TODO/FIXME/HACK comment found. Track these in your issue tracker.', category: 'Maintenance' });
      score -= 2;
    }
    if (/var\s+/.test(line) && ['.js', '.ts', '.jsx', '.tsx'].includes(ext)) {
      issues.push({ line: ln, severity: 'warning', message: 'Use const or let instead of var for proper scoping.', category: 'Quality' });
      score -= 3;
    }
  });

  // --- Complexity checks ---
  const funcPattern = /function\s+\w+|=>\s*{|\.then\(|\.catch\(/g;
  const funcCount = (code.match(funcPattern) || []).length;
  if (funcCount > 20) {
    issues.push({ line: 0, severity: 'warning', message: `File contains ${funcCount} functions/callbacks. Consider splitting into modules.`, category: 'Complexity' });
    score -= 5;
  }

  if (lines.length > 300) {
    issues.push({ line: 0, severity: 'info', message: `File is ${lines.length} lines. Consider splitting large files for maintainability.`, category: 'Complexity' });
    score -= 3;
  }

  // Nested callback depth
  let maxDepth = 0, currentDepth = 0;
  for (const line of lines) {
    currentDepth += (line.match(/{/g) || []).length;
    currentDepth -= (line.match(/}/g) || []).length;
    if (currentDepth > maxDepth) maxDepth = currentDepth;
  }
  if (maxDepth > 6) {
    issues.push({ line: 0, severity: 'warning', message: `Max nesting depth is ${maxDepth}. Deep nesting hurts readability. Refactor with early returns or extract functions.`, category: 'Complexity' });
    score -= 5;
  }

  // --- Error handling ---
  if (code.includes('catch') && /catch\s*\(\s*\w*\s*\)\s*\{\s*\}/.test(code)) {
    issues.push({ line: 0, severity: 'warning', message: 'Empty catch block found. Always handle or log errors.', category: 'Error Handling' });
    score -= 5;
  }

  // --- Async checks ---
  if (code.includes('async') && !code.includes('try') && code.includes('await')) {
    issues.push({ line: 0, severity: 'warning', message: 'Async function uses await without try/catch. Unhandled promise rejections will crash in Node 15+.', category: 'Error Handling' });
    score -= 5;
  }

  // --- Suggestions ---
  if (!code.includes('use strict') && ext === '.js') {
    issues.push({ line: 0, severity: 'suggestion', message: 'Consider adding "use strict" or migrating to ESM/TypeScript for stricter parsing.', category: 'Best Practice' });
  }
  if (ext === '.js' && !code.includes('jsdoc') && funcCount > 3) {
    issues.push({ line: 0, severity: 'suggestion', message: 'Consider adding JSDoc comments for better IDE support and documentation.', category: 'Documentation' });
  }

  score = Math.max(0, Math.min(100, score));

  return { issues, score, lines: lines.length, functions: funcCount };
}

function formatReview(result, filename) {
  const { issues, score, lines, functions } = result;
  const output = [];

  output.push(`\x1b[1m\x1b[4mCode Review: ${filename}\x1b[0m\n`);

  // Score bar
  const scoreColor = score >= 80 ? '\x1b[32m' : score >= 60 ? '\x1b[33m' : '\x1b[31m';
  const filled = Math.round(score / 5);
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(20 - filled);
  output.push(`  Score: ${scoreColor}${score}/100 [${bar}]\x1b[0m`);
  output.push(`  Lines: ${lines} | Functions: ${functions} | Issues: ${issues.length}\n`);

  if (issues.length === 0) {
    output.push('\x1b[32m  No issues found. Code looks clean!\x1b[0m');
  } else {
    // Group by category
    const byCategory = {};
    for (const issue of issues) {
      if (!byCategory[issue.category]) byCategory[issue.category] = [];
      byCategory[issue.category].push(issue);
    }

    for (const [category, categoryIssues] of Object.entries(byCategory)) {
      output.push(`\x1b[1m  ${category}\x1b[0m`);
      for (const issue of categoryIssues) {
        const loc = issue.line > 0 ? `L${issue.line}` : '    ';
        output.push(`    ${SEVERITY[issue.severity]} ${loc}: ${issue.message}`);
      }
      output.push('');
    }
  }

  return output.join('\n');
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
\x1b[1m@snipelink/review\x1b[0m \u2014 AI-powered code review

\x1b[1mUsage:\x1b[0m
  npx @snipelink/review <file> [options]

\x1b[1mOptions:\x1b[0m
  --json        Output results as JSON
  --strict      Stricter analysis (more warnings)
  -h, --help    Show this help

\x1b[1mSupported Languages:\x1b[0m
  JavaScript, TypeScript, Python, Go, Rust, Java, Ruby, PHP, and more.

\x1b[1mExamples:\x1b[0m
  npx @snipelink/review src/server.js
  npx @snipelink/review app.py --strict
  npx @snipelink/review lib/utils.ts --json
${FOOTER}`);
    return;
  }

  const inputFile = args.find(a => !a.startsWith('-'));
  if (!inputFile) {
    console.error('\x1b[31mError: No input file specified.\x1b[0m');
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`\x1b[31mError: File "${inputFile}" not found.\x1b[0m`);
    process.exit(1);
  }

  const code = fs.readFileSync(inputPath, 'utf-8');
  const filename = path.basename(inputPath);
  const asJSON = args.includes('--json');
  const strict = args.includes('--strict');

  console.log(`\x1b[36mReviewing ${filename} (${code.split('\n').length} lines)...\x1b[0m\n`);

  let reviewOutput;
  try {
    const response = await postJSON(`${API_BASE}/api/tools/review`, {
      code,
      filename,
      strict
    });
    const review = response.review || response.content || response.result;
    if (!review) throw new Error('Empty response from API');

    if (asJSON) {
      console.log(JSON.stringify(response, null, 2));
    } else {
      console.log(review);
    }
    console.log('\n\x1b[32mReview generated via SnipeLink AI API.\x1b[0m');
  } catch (err) {
    console.log(`\x1b[33mAPI unavailable (${err.message}), using local analysis...\x1b[0m\n`);
    const result = localReview(code, filename);

    if (asJSON) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      reviewOutput = formatReview(result, filename);
      console.log(reviewOutput);
    }
    console.log('\x1b[33mNote: Local analysis covers common patterns. Use the API for full AI-powered review.\x1b[0m');
  }

  console.log(FOOTER);
}

main().catch(err => {
  console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  console.log(FOOTER);
  process.exit(1);
});
