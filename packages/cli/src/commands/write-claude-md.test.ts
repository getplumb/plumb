import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateClaudeMd } from './write-claude-md.js';

test('creates new CLAUDE.md content when no existing content', () => {
  const result = updateClaudeMd(undefined);

  assert.ok(result.includes('<!-- plumb:managed -->'), 'Should include start marker');
  assert.ok(result.includes('<!-- /plumb:managed -->'), 'Should include end marker');
  assert.ok(result.includes('# Plumb Memory Integration'), 'Should include section title');
  assert.ok(result.includes('memory_search'), 'Should mention memory_search tool');
  assert.ok(result.includes('memory_store'), 'Should mention memory_store tool');
  assert.ok(result.includes('REQUIRED BEHAVIOR'), 'Should include prescriptive language');
});

test('appends Plumb section to existing content without markers', () => {
  const existing = '# My Project\n\nSome existing instructions.\n';
  const result = updateClaudeMd(existing);

  assert.ok(result.startsWith('# My Project'), 'Should preserve existing content');
  assert.ok(result.includes('Some existing instructions'), 'Should preserve existing instructions');
  assert.ok(result.includes('<!-- plumb:managed -->'), 'Should include start marker');
  assert.ok(result.includes('# Plumb Memory Integration'), 'Should append Plumb section');

  // Should add proper spacing
  const existingEndIndex = result.indexOf('<!-- plumb:managed -->');
  const beforeMarker = result.substring(0, existingEndIndex);
  assert.ok(beforeMarker.includes('Some existing instructions'), 'Should have content before marker');
});

test('replaces content between markers when they exist', () => {
  const existing = `# My Project

Some instructions.

<!-- plumb:managed -->
# Old Plumb Section
This should be replaced.
<!-- /plumb:managed -->

More instructions.
`;

  const result = updateClaudeMd(existing);

  assert.ok(result.includes('# My Project'), 'Should preserve content before marker');
  assert.ok(result.includes('More instructions'), 'Should preserve content after marker');
  assert.ok(result.includes('# Plumb Memory Integration'), 'Should include new Plumb section');
  assert.ok(!result.includes('Old Plumb Section'), 'Should remove old content');
  assert.ok(!result.includes('This should be replaced'), 'Should remove old content');

  // Should only have one set of markers
  const startCount = (result.match(/<!-- plumb:managed -->/g) || []).length;
  const endCount = (result.match(/<!-- \/plumb:managed -->/g) || []).length;
  assert.equal(startCount, 1, 'Should have exactly one start marker');
  assert.equal(endCount, 1, 'Should have exactly one end marker');
});

test('handles malformed markers by appending (start marker only)', () => {
  const existing = `# My Project

<!-- plumb:managed -->
Some incomplete section
`;

  const result = updateClaudeMd(existing);

  // Since end marker is missing, should append
  assert.ok(result.includes('# My Project'), 'Should preserve existing content');
  assert.ok(result.includes('Some incomplete section'), 'Should preserve incomplete section');

  // Should have the new complete section appended
  const lastStartMarker = result.lastIndexOf('<!-- plumb:managed -->');
  const afterLastMarker = result.substring(lastStartMarker);
  assert.ok(afterLastMarker.includes('# Plumb Memory Integration'), 'Should append new section');
  assert.ok(afterLastMarker.includes('<!-- /plumb:managed -->'), 'Should have end marker in new section');
});

test('handles malformed markers by appending (end marker only)', () => {
  const existing = `# My Project

Some content
<!-- /plumb:managed -->
`;

  const result = updateClaudeMd(existing);

  // Since start marker is missing, should append
  assert.ok(result.includes('# My Project'), 'Should preserve existing content');

  // Should have complete section appended
  assert.ok(result.includes('<!-- plumb:managed -->'), 'Should have start marker in new section');
  assert.ok(result.includes('# Plumb Memory Integration'), 'Should append new section');
});

test('handles markers in wrong order by appending', () => {
  const existing = `# My Project

<!-- /plumb:managed -->
Some content
<!-- plumb:managed -->
`;

  const result = updateClaudeMd(existing);

  // Since markers are in wrong order (end before start), should append
  assert.ok(result.includes('# My Project'), 'Should preserve existing content');

  // Should have complete section appended at the end
  const lastStartMarker = result.lastIndexOf('<!-- plumb:managed -->');
  const afterLastMarker = result.substring(lastStartMarker);
  assert.ok(afterLastMarker.includes('# Plumb Memory Integration'), 'Should append new section');
  assert.ok(afterLastMarker.includes('<!-- /plumb:managed -->'), 'Should have end marker in new section');
});

test('preserves spacing when appending to content with trailing newline', () => {
  const existing = '# My Project\n\nSome content.\n';
  const result = updateClaudeMd(existing);

  assert.ok(result.includes('Some content.\n'), 'Should preserve existing content');
  assert.ok(!result.includes('\n\n\n\n'), 'Should not have excessive newlines');
});

test('adds spacing when appending to content without trailing newline', () => {
  const existing = '# My Project\n\nSome content.';
  const result = updateClaudeMd(existing);

  assert.ok(result.includes('Some content.'), 'Should preserve existing content');
  assert.ok(result.includes('<!-- plumb:managed -->'), 'Should append section');

  // Should have proper spacing added
  const contentIndex = result.indexOf('Some content.');
  const markerIndex = result.indexOf('<!-- plumb:managed -->');
  const between = result.substring(contentIndex + 'Some content.'.length, markerIndex);
  assert.ok(between.includes('\n'), 'Should add newlines for spacing');
});

test('produces idempotent output', () => {
  const initial = '# My Project\n\nSome content.\n';
  const firstRun = updateClaudeMd(initial);
  const secondRun = updateClaudeMd(firstRun);
  const thirdRun = updateClaudeMd(secondRun);

  assert.equal(firstRun, secondRun, 'Second run should produce same output as first');
  assert.equal(secondRun, thirdRun, 'Third run should produce same output as second');

  // Should still only have one Plumb section
  const startCount = (thirdRun.match(/<!-- plumb:managed -->/g) || []).length;
  assert.equal(startCount, 1, 'Should have exactly one Plumb section after multiple runs');
});
