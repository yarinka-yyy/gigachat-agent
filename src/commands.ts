export interface SkillCommandOption {
  id: string;
  name: string;
  enabled: boolean;
  command?: string;
  scope?: 'global' | 'project';
  projectId?: string | null;
  scopeLabel?: string;
}

export interface ComposerSuggestion {
  id: string;
  label: string;
  insertText: string;
  description: string;
  available: boolean;
  skillId?: string;
}

export interface ComposerCompletion {
  kind: 'command' | 'skill';
  items: ComposerSuggestion[];
  emptyMessage?: string;
}

const commandOptions: readonly ComposerSuggestion[] = [
  {
    id: 'compact',
    label: '/compact',
    insertText: '/compact',
    description: 'Недоступна до проверки качества сводки; история останется без изменений.',
    available: false,
  },
];

function activeToken(value: string, caret: number): { kind: 'command' | 'skill'; token: string; start: number; end: number } | null {
  if (!Number.isSafeInteger(caret) || caret < 0 || caret > value.length) return null;
  let start = caret;
  while (start > 0 && !/\s/.test(value[start - 1] ?? '')) start -= 1;
  const marker = value[start];
  if ((marker !== '/' && marker !== '$') || (start > 0 && !/\s/.test(value[start - 1] ?? ''))) return null;
  let end = caret;
  while (end < value.length && !/\s/.test(value[end] ?? '')) end += 1;
  return { kind: marker === '/' ? 'command' : 'skill', token: value.slice(start, end).toLocaleLowerCase(), start, end };
}

export function getComposerCompletion(
  value: string,
  caret = value.length,
  skills: readonly SkillCommandOption[] = [],
  projectId: string | null = null,
): ComposerCompletion | null {
  const token = activeToken(value, caret);
  if (!token) return null;
  if (token.kind === 'command') {
    const items = commandOptions.filter((option) => option.label.toLocaleLowerCase().startsWith(token.token));
    return { kind: 'command', items, ...(items.length ? {} : { emptyMessage: 'Команда не найдена.' }) };
  }

  const visibleSkills = skills.filter((skill) => skill.enabled
    && (skill.scope === undefined || skill.scope === 'global' || skill.projectId === projectId));
  const items = visibleSkills.filter((skill) => `${skill.name} ${skill.id} ${skill.command ?? ''}`.toLocaleLowerCase().includes(token.token.slice(1)))
    .map((skill) => ({
      id: `skill:${skill.id}`,
      skillId: skill.id,
      label: `$${skill.name}${skill.scopeLabel ? ` · ${skill.scopeLabel}` : ''}`,
      insertText: `$${skill.command ?? skill.id}`,
      description: 'Выбрать Skill для следующего хода.',
      available: true,
    }));
  return {
    kind: 'skill',
    items,
    ...(items.length ? {} : { emptyMessage: visibleSkills.length
      ? 'Подходящий Skill не найден.'
      : 'Локальные Skills пока не обнаружены.' }),
  };
}

export function completeComposerSuggestion(
  value: string,
  caret: number,
  suggestion: ComposerSuggestion,
): { value: string; caret: number } {
  if (!suggestion.available) throw new Error('Эта команда пока недоступна.');
  const token = activeToken(value, caret);
  if (!token) return { value, caret };
  if (suggestion.skillId) {
    const left = value.slice(0, token.start);
    const right = value.slice(token.end);
    const nextRight = /\s$/.test(left) && /^\s/.test(right) ? right.slice(1) : right;
    return { value: `${left}${nextRight}`, caret: left.length };
  }
  const right = value.slice(token.end);
  const insertion = `${suggestion.insertText}${/^\s/.test(right) ? '' : ' '}`;
  const nextValue = `${value.slice(0, token.start)}${insertion}${right}`;
  return { value: nextValue, caret: token.start + insertion.length };
}

export function isUnavailableCompactCommand(value: string): boolean {
  return /^\/compact(?:\s|$)/i.test(value.trimStart());
}
