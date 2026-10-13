import type { ReactNode } from 'react';
import type { ProviderErrorCategory, RuntimeActivity } from '../contracts';
import { formatElapsedDuration, hookEventLabel, transcriptTurnStatusLabel, type TranscriptTurn } from '../chat-transcript';

const errorLabels: Record<ProviderErrorCategory, string> = {
  auth: 'Авторизация', tls: 'TLS', network: 'Сеть', 'rate-limit': 'Лимит запросов', quota: 'Квота',
  model: 'Модель', context: 'Контекст', protocol: 'Протокол', tool: 'Локальный инструмент',
  storage: 'Сохранение', cancel: 'Отмена',
};

function activityLabel(activity: RuntimeActivity): string {
  const toolNames = {
    list: 'Список файлов', search: 'Поиск', read: 'Чтение файла', write: 'Запись файла', open: 'Открытие', powershell: 'PowerShell',
  } as const;
  const providerToolName = (tool: string | undefined) => tool && Object.prototype.hasOwnProperty.call(toolNames, tool)
    ? toolNames[tool as keyof typeof toolNames]
    : 'Локальный инструмент';
  if (activity.kind === 'tool') {
    const phases: Record<typeof activity.phase, string> = {
      started: 'запущен', completed: 'завершён', failed: 'ошибка', cancelled: 'отменён',
    };
    const duration = formatElapsedDuration(activity.durationMs);
    return `${toolNames[activity.tool]}: ${phases[activity.phase]}${duration ? ` · ${duration}` : ''}`;
  }
  if (activity.kind === 'hook') {
    const status = activity.status === 'completed' ? 'завершён'
      : activity.status === 'blocked' ? 'заблокирован'
        : activity.status === 'skipped' ? 'пропущен'
          : activity.status === 'cancelled' ? 'отменён' : 'ошибка';
    return `Сценарий ${activity.hookName} · ${hookEventLabel(activity.event)} · ${status}${activity.reason ? ` — ${activity.reason}` : ''}`;
  }
  if (activity.activity === 'function-progress') {
    const name = activity.functionName === 'get_file_content' ? 'Чтение вложения' : 'Обработка изображения';
    return activity.detail ? `${name}: ${activity.detail}` : name;
  }
  const labels: Record<typeof activity.activity, string> = {
    connecting: 'Подключение к GigaChat', receiving: 'Получение ответа', 'waiting-for-tool': 'Ожидание инструмента',
    'tool-started': activity.tool ? `Запуск: ${providerToolName(activity.tool)}` : 'Запуск инструмента',
    'tool-finished': activity.tool ? `Завершён: ${providerToolName(activity.tool)}` : 'Инструмент завершён',
  };
  return labels[activity.activity];
}

export default function TurnActivity({
  turn,
  actions,
}: {
  turn: TranscriptTurn;
  actions?: ReactNode;
}) {
  const reason = turn.errorCategory ? errorLabels[turn.errorCategory] : null;
  const queueDuration = formatElapsedDuration(turn.queueDurationMs);
  return (
    <section className="turn-activity" data-turn-id={turn.turnId} aria-label={turn.operation === 'compaction' ? 'Обновление контекста' : 'Состояние запроса'}>
      <details className="turn-activity-details" open={turn.status === 'queued' || turn.status === 'running'}>
        <summary className="turn-activity-summary">
          <span className={`turn-activity-status status-${turn.status}`}>{transcriptTurnStatusLabel(turn)}</span>
          {turn.operation === 'compaction' && <span className="turn-activity-operation">Сжатие контекста</span>}
          {reason && <span className="turn-activity-reason">Причина: {reason}</span>}
        </summary>
        <div className="turn-activity-body">
          {queueDuration && <p className="turn-activity-queue">Ожидание в очереди · {queueDuration}</p>}
          {turn.activity.length > 0 && <ul className="turn-activity-list">
            {turn.activity.map((activity, index) => <li key={`${turn.turnId}-${index}`}>{activityLabel(activity)}</li>)}
          </ul>}
          {turn.error && <p className="turn-activity-error" role="alert">{turn.error}</p>}
        </div>
      </details>
      {actions && <div className="turn-activity-actions">{actions}</div>}
    </section>
  );
}
