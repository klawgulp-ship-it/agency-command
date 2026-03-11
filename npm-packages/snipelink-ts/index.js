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
          catch { resolve({ typescript: body }); }
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

function inferTypes(code) {
  let ts = code;

  // Add basic type annotations to function parameters
  ts = ts.replace(
    /function\s+(\w+)\s*\(([^)]*)\)\s*\{/g,
    (match, name, params) => {
      if (!params.trim()) return match;
      const typedParams = params.split(',').map(p => {
        const param = p.trim();
        if (param.includes(':')) return param; // already typed
        if (param.includes('=')) {
          const [pName, defaultVal] = param.split('=').map(s => s.trim());
          const type = inferTypeFromValue(defaultVal);
          return `${pName}: ${type} = ${defaultVal}`;
        }
        return `${param}: any`;
      }).join(', ');
      return `function ${name}(${typedParams}) {`;
    }
  );

  // Arrow functions with parens
  ts = ts.replace(
    /const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>\s*/g,
    (match, name, params) => {
      if (!params.trim()) return match;
      const typedParams = params.split(',').map(p => {
        const param = p.trim();
        if (param.includes(':')) return param;
        if (param.includes('=')) {
          const [pName, defaultVal] = param.split('=').map(s => s.trim());
          const type = inferTypeFromValue(defaultVal);
          return `${pName}: ${type} = ${defaultVal}`;
        }
        return `${param}: any`;
      }).join(', ');
      return `const ${name} = (${typedParams}) => `;
    }
  );

  // Convert require to import
  ts = ts.replace(
    /const\s+(\w+)\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
    "import $1 from '$2';"
  );
  ts = ts.replace(
    /const\s*\{([^}]+)\}\s*=\s*require\(['"]([^'"]+)['"]\);?/g,
    "import { $1 } from '$2';"
  );

  // module.exports to export default
  ts = ts.replace(/module\.exports\s*=\s*/, 'export default ');
  ts = ts.replace(/exports\.(\w+)\s*=/g, 'export const $1 =');

  // Add type to let/const with obvious assignments
  ts = ts.replace(
    /^(const|let)\s+(\w+)\s*=\s*\[\s*\];?\s*$/gm,
    '$1 $2: any[] = [];'
  );
  ts = ts.replace(
    /^(const|let)\s+(\w+)\s*=\s*\{\s*\};?\s*$/gm,
    '$1 $2: Record<string, any> = {};'
  );

  return ts;
}

function inferTypeFromValue(val) {
  val = val.trim();
  if (val === 'true' || val === 'false') return 'boolean';
  if (val.startsWith("'") || val.startsWith('"') || val.startsWith('`')) return 'string';
  if (!isNaN(Number(val)) && val !== '') return 'number';
  if (val === 'null') return 'null';
  if (val === 'undefined') return 'undefined';
  if (val.startsWith('[')) return 'any[]';
  if (val.startsWith('{')) return 'Record<string, any>';
  return 'any';
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--help') || args.includes('-h') || args.length === 0) {
    console.log(`
\x1b[1m@snipelink/ts\x1b[0m \u2014 AI-powered JavaScript to TypeScript converter

\x1b[1mUsage:\x1b[0m
  npx @snipelink/ts <file.js> [options]

\x1b[1mOptions:\x1b[0m
  -o <file>     Output filename (default: same name with .ts/.tsx extension)
  --stdout      Print to stdout instead of writing file
  --strict      Enable strict type inference (fewer 'any' types)
  -h, --help    Show this help

\x1b[1mExamples:\x1b[0m
  npx @snipelink/ts src/app.js
  npx @snipelink/ts components/Button.jsx -o Button.tsx
  npx @snipelink/ts utils.js --stdout
${FOOTER}`);
    return;
  }

  const inputFile = args.find(a => !a.startsWith('-') && a !== args[args.indexOf('-o') + 1]);
  if (!inputFile) {
    console.error('\x1b[31mError: No input file specified.\x1b[0m');
    process.exit(1);
  }

  const inputPath = path.resolve(inputFile);
  if (!fs.existsSync(inputPath)) {
    console.error(`\x1b[31mError: File "${inputFile}" not found.\x1b[0m`);
    process.exit(1);
  }

  const ext = path.extname(inputPath);
  if (!['.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
    console.error(`\x1b[33mWarning: "${ext}" is not a typical JavaScript extension. Proceeding anyway.\x1b[0m`);
  }

  const toStdout = args.includes('--stdout');
  const strict = args.includes('--strict');
  const outExt = ext === '.jsx' ? '.tsx' : '.ts';
  const defaultOutput = inputPath.replace(/\.(js|jsx|mjs|cjs)$/, outExt);
  const outputPath = args.includes('-o') ? path.resolve(args[args.indexOf('-o') + 1]) : defaultOutput;

  const code = fs.readFileSync(inputPath, 'utf-8');
  console.log(`\x1b[36mConverting ${path.basename(inputPath)} (${code.split('\n').length} lines)...\x1b[0m`);

  let typescript;
  try {
    const response = await postJSON(`${API_BASE}/api/tools/convert-ts`, {
      code,
      filename: path.basename(inputPath),
      strict
    });
    typescript = response.typescript || response.content || response.result;
    if (!typescript) throw new Error('Empty response from API');
    console.log('\x1b[32mConverted via SnipeLink AI API.\x1b[0m');
  } catch (err) {
    console.log(`\x1b[33mAPI unavailable (${err.message}), using local conversion...\x1b[0m`);
    typescript = inferTypes(code);
    console.log('\x1b[32mConverted using local type inference.\x1b[0m');
    console.log('\x1b[33mNote: Local conversion adds basic types. Use the API for full AI-powered inference.\x1b[0m');
  }

  if (toStdout) {
    console.log('\n' + typescript);
  } else {
    fs.writeFileSync(outputPath, typescript, 'utf-8');
    console.log(`\x1b[32mWrote ${path.basename(outputPath)} (${typescript.length} bytes)\x1b[0m`);
  }

  console.log(FOOTER);
}

main().catch(err => {
  console.error(`\x1b[31mFatal: ${err.message}\x1b[0m`);
  console.log(FOOTER);
  process.exit(1);
});
