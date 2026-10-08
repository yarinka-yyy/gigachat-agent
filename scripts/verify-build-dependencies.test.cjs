const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const braces = require('braces');

test('braces bounds hostile string and AST depth before recursive walkers', () => {
  for (const input of [
    '{'.repeat(4500) + 'a,b' + '}'.repeat(4500),
    '('.repeat(4500) + 'a,b' + ')'.repeat(4500),
    '{('.repeat(2400) + 'a,b' + ')}'.repeat(2400),
  ]) {
    for (const method of [braces, braces.parse, braces.compile, braces.expand, braces.stringify]) {
      assert.throws(() => method(input), { name: 'SyntaxError', message: 'Brace pattern nesting exceeds 100 levels' });
    }
  }
  let ast = { type: 'text', value: 'x', nodes: [] };
  for (let i = 0; i < 4500; i++) ast = { type: 'paren', nodes: [ast] };
  for (const method of [braces.compile, braces.expand, braces.stringify]) {
    assert.throws(() => method(ast), { name: 'SyntaxError', message: 'Brace pattern nesting exceeds 100 levels' });
  }
});

test('braces preserves normal glob, quoted, escaped, range and boundary patterns', () => {
  assert.deepEqual(braces.expand('a/{b,c}/{1..3}'), ['a/b/1', 'a/b/2', 'a/b/3', 'a/c/1', 'a/c/2', 'a/c/3']);
  assert.equal(braces.compile('a/{b,c}/d'), 'a/(b|c)/d');
  assert.equal(braces.stringify('a/{b,c}/d'), 'a/{b,c}/d');
  assert.equal(braces.compile('\\{literal\\}'), '{literal}');
  assert.equal(braces.compile('"' + '{'.repeat(200) + '"'), '{'.repeat(200));
  assert.equal(braces.compile('[' + '{'.repeat(200) + ']'), '[' + '{'.repeat(200) + ']');
  const boundary = '('.repeat(100) + 'a' + ')'.repeat(100);
  assert.equal(braces.compile(boundary), boundary);
  assert.throws(() => braces.compile('('.repeat(101) + 'a' + ')'.repeat(101)), /nesting exceeds 100 levels/);
  assert.deepEqual(require('micromatch')(['a.js', 'a.ts', 'b.css'], '*.{js,ts}'), ['a.js', 'a.ts']);
});

test('source-map-js rejects malicious offsets within bounded time and memory', () => {
  const libraryPath = require.resolve('source-map-js');
  const code = `
    const assert = require('node:assert/strict');
    const { SourceMapConsumer, SourceNode } = require(${JSON.stringify(libraryPath)});
    const flat = { version: 3, sources: ['a.js'], sourcesContent: ['x'], names: [], mappings: 'AAAA' };
    for (const line of [1e9, -1, 0.5, Infinity]) {
      assert.throws(() => {
        const consumer = new SourceMapConsumer({ version: 3, sections: [{ offset: { line, column: 0 }, map: flat }] });
        SourceNode.fromStringWithSourceMap('x', consumer);
      }, /Section offset/);
    }
    assert.equal(SourceNode.fromStringWithSourceMap('x', new SourceMapConsumer(flat)).toString(), 'x');
    const indexed = new SourceMapConsumer({ version: 3, sections: [{ offset: { line: 4, column: 0 }, map: flat }] });
    assert.equal(SourceNode.fromStringWithSourceMap('x', indexed).toString(), 'x');
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=64', '-e', code], {
    cwd: path.resolve(__dirname, '..'), timeout: 2000, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
});
