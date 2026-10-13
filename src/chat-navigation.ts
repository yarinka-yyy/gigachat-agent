import type { ChatArtifact, ChatMessage, ChatTurnRecord } from './contracts';
import { formatMessageTimestamp, transcriptTurnStatusLabel, type TranscriptTurn } from './chat-transcript';

export interface ChatNavigationMark {
  messageId: string;
  preview: string;
  time: string | null;
  date: string | null;
  status: string;
  isLatest: boolean;
}

export interface ChatScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function buildChatNavigationMarks(
  messages: readonly ChatMessage[],
  turns: readonly ChatTurnRecord[],
  artifacts: readonly ChatArtifact[],
  locale = 'ru-RU',
  timeZone?: string,
): ChatNavigationMark[] {
  const userMessages = messages.filter((message) => message.role === 'user');
  const userMessageIds = new Set(userMessages.map((message) => message.id));
  const latestTurnByAnchor = new Map<string, ChatTurnRecord>();
  for (const turn of turns) {
    if (!userMessageIds.has(turn.anchorMessageId)) continue;
    const previous = latestTurnByAnchor.get(turn.anchorMessageId);
    if (!previous || turn.createdAt.localeCompare(previous.createdAt) >= 0) {
      latestTurnByAnchor.set(turn.anchorMessageId, turn);
    }
  }

  return userMessages.map((message, index) => {
    const linkedNames = (message.attachmentIds ?? []).flatMap((attachmentId) => {
      const artifact = artifacts.find((candidate) => candidate.id === attachmentId && candidate.messageId === message.id);
      return artifact ? [artifact.name] : [];
    });
    const preview = message.text.trim().length > 0
      ? message.text
      : linkedNames.length > 0 ? linkedNames.join(' · ')
        : message.attachmentIds?.length ? 'Вложения недоступны' : 'Запрос без текста';
    const timestamp = formatMessageTimestamp(message.createdAt, locale, timeZone);
    const turn = latestTurnByAnchor.get(message.id);
    const status = turn
      ? transcriptTurnStatusLabel({ ...turn, id: turn.turnId, chatId: '' } satisfies TranscriptTurn)
      : 'Статус не сохранён';

    return {
      messageId: message.id,
      preview,
      time: timestamp?.time ?? null,
      date: timestamp?.title ?? null,
      status,
      isLatest: index === userMessages.length - 1,
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
