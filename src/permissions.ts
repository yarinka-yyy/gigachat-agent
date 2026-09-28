import type { CustomPolicy, LocalAction } from './custom-permissions';

export type PermissionProfile = 'ask' | 'approve' | 'full' | 'custom';
export type PermissionResource = 'project-files' | 'machine-files' | 'process' | 'network' | 'browser' | 'application';
export type PermissionAction = 'list' | 'search' | 'read' | 'write' | 'open' | 'execute' | 'connect';

export interface PermissionRequest {
  profile: PermissionProfile;
  resource: PermissionResource;
  action: PermissionAction;
  projectId: string | null;
  /** Main resolves the requested target's canonical path to a project before calling this policy. */
  targetProjectId: string | null;
  targetRootName?: string | null;
  capabilityAvailable: boolean;
  customPolicy?: CustomPolicy | null;
}

export interface PermissionEvaluation {
  decision: 'allow' | 'ask' | 'deny';
  reason: string;
}

const profiles: readonly PermissionProfile[] = ['ask', 'approve', 'full', 'custom'];
const resources: readonly PermissionResource[] = ['project-files', 'machine-files', 'process', 'network', 'browser', 'application'];
const actions: readonly PermissionAction[] = ['list', 'search', 'read', 'write', 'open', 'execute', 'connect'];
const allowedActions: Record<PermissionResource, readonly PermissionAction[]> = {
  'project-files': ['list', 'search', 'read', 'write', 'open'],
  'machine-files': ['list', 'search', 'read', 'write', 'open'],
  process: ['execute'],
  network: ['connect'],
  browser: ['open', 'connect'],
  application: ['open', 'execute'],
};

export function isPermissionProfile(value: unknown): value is PermissionProfile {
  return typeof value === 'string' && profiles.includes(value as PermissionProfile);
}

export function requirePermissionProfile(value: unknown): PermissionProfile {
  if (!isPermissionProfile(value)) throw new Error('Неизвестный профиль разрешений.');
  return value;
}

function isProjectAction(resource: PermissionResource): boolean {
  return resource === 'project-files' || resource === 'process' || resource === 'application';
}

export function evaluatePermission(request: PermissionRequest): PermissionEvaluation {
  const profile = requirePermissionProfile(request.profile);
  if (typeof request.capabilityAvailable !== 'boolean'
    || !isProjectId(request.projectId) || !isProjectId(request.targetProjectId)) {
    throw new Error('Некорректный запрос разрешения.');
  }
  if (typeof request.resource !== 'string' || !resources.includes(request.resource)
    || typeof request.action !== 'string' || !actions.includes(request.action)
    || !allowedActions[request.resource].includes(request.action)) {
    return { decision: 'deny', reason: 'Такое действие для указанного ресурса не поддерживается.' };
  }

  if (!request.capabilityAvailable) {
    return { decision: 'deny', reason: 'Инструмент для этого действия пока недоступен.' };
  }
  if (profile === 'custom') {
    if (!request.customPolicy) return { decision: 'deny', reason: 'Конфигурация пользовательского профиля недоступна.' };
    const root = request.targetRootName
      ? request.customPolicy.roots.find((item) => item.name === request.targetRootName) : null;
    if (request.targetRootName && !root) return { decision: 'deny', reason: 'Каталог не указан в config.toml.' };
    if (!root && (!request.projectId || request.targetProjectId !== request.projectId)) {
      return { decision: 'deny', reason: 'Действие не относится к проекту текущего чата.' };
    }
    if (!isProjectAction(request.resource)) return { decision: 'deny', reason: 'Для этого ресурса пока нет локального инструмента.' };
    const decision = (root?.rules ?? request.customPolicy.project)[request.action as LocalAction];
    return { decision: decision ?? 'deny', reason: decision === 'ask'
      ? 'Пользовательский профиль требует вашего подтверждения.'
      : decision === 'allow' ? 'Разрешено пользовательским профилем.' : 'Запрещено пользовательским профилем.' };
  }
  if (request.targetRootName) return { decision: 'deny', reason: 'Дополнительные каталоги доступны только пользовательскому профилю.' };
  if (isProjectAction(request.resource)
    && (!request.projectId || request.targetProjectId !== request.projectId)) {
    return { decision: 'deny', reason: 'Действие не относится к проекту текущего чата.' };
  }
  if (profile === 'full') {
    return { decision: 'allow', reason: 'Действие разрешено выбранным профилем Full access.' };
  }
  if (isProjectAction(request.resource)) {
    return { decision: 'allow', reason: 'Действие остаётся внутри проверенной границы проекта.' };
  }
  if (profile === 'approve') {
    return { decision: 'ask', reason: 'Автоматическая проверка этого действия ещё не настроена; требуется подтверждение.' };
  }
  return { decision: 'ask', reason: 'Действие выходит за проверенную границу проекта; требуется подтверждение.' };
}

function isProjectId(value: unknown): value is string | null {
  return value === null || (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value));
}
