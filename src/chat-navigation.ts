import type { ChatArtifact, ChatMessage } from './contracts';
import { formatMessageTimestamp, transcriptTurnStatusLabel, type ChatTranscriptItem, type TranscriptTurn } from './chat-transcript';

export interface ChatNavigationMark {
  messageId: string;
  preview: string;
  answer: string | null;
  time: string | null;
  status: string;
  isLatest: boolean;
}

export interface ChatScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function buildChatNavigationMarks(
  items: readonly ChatTranscriptItem[],
  artifacts: readonly ChatArtifact[],
  locale = 'ru-RU',
  timeZone?: string,
): ChatNavigationMark[] {
  type Exchange = { message: ChatMessage; turn?: TranscriptTurn; compaction?: TranscriptTurn; answer: string | null };
  const exchanges: Exchange[] = [];
  const boundAnswers = new Set(items.flatMap((item) =>
    item.kind === 'activity' && item.turn.assistantMessageId ? [item.turn.assistantMessageId] : []));
  let exchange: Exchange | undefined;
  for (const item of items) {
    if (item.kind === 'message' && item.message.role === 'user') {
      exchange = { message: item.message, answer: null };
      exchanges.push(exchange);
    } else if (exchange && item.kind === 'activity') {
      if (item.turn.operation === 'compaction') exchange.compaction = item.turn;
      else {
        exchange.turn = item.turn;
        exchange.answer = null;
      }
    } else if (exchange && item.kind === 'message' && item.message.role === 'assistant') {
      const belongsToExchange = item.turnId
        ? item.turnId === exchange.turn?.turnId
        : !exchange.turn && !boundAnswers.has(item.message.id);
      if (belongsToExchange && exchange.answer === null) exchange.answer = item.message.text.trim() || null;
    }
  }

  return exchanges.map(({ message, turn, compaction, answer }, index) => {
    const linkedNames = (message.attachmentIds ?? []).flatMap((attachmentId) => {
      const artifact = artifacts.find((candidate) => candidate.id === attachmentId && candidate.messageId === message.id);
      return artifact ? [artifact.name] : [];
    });
    const preview = message.text.trim().length > 0
      ? message.text
      : linkedNames.length > 0 ? linkedNames.join(' · ')
        : message.attachmentIds?.length ? 'Вложения недоступны' : 'Запрос без текста';
    const timestamp = formatMessageTimestamp(message.createdAt, locale, timeZone);
    const latest = turn ?? compaction;

    return {
      messageId: message.id,
      preview,
      answer,
      time: timestamp?.time ?? null,
      status: latest ? transcriptTurnStatusLabel(latest) : 'Статус не сохранён',
      isLatest: index === exchanges.length - 1,
    };
  });
}

export function nextChatNavigationIndex(index: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  if (key === 'Home') return 0;
  if (key === 'End') return count - 1;
  if (key === 'ArrowUp') return Math.max(0, Math.min(count - 1, index - 1));
  if (key === 'ArrowDown') return Math.max(0, Math.min(count - 1, index + 1));
  return null;
}

export function isNearChatScrollEnd(metrics: ChatScrollMetrics, threshold = 120): boolean {
  if (![metrics.scrollTop, metrics.scrollHeight, metrics.clientHeight, threshold].every(Number.isFinite)) return false;
  return metrics.scrollHeight - metrics.clientHeight - metrics.scrollTop <= threshold;
}

export function preserveChatScrollAnchor(
  scrollTop: number,
  targetTop: number,
  viewportTop: number,
  savedOffset: number,
): number {
  return Math.max(0, scrollTop + targetTop - viewportTop - savedOffset);
}
