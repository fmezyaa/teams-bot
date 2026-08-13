import assert from 'assert';
import { toTeamsMarkdown } from './teamsText';

/**
 * Minimal dependency-free test runner (no jest in this repo).
 * Run: npx ts-node --transpile-only src/utils/teamsText.test.ts
 */
const tests: Array<[string, () => Promise<void> | void]> = [];
function test(name: string, fn: () => Promise<void> | void): void {
  tests.push([name, fn]);
}

test('single newline becomes a hard break', () => {
  assert.strictEqual(toTeamsMarkdown('Hey,\nKeine Leerzeile'), 'Hey,  \nKeine Leerzeile');
});

test('one blank line stays one visible blank line', () => {
  assert.strictEqual(toTeamsMarkdown('A\n\nB'), 'A\n\n&nbsp;\n\nB');
});

test('two blank lines stay two — the count is what the author sees', () => {
  assert.strictEqual(toTeamsMarkdown('A\n\n\nB'), 'A\n\n&nbsp;\n\n&nbsp;\n\nB');
});

test('a line of only spaces counts as a blank line', () => {
  assert.strictEqual(toTeamsMarkdown('A\n \nB'), toTeamsMarkdown('A\n\nB'));
  assert.strictEqual(toTeamsMarkdown('A\n\t\nB'), toTeamsMarkdown('A\n\nB'));
});

test('CRLF is treated like LF', () => {
  assert.strictEqual(toTeamsMarkdown('A\r\nB'), toTeamsMarkdown('A\nB'));
  assert.strictEqual(toTeamsMarkdown('A\r\n\r\nB'), toTeamsMarkdown('A\n\nB'));
});

test('a trailing newline does not add a dangling break', () => {
  assert.strictEqual(toTeamsMarkdown('A\n'), 'A\n');
});

test('text without newlines is untouched', () => {
  assert.strictEqual(toTeamsMarkdown('nur eine Zeile'), 'nur eine Zeile');
});

test('empty input is returned as is', () => {
  assert.strictEqual(toTeamsMarkdown(''), '');
});

test('markdown the author wrote survives (lists, bold)', () => {
  const input = '**Fett**\n- Punkt 1\n- Punkt 2';
  // List items keep their own lines via the hard break; the markers stay intact.
  assert.ok(toTeamsMarkdown(input).includes('- Punkt 1'));
  assert.ok(toTeamsMarkdown(input).includes('**Fett**'));
});

test("Felix' Testvorlage: jede Variante behaelt ihre Leerzeilen", () => {
  const vorlage = [
    'Hey,',
    'Keine Leerzeile',
    '',
    'Eine Leerzeile',
    '',
    '',
    'Zwei Leerzeilen',
  ].join('\n');

  const out = toTeamsMarkdown(vorlage);

  // "Hey," und "Keine Leerzeile" bleiben getrennt
  assert.ok(out.startsWith('Hey,  \nKeine Leerzeile'));
  // eine Leerzeile -> ein &nbsp;, zwei Leerzeilen -> zwei &nbsp;
  assert.strictEqual((out.match(/&nbsp;/g) ?? []).length, 3);
  assert.ok(out.includes('&nbsp;\n\n&nbsp;\n\nZwei Leerzeilen'));
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      console.log(`  ok  - ${name}`);
    } catch (err) {
      failed++;
      console.error(`  FAIL - ${name}`);
      console.error(err);
    }
  }
  console.log(`\nteamsText: ${tests.length - failed}/${tests.length} passed`);
  if (failed > 0) process.exit(1);
})();
