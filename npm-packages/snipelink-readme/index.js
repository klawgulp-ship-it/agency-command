#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const API_BASE = 'https://scintillating-gratitude-production.up.railway.app';
const FOOTER = '\n\x1b[2m Powered by SnipeLink Dev Tools \u2014 https://scintillating-gratitude-production.up.railway.app/tools\x1b[0m\n';

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', 'coverage',
  '.cache', '.vscode', '.idea', '__pycache__', '.DS_Store', 'vendor'
]);

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.tsx', '.jsx', '.py', '.go', '.rs', '.java',
  '.rb', '.php', '.css', '.scss', '.html', '.vue', '.svelte',
  '.sh', '.yml', '.yaml', '.toml', '.json', '.md', '.sql'
]);

function scanDirectory(dir, depth = 0, maxDepth = 3) {
  const entries = [];
  if (depth > maxDepth) return entries;
  try {
    const items = fs.readdirSync(dir, { withFileTypes: true });
    for (const item of items) {
      if (IGNORE_DIRS.has(item.name) || item.name.startsWith('.')) continue;
      const fullPath = path.join(dir, item.name);
      if (item.isDirectory()) {
        entries.push({ type: 'dir', name: item.name, depth });
        entries.push(...scanDirectory(fullPath, depth + 1, maxDepth));
      } else {
        const ext = path.extname(item.name).toLowerCase();
        entries.push({ type: 'file', name: item.name, ext, depth });
      }
    }
  } catch (e) { /* skip unreadable dirs */ }
  return entries;
}

function buildTree(entries) {
  return entries.map(e => {
    const indent = '  '.repeat(e.depth);
    const prefix = e.type === 'dir' ? '\u251C\u2500\u2500 ' : '\u251C\u2500\u2500 ';
    return `${indent}${prefix}${e.name}`;
  }).join('\n');
}

function readFileContents(dir, maxFiles = 15, maxSize = 2000) {
  const files = {};
  const priority = ['package.json', 'Cargo.toml', 'go.mod', 'pyproject.toml',
    'requirements.txt', 'Makefile', 'Dockerfile', 'docker-compose.yml'];

  for (const name of priority) {
    const fp = path.join(dir, name);
    if (fs.existsSync(fp)) {
      try {
        files[name] = fs.readFileSync(fp, 'utf-8').slice(0, maxSize);
      } catch (e) { /* skip */ }
    }
  }

  const entries = scanDirectory(dir, 0, 2);
  for (const e of entries) {
    if (Object.keys(files).length >= maxFiles) break;
    if (e.type === 'file' && CODE_EXTENSIONS.has(e.ext) && !files[e.name]) {
      const fp = path.join(dir, e.name);
      try {
        files[e.name] = fs.readFileSync(fp, 'utf-8').slice(0, maxSize);
      } catch (e) { /* skip */ }
    }
  }
  return files;
}

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
          catch { resolve({ readme: body }); }
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

function generateLocalReadme(dir, entries, files) {
  const name = path.basename(dir);
  const pkg = files['package.json'] ? JSON.parse(files['package.json']) : null;
  const projectName = pkg?.name || name;
  const description = pkg?.description || `A project called ${name}`;
  const tree = buildTree(entries);

  const sections = [`# ${projectName}\n\n${description}\n`];

  sections.push(`## Project Structure\n\n\`\`\`\n${tree}\n\`\`\`\n`);

  if (pkg) {
    if (pkg.scripts) {
      sections.push('## Available Scripts\n');
      for (const [cmd, script] of Object.entries(pkg.scripts)) {
        sections.push(`- \`npm run ${cmd}\` \u2014 \`${script}\``);
      }
      sections.push('');
    }
    const deps = { ...pkg.dependencies };
    if (Object.keys(deps).length > 0) {
      sections.push('## Dependencies\n');
      for (const [dep, ver] of Object.entries(deps)) {
        sections.push(`- \`${dep}\`: ${ver}`);
      }
      sections.push('');
    }
  }

  if (files['Dockerfile'] || files['docker-compose.yml']) {
    sections.push('## Docker\n\nThis project includes Docker configuration for containerized deployment.\n');
  }

  const hasTests = entries.some(e => e.name?.includes('test') || e.name?.includes('spec'));
  if (hasTests || pkg?.scripts?.test) {
    sections.push('## Testing\n\n```bash\nnpm test\n```\n');
  }

  sections.push('## Getting Started\n\n```bash\ngit clone <repository-url>\ncd ' + name + '\nnpm install\n```\n');

  if (pkg?.license) {
    sections.push(`## License\n\n${pkg.license}\n`);
  }

  return sections.join('\n');
}

async function main() {
  const args = process.argv.slice(2);
  const dir = args[0] ? path.resolve(args[0]) : process.cwd();
  const outputFile = args.includes('-o') ? args[args.indexOf('-o') + 1] : 'README.md';
  const dryRun = args.includes('--dry-run') || args.includes('--stdout');
  const force = args.includes('-f') || args.includes('--force');

  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
\x1b[1m@snipelink/readme\x1b[0m \u2014 AI-powered README generator

\x1b[1mUsage:\x1b[0m
  npx @snipelink/readme [directory] [options]

\x1b[1mOptions:\x1b[0m
  -o <file>     Output filename (default: README.md)
  -f, --force   Overwrite existing README.md
  --dry-run     Print to stdout instead of writing file
  --stdout      Same as --dry-run
  -h, --help    Show this help
${FOOTER}`);
    return;
  }

  if (!fs.existsSync(dir)) {
    console.error(`\x1b[31mError: Directory "${dir}" does not exist.\x1b[0m`);
    process.exit(1);
  }

  const outputPath = path.join(dir, outputFile);
  if (fs.existsSync(outputPath) && !force && !dryRun) {
    console.error(`\x1b[33m${outputFile} already exists. Use -f to overwrite or --stdout to preview.\x1b[0m`);
    process.exit(1);
  }

  console.log(`\x1b[36mScanning ${dir}...\x1b[0m`);
  const entries = scanDirectory(dir);
  const files = readFileContents(dir);
  const tree = buildTree(entries);

  console.log(`\x1b[36mFound ${entries.length} items. Generating README...\x1b[0m`);

  let readme;
  try {
    const response = await postJSON(`${API_BASE}/api/tools/readme`, {
      tree,
      files,
      directory: path.basename(dir)
    });
    readme = response.readme || response.content || response.result;
    if (!readme) throw new Error('Empty response from API');
    console.log('\x1b[32mGenerated via SnipeLink AI API.\x1b[0m');
  } catch (err) {
    console.log(`\x1b[33mAPI unavailable (${err.message}), using local generation...\x1b[0m`);
    readme = generateLocalReadme(dir, entries, files);
  }

  if (dryRun) {
    console.log('\n' + readme);
  } else {
    fs.writeFileSync(outputPath, readme, 'utf-8');
    console.log(`\x1b[32mWrote ${outputFile} (${readme.length} bytes)\x1b[0m`);
  }

  console.log(FOOTER);
}

main().catch(err => {
  console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  console.log(FOOTER);
  process.exit(1);
});
