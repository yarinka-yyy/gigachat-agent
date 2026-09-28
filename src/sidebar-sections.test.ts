import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatSummary, Project } from './contracts';
import { sidebarSections } from './sidebar-sections';

test('pinned project chats remain nested and also appear in pins', () => {
  const base = { createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', archived: false };
  const projects = [
    { ...base, id: 'one', name: 'One', pinned: false, workingFolder: 'C:\\one' },
    { ...base, id: 'two', name: 'Two', pinned: true, workingFolder: 'C:\\two' },
  ] satisfies Project[];
  const chats = [
    { ...base, id: 'nested', title: 'Nested', projectId: 'one', pinned: true, kind: 'text' },
    { ...base, id: 'plain', title: 'Plain', projectId: null, pinned: false, kind: 'text' },
    { ...base, id: 'pinned-plain', title: 'Pinned plain', projectId: null, pinned: true, kind: 'text' },
  ] satisfies ChatSummary[];
  const sections = sidebarSections(projects, chats);
  assert.deepEqual(sections.pinnedProjects.map((item) => item.id), ['two']);
  assert.deepEqual(sections.projects.map((item) => item.id), ['one']);
  assert.deepEqual(sections.pinnedChats.map((item) => item.id), ['nested', 'pinned-plain']);
  assert.deepEqual(sections.projectChats('one').map((item) => item.id), ['nested']);
  assert.deepEqual(sections.recentChats.map((item) => item.id), ['plain']);
});
