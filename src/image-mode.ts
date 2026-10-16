import type { ChatKind, ChatMessage } from './contracts';

export const IMAGE_GENERATION_MODEL_ID = 'GigaChat-3-Ultra' as const;

export function imageChatModelBlocker(kind: ChatKind, modelId: string | null): string | null {
  if (kind !== 'image' || modelId === IMAGE_GENERATION_MODEL_ID) return null;
  return 'Для нового запроса в чате изображений выберите GigaChat Ultra.';
}

export function imageChatAttachmentBlocker(kind: ChatKind, attachmentCount: number): string | null {
  if (kind !== 'image' || attachmentCount === 0) return null;
  return 'Чат изображений принимает только текстовое описание. Уберите файлы из черновика.';
}

export function imageChatHistoryBlocker(kind: ChatKind, messages: readonly ChatMessage[]): string | null {
  if (kind !== 'image' || !messages.some((message) => message.role === 'user' && (message.attachmentIds?.length ?? 0) > 0)) return null;
  return 'В этом чате есть прежние вложения. Создайте новый чат изображений, чтобы отправить только описание.';
}

export function imageChatPromptBlocker(kind: ChatKind, text: string): string | null {
  if (kind !== 'image' || text.trim().length > 0) return null;
  return 'Добавьте описание изображения.';
}

export function imageChatRequestBlocker(
  kind: ChatKind,
  modelId: string | null,
  text: string,
  attachmentCount: number,
): string | null {
  return imageChatModelBlocker(kind, modelId)
    ?? imageChatAttachmentBlocker(kind, attachmentCount)
    ?? imageChatPromptBlocker(kind, text);
}
