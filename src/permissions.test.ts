import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluatePermission, type PermissionAction, type PermissionResource } from './permissions';

test('allows verified project work and bounded process execution', () => {
  for (const resource of ['project-files', 'process'] as const) {
    const result = evaluatePermission({
      profile: 'ask', resource, action: resource === 'process' ? 'execute' : 'write',
      projectId: 'project-1', targetProjectId: 'project-1', capabilityAvailable: true,
    });
    assert.equal(result.decision, 'allow');
    assert.match(result.reason, /границ/);
  }
});

test('asks before escalation and does not claim automatic approval is configured', () => {
  const result = evaluatePermission({
    profile: 'approve', resource: 'machine-files', action: 'read',
    projectId: 'project-1', targetProjectId: null, capabilityAvailable: true,
  });
  assert.equal(result.decision, 'ask');
  assert.match(result.reason, /Автоматическая проверка.*не настроена/);
});

test('denies unavailable, custom, and malformed permission requests', () => {
  assert.equal(evaluatePermission({
    profile: 'full', resource: 'process', action: 'execute',
    projectId: 'project-1', targetProjectId: 'project-1', capabilityAvailable: false,
  }).decision, 'deny');
  assert.equal(evaluatePermission({
    profile: 'custom', resource: 'project-files', action: 'read',
    projectId: 'project-1', targetProjectId: 'project-1', capabilityAvailable: true,
  }).decision, 'deny');
  assert.equal(evaluatePermission({
    profile: 'full', resource: 'unknown', action: 'read',
    projectId: 'project-1', targetProjectId: 'project-1', capabilityAvailable: true,
  } as never).decision, 'deny');
  assert.equal(evaluatePermission({
    profile: 'full', resource: 'project-files', action: 'execute',
    projectId: 'project-1', targetProjectId: 'project-1', capabilityAvailable: true,
  } as never).decision, 'deny');
});

test('denies a target resolved to a sibling project', () => {
  const result = evaluatePermission({
    profile: 'ask', resource: 'project-files', action: 'read',
    projectId: 'project-1', targetProjectId: 'project-2', capabilityAvailable: true,
  });
  assert.equal(result.decision, 'deny');
  assert.match(result.reason, /не относится к проекту/);
});

test('Full allows every available supported action without a project binding', () => {
  const supported: Array<[PermissionResource, PermissionAction]> = [
    ['project-files', 'list'], ['project-files', 'search'], ['project-files', 'read'],
    ['project-files', 'write'], ['project-files', 'open'],
    ['machine-files', 'list'], ['machine-files', 'search'], ['machine-files', 'read'],
    ['machine-files', 'write'], ['machine-files', 'open'],
    ['process', 'execute'], ['network', 'connect'], ['browser', 'open'], ['browser', 'connect'],
    ['application', 'open'], ['application', 'execute'],
  ];
  for (const [resource, action] of supported) {
    assert.equal(evaluatePermission({
      profile: 'full', resource, action,
      projectId: null, targetProjectId: null, capabilityAvailable: true,
    }).decision, 'allow', `${resource}/${action}`);
  }
  assert.equal(evaluatePermission({
    profile: 'full', resource: 'project-files', action: 'read',
    projectId: 'project-1', targetProjectId: 'project-2', capabilityAvailable: true,
  }).decision, 'allow');
});

test('Ask and Approve keep exact external actions behind manual approval', () => {
  for (const profile of ['ask', 'approve'] as const) {
    const result = evaluatePermission({
      profile, resource: 'network', action: 'connect',
      projectId: 'project-1', targetProjectId: null, capabilityAvailable: true,
    });
    assert.equal(result.decision, 'ask');
    if (profile === 'approve') assert.match(result.reason, /Автоматическая проверка.*не настроена/);
  }
  assert.equal(evaluatePermission({
    profile: 'ask', resource: 'project-files', action: 'read',
    projectId: 'project-1', targetProjectId: null, capabilityAvailable: true,
  }).decision, 'ask');
});
