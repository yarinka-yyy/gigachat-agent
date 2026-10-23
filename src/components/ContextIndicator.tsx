import { useLayoutEffect, useRef, useState } from 'react';
import type { ContextPreviewRequest, ContextPreviewView } from '../contracts';
import ContextRing from './ContextRing';

type PreviewState = { view: ContextPreviewView | null; loading: boolean };

export function getContextIndicatorPresentation(
  view: ContextPreviewView | null,
  loading: boolean,
  unavailableReason?: string,
): { percent: number | null; details: string } {
  if (!view) return { percent: null, details: loading ? 'Оценка рабочего бюджета обновляется.' : unavailableReason ?? 'Полная оценка рабочего бюджета сейчас недоступна; процент не отображается.' };
  if (typeof view !== 'object') return { percent: null, details: 'Ответ оценки некорректен; процент не отображается.' };
  const prompt = view.promptEstimate;
  if (!prompt || !Array.isArray(prompt.unknownReasons)) {
    return { percent: null, details: 'Ответ оценки некорректен; процент не отображается.' };
  }
  if (prompt.unknownReasons.includes('unsupported-model')) {
    return { percent: null, details: 'Для выбранной модели нет проверенного локального профиля оценки.' };
  }
  if (prompt.status !== 'complete' || prompt.provenance !== 'estimated'
    || !Number.isSafeInteger(prompt.tokens) || prompt.tokens! < 0) {
    return { percent: null, details: 'Полная оценка рабочего бюджета недоступна. Частичный итог не показывается.' };
  }
  const budget = view.workingBudget;
  if (!budget || typeof budget !== 'object') {
    return { percent: null, details: 'Рабочий бюджет неизвестен; процент не отображается.' };
  }
  if (budget.status === 'exhausted') {
    return { percent: null, details: 'Рабочий бюджет исчерпан; процент не отображается.' };
  }
  if (budget.status !== 'available' || budget.provenance !== 'estimated'
    || !Number.isSafeInteger(budget.budgetTokens) || budget.budgetTokens! <= 0) {
    return { percent: null, details: 'Рабочий бюджет неизвестен; процент не отображается.' };
  }

  const usedTokens = prompt.tokens!;
  const budgetTokens = budget.budgetTokens!;
  const percent = Math.round(usedTokens / budgetTokens * 100);
  const extrapolated = budget.operationalProfile?.calibrationDomainStatus === 'extrapolated';
  const detail = extrapolated
    ? 'Профиль вышел за проверенный диапазон; неопределённость выше.'
    : 'Это оценка рабочего бюджета, а не подтверждённый размер окна модели.';
  const clampNote = percent > 100 ? ' Кольцо заполнено до 100%.' : '';
  return {
    percent,
    details: `${extrapolated ? 'Оценка рабочего бюджета с экстраполяцией' : 'Оценка рабочего бюджета'}: примерно ${percent.toLocaleString('ru-RU')}% (${usedTokens.toLocaleString('ru-RU')} из ${budgetTokens.toLocaleString('ru-RU')} токенов). ${detail}${clampNote}`,
  };
}

export function createContextPreviewController(
  preview: (request: ContextPreviewRequest) => Promise<ContextPreviewView>,
  publish: (state: PreviewState) => void,
  delayMs = 300,
): { schedule(request: ContextPreviewRequest | null): void; close(): void } {
  let generation = 0;
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let latestPending: { generation: number; request: ContextPreviewRequest } | null = null;

  function pump(): void {
    if (closed || inFlight || !latestPending) return;
    const pending = latestPending;
    latestPending = null;
    inFlight = true;
    void Promise.resolve().then(() => preview(pending.request)).then((view) => {
      if (!closed && pending.generation === generation) publish({ view, loading: false });
    }).catch(() => {
      if (!closed && pending.generation === generation) publish({ view: null, loading: false });
    }).finally(() => {
      inFlight = false;
      pump();
    });
  }

  return {
    schedule(request) {
      closed = false;
      generation += 1;
      const requestGeneration = generation;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latestPending = null;
      publish({ view: null, loading: request !== null });
      if (!request) return;
      timer = setTimeout(() => {
        timer = null;
        if (closed || requestGeneration !== generation) return;
        latestPending = { generation: requestGeneration, request };
        pump();
      }, delayMs);
    },
    close() {
      closed = true;
      generation += 1;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latestPending = null;
    },
  };
}

export default function ContextIndicator({
  request,
  scopeKey,
  unavailableReason,
}: {
  request: ContextPreviewRequest | null;
  scopeKey: object;
  unavailableReason?: string;
}) {
  const [state, setState] = useState<PreviewState>({ view: null, loading: false });
  const controller = useRef<ReturnType<typeof createContextPreviewController> | null>(null);
  if (!controller.current) {
    controller.current = createContextPreviewController(
      (input) => window.gigaChat.context.preview(input),
      setState,
    );
  }

  useLayoutEffect(() => {
    controller.current?.schedule(request);
    return () => controller.current?.close();
  }, [request?.source, request?.source === 'chat' ? request.chatId : null, request?.visibleText, scopeKey]);

  const presentation = getContextIndicatorPresentation(state.view, state.loading, unavailableReason);
  return (
    <span className="context-indicator" role="img" tabIndex={0} aria-label="Контекст следующего запроса" aria-describedby="context-indicator-tooltip">
      <ContextRing percent={presentation.percent === null ? undefined : Math.min(100, presentation.percent)} />
      <span className="context-indicator-tooltip" id="context-indicator-tooltip" role="tooltip">{presentation.details}</span>
    </span>
  );
}
