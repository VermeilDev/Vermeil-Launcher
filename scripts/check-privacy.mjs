#!/usr/bin/env node
// SPDX-FileCopyrightText: 2026 VermeilDev
// SPDX-License-Identifier: GPL-3.0-or-later

// scripts/check-privacy.mjs [--staged]
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';

const staged = process.argv.includes('--staged');
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 1 << 28 });
  } catch (err) {
    console.error('Git execution failed:', err.message);
    process.exit(1);
  }
};

const rawFiles = staged
  ? git('diff', '--cached', '--name-only', '--diff-filter=ACMR')
  : git('ls-files');

const files = rawFiles.split(/\r?\n/).filter(Boolean);

const SAFE = /^(?:username|user|you|yourname|example|public|default|runner|test|\.{2,}|<[^>]*>|%[^%]*%|\$\{?\w+\}?|\{\w+\})$/i;
const RULES = [
  // Path & Environment Leaks
  { id: 'windows-user-path',   re: /[A-Za-z]:[\\/]+Users[\\/]+([^\\/\s"'<>|*?`\),;]+)/gi, group: true },
  { id: 'macos-user-path',     re: /(?:^|[^\w.])\/Users\/([^/\s"'<>`\),;]+)/g,           group: true },
  { id: 'linux-home-path',     re: /(?:^|[^\w.])\/home\/([^/\s"'<>`\),;]+)/g,            group: true },
  { id: 'file-uri',            re: /file:\/\/\/?[^\s)"']+/gi },
  { id: 'ide-uri',             re: /\b(?:vscode|cursor|antigravity|idea):\/\/file\/[^\s)"']+/gi },

  // Secret, Token & Private Key Leaks
  { id: 'private-key',         re: /(?:BEGIN|END) (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY/gi },
  { id: 'minisign-secret-key', re: /untrusted comment: minisign secret key/gi },
  { id: 'github-token',        re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{82}\b/g },
  { id: 'google-oauth-secret', re: /\bGOCSPX-[A-Za-z0-9_-]{28}\b/g },
  { id: 'google-api-key',      re: /\bAIza[0-9A-Za-z\-_]{35}\b/g },
  { id: 'discord-token',       re: /\b[MNO][a-zA-Z\d_-]{23,25}\.[a-zA-Z\d_-]{6}\.[a-zA-Z\d_-]{27}\b/g },
  { id: 'aws-access-key',      re: /\b(?:AKIA|ABIA|ACCA|ASIA)[0-9A-Z]{16}\b/g },
];

const denylist = [
  process.env.PRIVACY_DENYLIST ?? '',
  existsSync('.git/privacy-denylist') ? readFileSync('.git/privacy-denylist', 'utf8') : '',
]
  .join('\n')
  .split(/\r?\n/)
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

let violations = 0;
const report = (file, lineNum, ruleId, snippet) => {
  violations++;
  console.error(`[PRIVACY VIOLATION] ${file}:${lineNum} [${ruleId}] ${snippet}`);
};

for (const file of files) {
  // Skip scanner script itself to prevent regex definitions from triggering false self-positives
  if (file === 'scripts/check-privacy.mjs') continue;

  // Skip binary extensions
  if (/\.(png|jpg|jpeg|gif|ico|icns|jar|exe|dll|zip|tar|gz|webp)$/i.test(file)) continue;

  let content;
  try {
    content = staged ? git('show', `:${file}`) : readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  if (content.includes('\0')) continue; // Skip binary content

  const lines = content.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('privacy:allow')) continue;

    for (const rule of RULES) {
      for (const match of line.matchAll(rule.re)) {
        if (!(rule.group && SAFE.test(match[1]))) {
          report(file, i + 1, rule.id, match[0].slice(0, 80));
        }
      }
    }

    const lowerLine = line.toLowerCase();
    for (const deny of denylist) {
      if (lowerLine.includes(deny)) {
        report(file, i + 1, 'personal-denylist', '[REDACTED]');
      }
    }
  }
}

if (violations > 0) {
  console.error(`\nPrivacy check FAILED: ${violations} violation(s) found.`);
  process.exit(1);
} else {
  console.log(`Privacy check PASSED: All ${files.length} files clean.`);
}
