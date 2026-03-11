const ANTHROPIC_API = 'https://api.anthropic.com/v1/messages';

// AI "tells" — patterns that scream "a bot wrote this"
const AI_COMMENT_PATTERNS = [
  /\/\/\s*(Initialize|Create|Set up|Define|Declare|Get|Fetch|Handle|Process|Check|Validate|Ensure|Calculate|Convert|Transform|Update|Return|Import|Export|Assign|Store|Save|Load|Parse)\s+(the\s+)?/i,
  /\/\/\s*TODO:?\s/i,
  /\/\/\s*FIXME:?\s/i,
  /\/\/\s*NOTE:?\s/i,
  /\/\/\s*HACK:?\s/i,
  /\/\/\s*This (function|method|variable|constant|class|module|block|section)\s/i,
  /\/\/\s*The (following|above|below)\s/i,
  /\/\/\s*We (need to|should|must|can|will)\s/i,
  /\/\/\s*Here we\s/i,
  /\/\/\s*Now (we|let's)\s/i,
  /\/\/\s*First,?\s/i,
  /\/\/\s*Finally,?\s/i,
  /\/\/\s*Step \d/i,
  /\/\/\s*Error handling/i,
  /\/\/\s*Default (value|case|option)/i,
  /\/\/\s*Helper (function|method)/i,
  /\/\/\s*Utility (function|method)/i,
];

const GENERIC_VAR_NAMES = new Set([
  'result', 'data', 'temp', 'tmp', 'item', 'element', 'value',
  'obj', 'arr', 'str', 'num', 'val', 'ret', 'output', 'response',
]);

async function askClaude(prompt, maxTokens = 4096, model = 'claude-sonnet-4-6') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');
  const res = await fetch(ANTHROPIC_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
    signal: AbortSignal.timeout(90000),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message || 'Claude API error');
  return json.content?.map(c => c.text || '').join('\n') || '';
}

function analyzeRepoStyle(existingFiles) {
  const style = {
    indent: '  ',
    semicolons: true,
    quotes: 'single',
    commentDensity: 'sparse',
    namingConvention: 'camelCase',
    importStyle: 'cjs',
    trailingComma: false,
  };

  const files = Object.entries(existingFiles || {});
  if (!files.length) return style;

  // Sample up to 3 files, prefer longer ones (more signal)
  const sampled = files
    .filter(([, content]) => content && content.length > 50)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3);

  if (!sampled.length) return style;

  let tabs = 0, spaces2 = 0, spaces4 = 0;
  let semis = 0, noSemis = 0;
  let singleQ = 0, doubleQ = 0;
  let commentLines = 0, codeLines = 0;
  let camel = 0, snake = 0, pascal = 0;
  let esmImports = 0, cjsRequires = 0;
  let trailingCommas = 0, noTrailingCommas = 0;

  for (const [, content] of sampled) {
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trimStart();
      if (!trimmed || trimmed.length < 2) continue;

      // Indentation
      const leadingWs = line.match(/^(\s+)/);
      if (leadingWs) {
        const ws = leadingWs[1];
        if (ws[0] === '\t') tabs++;
        else if (ws.length % 4 === 0 && ws.length >= 4) spaces4++;
        else if (ws.length % 2 === 0) spaces2++;
      }

      // Skip comment-only lines for code analysis
      if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
        commentLines++;
        continue;
      }

      codeLines++;

      // Semicolons — check statement-ending lines
      if (/[a-zA-Z0-9'"\])];\s*$/.test(trimmed)) semis++;
      else if (/[a-zA-Z0-9'"\])](?:\s*\/\/.*)?$/.test(trimmed) && !trimmed.match(/[{(,=>]$/)) noSemis++;

      // Quotes
      const singles = (trimmed.match(/'/g) || []).length;
      const doubles = (trimmed.match(/"/g) || []).length;
      // Skip lines with both (template strings, nested quotes)
      if (singles > 0 && doubles === 0) singleQ++;
      else if (doubles > 0 && singles === 0) doubleQ++;

      // Imports
      if (/^import\s/.test(trimmed)) esmImports++;
      if (/require\s*\(/.test(trimmed)) cjsRequires++;

      // Naming — look at variable/function declarations
      const varMatch = trimmed.match(/(?:const|let|var|function)\s+([a-zA-Z_$][a-zA-Z0-9_$]*)/);
      if (varMatch) {
        const name = varMatch[1];
        if (name.includes('_') && name !== name.toUpperCase()) snake++;
        else if (name[0] === name[0].toUpperCase() && name.length > 1) pascal++;
        else camel++;
      }

      // Trailing commas — check lines before closing brackets
      if (/,\s*$/.test(trimmed)) trailingCommas++;
      if (/[^\s,{[(]\s*$/.test(trimmed)) {
        const nextIdx = lines.indexOf(line) + 1;
        if (nextIdx < lines.length && /^\s*[}\])]/.test(lines[nextIdx])) noTrailingCommas++;
      }
    }
  }

  // Resolve indentation
  if (tabs > spaces2 && tabs > spaces4) style.indent = '\t';
  else if (spaces4 > spaces2) style.indent = '    ';
  else style.indent = '  ';

  // Resolve semicolons
  style.semicolons = semis >= noSemis;

  // Resolve quotes
  style.quotes = doubleQ > singleQ ? 'double' : 'single';

  // Comment density
  const ratio = codeLines > 0 ? commentLines / codeLines : 0;
  if (ratio < 0.02) style.commentDensity = 'none';
  else if (ratio < 0.15) style.commentDensity = 'sparse';
  else style.commentDensity = 'heavy';

  // Naming
  if (snake > camel && snake > pascal) style.namingConvention = 'snake_case';
  else if (pascal > camel) style.namingConvention = 'PascalCase';
  else style.namingConvention = 'camelCase';

  // Imports
  if (esmImports > 0 && cjsRequires === 0) style.importStyle = 'esm';
  else if (cjsRequires > 0 && esmImports === 0) style.importStyle = 'cjs';
  else style.importStyle = 'mixed';

  // Trailing commas
  style.trailingComma = trailingCommas > noTrailingCommas;

  return style;
}

function detectAITells(code) {
  const issues = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Obvious-code comments
    for (const pat of AI_COMMENT_PATTERNS) {
      if (pat.test(trimmed)) {
        issues.push({ line: i + 1, type: 'obvious-comment', text: trimmed });
        break;
      }
    }

    // JSDoc on simple functions (single-line return, etc.)
    if (/^\s*\/\*\*/.test(line)) {
      // Find the end of the JSDoc block
      let j = i;
      while (j < lines.length && !lines[j].includes('*/')) j++;
      const nextCode = j + 1 < lines.length ? lines[j + 1]?.trim() : '';
      // JSDoc before a one-liner or arrow function is usually AI
      if (nextCode && /^(const|let|var)\s+\w+\s*=\s*/.test(nextCode)) {
        issues.push({ line: i + 1, type: 'unnecessary-jsdoc', text: 'JSDoc on simple declaration' });
      }
    }

    // Generic variable names in declarations
    const declMatch = trimmed.match(/(?:const|let|var)\s+(\w+)\s*=/);
    if (declMatch && GENERIC_VAR_NAMES.has(declMatch[1])) {
      issues.push({ line: i + 1, type: 'generic-name', text: `Generic name: ${declMatch[1]}` });
    }

    // Excessive blank lines (3+ in a row)
    if (trimmed === '' && i > 0 && i < lines.length - 1) {
      if (lines[i - 1]?.trim() === '' && lines[i + 1]?.trim() === '') {
        issues.push({ line: i + 1, type: 'excessive-blanks', text: 'Triple+ blank lines' });
      }
    }

    // Overly verbose error messages
    if (/catch\s*\(\w+\)\s*\{/.test(trimmed)) {
      const nextLines = lines.slice(i + 1, i + 4).join(' ');
      if (/console\.(log|error|warn)\s*\(\s*['"`]An error occurred/.test(nextLines) ||
          /console\.(log|error|warn)\s*\(\s*['"`]Failed to/.test(nextLines) ||
          /console\.(log|error|warn)\s*\(\s*['"`]Error:?\s/.test(nextLines)) {
        issues.push({ line: i + 1, type: 'verbose-error', text: 'Overly verbose error message' });
      }
    }

    // Wrapper functions that just call another function
    const fnMatch = trimmed.match(/^(?:async\s+)?function\s+(\w+)\s*\([^)]*\)\s*\{/);
    if (fnMatch) {
      const body = lines.slice(i + 1, i + 4).map(l => l.trim()).filter(l => l && l !== '}');
      if (body.length === 1 && /^return\s/.test(body[0])) {
        issues.push({ line: i + 1, type: 'wrapper-function', text: `Wrapper function: ${fnMatch[1]}` });
      }
    }
  }

  return issues;
}

function stripAndClean(content, style, originalContent) {
  let lines = content.split('\n');

  // Detect original file's indentation to know what to replace
  const origIndent = detectIndent(originalContent || content);

  // Remove comments that restate the code
  lines = lines.filter((line, i) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('//')) return true;

    // Keep comments that are section dividers or contain URLs
    if (/^\/\/\s*[-=]{3,}/.test(trimmed)) return true;
    if (/https?:\/\//.test(trimmed)) return true;
    // Keep eslint/prettier/ts directives
    if (/\/\/\s*(eslint|prettier|@ts-|istanbul|c8|noinspection)/.test(trimmed)) return true;

    // Kill AI-pattern comments
    for (const pat of AI_COMMENT_PATTERNS) {
      if (pat.test(trimmed)) return false;
    }

    // If comment density should be 'none', strip all standalone comments
    if (style.commentDensity === 'none') return false;

    return true;
  });

  // Fix indentation
  const mapped = lines.map(line => {
    if (!line.trim()) return '';
    const match = line.match(/^(\s+)/);
    if (!match) return line;

    const ws = match[1];
    let depth;
    if (origIndent === '\t') {
      depth = ws.split('\t').length - 1;
    } else {
      depth = Math.round(ws.length / (origIndent.length || 2));
    }
    return style.indent.repeat(depth) + line.trimStart();
  });
  lines = mapped;

  // Fix quote style
  const targetQ = style.quotes === 'double' ? '"' : "'";
  const otherQ = style.quotes === 'double' ? "'" : '"';
  lines = lines.map(line => {
    // Don't mess with template literals or lines with both quote types
    if (line.includes('`')) return line;
    // Only swap quotes in simple string literals
    return line.replace(new RegExp(`${escapeRegex(otherQ)}([^${escapeRegex(otherQ)}${escapeRegex(targetQ)}\\\\]*)${escapeRegex(otherQ)}`, 'g'), `${targetQ}$1${targetQ}`);
  });

  // Fix semicolons
  lines = lines.map(line => {
    const trimmed = line.trim();
    // Skip empty, comments, blocks, control flow
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) return line;
    if (/[{(,]$/.test(trimmed) || /^[})\]]/.test(trimmed)) return line;
    if (/^(if|else|for|while|switch|case|default|try|catch|finally|do|class|function)\b/.test(trimmed)) return line;
    if (/^(import|export)\s/.test(trimmed) && !/from\s/.test(trimmed) && !/=/.test(trimmed)) return line;

    if (style.semicolons) {
      // Add semicolons to statement-ending lines that don't have them
      if (/[a-zA-Z0-9'"\])]$/.test(trimmed)) {
        return line + ';';
      }
    } else {
      // Remove trailing semicolons
      if (trimmed.endsWith(';') && !trimmed.endsWith(';;')) {
        return line.slice(0, -1);
      }
    }
    return line;
  });

  // Remove trailing whitespace
  lines = lines.map(line => line.trimEnd());

  // Collapse 3+ blank lines into 2
  const collapsed = [];
  let blankCount = 0;
  for (const line of lines) {
    if (line === '') {
      blankCount++;
      if (blankCount <= 2) collapsed.push(line);
    } else {
      blankCount = 0;
      collapsed.push(line);
    }
  }
  lines = collapsed;

  // Ensure single trailing newline
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  lines.push('');

  return lines.join('\n');
}

function detectIndent(content) {
  const lines = content.split('\n');
  let tabs = 0, spaces = 0, spaceWidths = [];

  for (const line of lines) {
    const match = line.match(/^(\s+)\S/);
    if (!match) continue;
    if (match[1][0] === '\t') tabs++;
    else {
      spaces++;
      spaceWidths.push(match[1].length);
    }
  }

  if (tabs > spaces) return '\t';

  // Find most common space width
  const counts = {};
  for (const w of spaceWidths) {
    // Normalize to likely indent (2 or 4)
    if (w % 4 === 0) counts[4] = (counts[4] || 0) + 1;
    else if (w % 2 === 0) counts[2] = (counts[2] || 0) + 1;
  }
  if ((counts[4] || 0) > (counts[2] || 0)) return '    ';
  return '  ';
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function formatStyleGuide(style) {
  return [
    `Indentation: ${style.indent === '\t' ? 'tabs' : `${style.indent.length} spaces`}`,
    `Semicolons: ${style.semicolons ? 'yes' : 'no'}`,
    `Quotes: ${style.quotes}`,
    `Comment density: ${style.commentDensity}`,
    `Naming: ${style.namingConvention}`,
    `Imports: ${style.importStyle}`,
    `Trailing commas: ${style.trailingComma ? 'yes' : 'no'}`,
  ].join('\n');
}

export async function humanizeCode(changes, repoContext) {
  if (!changes?.length) return changes;

  const existingFiles = repoContext?.existingFileContents || {};
  const style = analyzeRepoStyle(existingFiles);
  const styleGuide = formatStyleGuide(style);

  const humanized = [];

  for (const change of changes) {
    try {
      const original = existingFiles[change.path] || '';

      // Step 1: Mechanical fixes (free, fast)
      let cleaned = stripAndClean(change.content, style, original);

      // Step 2: Check for remaining AI tells
      const tells = detectAITells(cleaned);

      // Skip Claude call if mechanical pass handled everything
      if (tells.length === 0 && !hasSignificantChanges(original, cleaned)) {
        humanized.push({ ...change, content: cleaned });
        continue;
      }

      // Step 3: Claude humanization pass
      const prompt = buildHumanizePrompt(styleGuide, original, cleaned, tells);

      // Truncate to keep costs down — 8k tokens input max
      const truncatedPrompt = prompt.length > 30000 ? prompt.slice(0, 30000) + '\n\n[truncated for length]' : prompt;

      const result = await askClaude(truncatedPrompt, 8192);

      // Claude should return raw file content, no markdown
      let humanContent = result.trim();
      // Strip markdown code fences if Claude ignored the instruction
      if (humanContent.startsWith('```')) {
        humanContent = humanContent.replace(/^```\w*\n?/, '').replace(/\n?```$/, '');
      }

      // Sanity check — if Claude returned something way too short, use mechanical version
      if (humanContent.length < cleaned.length * 0.3) {
        console.warn(`[HUMANIZER] Claude output suspiciously short for ${change.path}, using mechanical clean`);
        humanized.push({ ...change, content: cleaned });
        continue;
      }

      // Ensure trailing newline
      if (!humanContent.endsWith('\n')) humanContent += '\n';

      humanized.push({ ...change, content: humanContent });
    } catch (err) {
      // Don't block the PR — fall through to original
      console.error(`[HUMANIZER] Failed for ${change.path}:`, err.message);
      humanized.push(change);
    }
  }

  return humanized;
}

function hasSignificantChanges(original, cleaned) {
  if (!original) return true;
  // If the diff is large relative to the file, Claude should review it
  const origLines = original.split('\n').length;
  const cleanedLines = cleaned.split('\n').length;
  return Math.abs(origLines - cleanedLines) > origLines * 0.2;
}

function buildHumanizePrompt(styleGuide, original, newContent, tells) {
  const tellsList = tells.length
    ? `\nDETECTED AI PATTERNS (fix these):\n${tells.map(t => `- Line ${t.line}: ${t.type} — ${t.text}`).join('\n')}\n`
    : '';

  return `You are a senior developer who has been contributing to this project for 2 years. You're reviewing a junior's PR and rewriting it to match your personal coding style and the project's conventions.

REPO STYLE:
${styleGuide}

ORIGINAL FILE (before changes):
${original || '(new file)'}

PROPOSED CHANGES:
${newContent}
${tellsList}
RULES:
- Match the existing code style EXACTLY — indentation, quotes, semicolons, naming
- Remove ALL unnecessary comments. Real devs don't comment obvious code.
- Keep the diff as SMALL as possible. Only change what's needed to fix the issue.
- Use variable names that match existing patterns in this file
- Do NOT add try/catch, validation, or error handling unless the existing code does it
- Do NOT add JSDoc, type annotations, or documentation unless the file already has them
- Do NOT refactor or "improve" surrounding code
- If in doubt, be MORE minimal, not less
- The code should look like YOU wrote it, not like an AI did

Return ONLY the file content, nothing else. No markdown, no backticks, no explanation.`;
}

export default humanizeCode;
