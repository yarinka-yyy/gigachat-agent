import { useState, type ReactNode } from 'react';
import { Copy } from 'lucide-react';
import type { ChatArtifact, ChatMessage } from '../contracts';
import { buildTranscriptItems, formatMessageTimestamp, type TranscriptTurn } from '../chat-transcript';
import ChatNavigation from './ChatNavigation';
import TurnActivity from './TurnActivity';

export default function ChatTranscript({
  messages,
  turns,
  artifacts,
  renderAttachments,
  renderTurnActions,
  onCopyMessage,
  onNavigateToMessage,
}: {
  messages: readonly ChatMessage[];
  turns: readonly TranscriptTurn[];
  artifacts: readonly ChatArtifact[];
  renderAttachments?: (message: ChatMessage) => ReactNode;
  renderTurnActions?: (turn: TranscriptTurn) => ReactNode;
  onCopyMessage: (messageId: string) => Promise<void>;
  onNavigateToMessage: (messageId: string, followStream: boolean) => void;
}) {
  const [copyingMessageId, setCopyingMessageId] = useState<string | null>(null);
  const [copyErrorMessageId, setCopyErrorMessageId] = useState<string | null>(null);
  const items = buildTranscriptItems(messages, turns);

  async function copyMessage(messageId: string): Promise<void> {
    setCopyingMessageId(messageId);
    setCopyErrorMessageId(null);
    try {
      await onCopyMessage(messageId);
    } catch {
      setCopyErrorMessageId(messageId);
    } finally {
      setCopyingMessageId((current) => current === messageId ? null : current);
    }
  }

  return (
    <div className="chat-history-layout">
      <ChatNavigation messages={messages} turns={turns} artifacts={artifacts} onNavigate={onNavigateToMessage} />
      <div className="chat-history" aria-label="История сообщений">
        {items.map((item) => {
          if (item.kind === 'activity') {
            return <TurnActivity key={`activity-${item.turn.turnId}`} turn={item.turn}
              actions={renderTurnActions?.(item.turn)} />;
          }
          if (item.kind === 'draft') {
            const endedWithoutAnswer = item.turn.status === 'failed' || item.turn.status === 'cancelled' || item.turn.status === 'interrupted';
            return <article key={`draft-${item.turn.turnId}`} className="transcript-message message-assistant transcript-draft"
              aria-label="Незавершённый ответ">
              <div className="transcript-bubble" aria-live="polite"><p>{item.text}</p>
                {endedWithoutAnswer && <small className="transcript-draft-note">Ответ не сохранён как готовое сообщение.</small>}
              </div>
            </article>;
          }

          const { message } = item;
          const isUser = message.role === 'user';
          const timestamp = isUser ? formatMessageTimestamp(message.createdAt) : null;
          const example = !isUser && message.source !== 'runtime';
          return <article key={`message-${message.id}`} className={`transcript-message message-${message.role}`}
            data-message-id={message.id} aria-label={isUser ? 'Сообщение пользователя' : example ? 'Пример ответа' : 'Ответ'}>
            <div className="transcript-bubble">
              {example && <span className="transcript-example-label">Пример</span>}
              <p>{message.text}</p>
              {renderAttachments?.(message)}
            </div>
            {isUser && <div className="transcript-message-meta">
              {timestamp && <time dateTime={message.createdAt} title={timestamp.title}>{timestamp.time}</time>}
              <button type="button" className="transcript-copy" aria-label="Скопировать сообщение"
                title="Скопировать сообщение" disabled={copyingMessageId === message.id}
                onClick={() => void copyMessage(message.id)}>
                <Copy size={14} aria-hidden="true" />
              </button>
              {copyErrorMessageId === message.id && <span className="transcript-copy-error" role="alert">Не удалось скопировать сообщение.</span>}
            </div>}
          </article>;
        })}
      </div>
    </div>
  );
}
