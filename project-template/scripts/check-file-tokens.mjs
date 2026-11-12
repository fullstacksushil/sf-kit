// From sf-kit. Fails when a file is too big for an agent to read and edit in one go.
// Tokens are estimated as bytes / 4, which is close enough for code.
// Usage: node scripts/check-file-tokens.mjs <file>...  (the pre-commit hook passes the staged files)

import { existsSync, lstatSync, readFileSync } from "node:fs";

const MAX_TOKENS = 5000;
const BYTES_PER_TOKEN = 4;

// Lock files and images nobody edits by hand, and workflow files, which GitHub reads as one file each.
const IGNORED = [/(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/, /\.svg$/, /^\.github\/workflows\/[^/]+\.ya?ml$/];

const oversized = process.argv
  .slice(2)
  .filter((file) => !IGNORED.some((pattern) => pattern.test(file)) && existsSync(file) && lstatSync(file).isFile())
  .map((file) => ({ file, contents: readFileSync(file) }))
  .filter(({ contents }) => !contents.subarray(0, 8000).includes(0)) // binary
  .map(({ file, contents }) => ({ file, tokens: Math.ceil(contents.length / BYTES_PER_TOKEN) }))
  .filter(({ tokens }) => tokens > MAX_TOKENS);

if (oversized.length > 0) {
  console.error(`These files are over ${MAX_TOKENS} tokens (bytes / 4):\n`);
  for (const { file, tokens } of oversized) console.error(`  ${file}: ~${tokens} tokens`);
  console.error(`
Split each file before you commit. Do not delete code or squash it onto fewer lines.
Find the seams: groups of functions, components or tests that change together and share
little with the rest. Move each group to its own file. Split tests by the behaviour under test.
Then commit again.`);
  process.exit(1);
}
