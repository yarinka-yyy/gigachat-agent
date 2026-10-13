import { basicAgentWorkflowStatus, getModelCapabilities } from './model-capabilities';
import type { HomeDraftAttachment, ModelRegistrySnapshot, ProviderConnectionSnapshot } from './contracts';
import { chatModelUnavailableReason } from './model-catalog';

export const LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES = 25 * 1024 * 1024;
export const PROVIDER_IMAGE_LIMIT_BYTES = 15_000_000;
export const PROVIDER_MEDIA_LIMIT_BYTES = 80_000_000;
export const PROVIDER_REQUEST_LIMIT_BYTES = 2 * 1024 * 1024;

export function attachmentConnectionBlocker(
  connection: Pick<ProviderConnectionSnapshot, 'state'>,
  registry: ModelRegistrySnapshot,
  modelId: string | null,
): string | null {
  if (connection.state !== 'connected') return 'Подключите GigaChat перед отправкой файлов. Файлы останутся в черновике.';
  const unavailableReason = chatModelUnavailableReason(registry, modelId);
  return unavailableReason
    ? `Файлы нельзя отправить выбранной моделью: ${unavailableReason} Файлы останутся в черновике.`
    : null;
}

export interface LocalAttachmentContent {
  kind: 'document' | 'image';
  contentType: string;
}

const DOCUMENTED_EXTENSIONS = new Set(['txt', 'doc', 'docx', 'pdf', 'epub', 'ppt', 'pptx', 'xlsx']);

const SENDABLE_CONTENT_TYPES: Readonly<Record<string, LocalAttachmentContent>> = {
  txt: { kind: 'document', contentType: 'text/plain' },
  md: { kind: 'document', contentType: 'text/plain' },
  pdf: { kind: 'document', contentType: 'application/pdf' },
  png: { kind: 'image', contentType: 'image/png' },
  jpg: { kind: 'image', contentType: 'image/jpeg' },
  jpeg: { kind: 'image', contentType: 'image/jpeg' },
};

export function attachmentContentType(name: string): LocalAttachmentContent | null {
  const pathParts = name.split(/[\\/]/);
  const fileName = pathParts[pathParts.length - 1] ?? '';
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  return SENDABLE_CONTENT_TYPES[extension] ?? null;
}

export function inspectLocalAttachmentContent(name: string, bytes: Uint8Array): LocalAttachmentContent | null {
  const expected = attachmentContentType(name);
  if (!expected) return null;
  const fileName = name.split(/[\\/]/).pop() ?? '';
  const extension = fileName.split('.').pop()?.toLowerCase();
  if (extension === 'txt' || extension === 'md') {
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new Error('Текстовый файл должен быть корректным UTF-8.'); }
    // Reject binary/control bytes so a renamed binary cannot pass as text.
    // eslint-disable-next-line no-control-regex -- this validation intentionally matches control characters.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text)) {
      throw new Error('В текстовом файле обнаружено бинарное содержимое.');
    }
    return expected;
  }
  if (extension === 'pdf') {
    if (bytes.length < 5 || String.fromCharCode(...bytes.slice(0, 5)) !== '%PDF-') throw new Error('Файл с расширением PDF не прошёл проверку содержимого.');
    return expected;
  }
  if (extension === 'png') {
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (bytes.length < 24 || signature.some((byte, index) => bytes[index] !== byte)
      || String.fromCharCode(...bytes.slice(12, 16)) !== 'IHDR'
      || bytes.slice(16, 24).every((byte) => byte === 0)) {
      throw new Error('Файл с расширением PNG не прошёл проверку содержимого.');
    }
    return expected;
  }
  if (extension === 'jpg' || extension === 'jpeg') {
    if (bytes.length < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
      throw new Error('Файл с расширением JPEG не прошёл проверку содержимого.');
    }
    return expected;
  }
  return null;
}

export function attachmentSendBlocker(
  modelId: string | null,
  text: string,
  attachments: readonly Pick<HomeDraftAttachment, 'name' | 'size' | 'sha256'>[],
): string | null {
  if (!attachments.length) return null;
  if (!modelId) return 'Сначала выберите модель; файлы останутся в черновике.';
  const capabilities = getModelCapabilities(modelId);
  if (basicAgentWorkflowStatus(capabilities) !== 'verified') {
    return 'Для выбранной модели не подтверждена работа файлов с вызовами функций. Выберите проверенную модель; файлы останутся в черновике.';
  }

  const imageAttachments = attachments.filter((attachment) => attachmentContentType(attachment.name)?.kind === 'image');
  if (imageAttachments.length > 10) return 'За один запрос можно прикрепить не более 10 изображений. Файлы останутся в черновике.';
  let imageBytes = 0;
  for (const attachment of attachments) {
    if (!Number.isSafeInteger(attachment.size) || attachment.size <= 0 || attachment.size > LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES
      || !/^[a-f0-9]{64}$/.test(attachment.sha256)) {
      if (attachment.size === 0) return `Файл «${attachment.name}» пуст. Добавьте содержимое или прикрепите другой файл; черновик сохранён.`;
      return `Копия «${attachment.name}» изменилась или не прошла проверку. Удалите её из черновика и прикрепите заново.`;
    }
    const content = attachmentContentType(attachment.name);
    if (!content) return `Формат «${attachment.name}» пока нельзя отправить. Файл останется в черновике.`;
    if (content.kind === 'image') {
      if (attachment.size > PROVIDER_IMAGE_LIMIT_BYTES) {
        return `Изображение «${attachment.name}» превышает лимит 15 МБ. Уменьшите его и прикрепите снова.`;
      }
      imageBytes += attachment.size;
    }
    const extension = attachment.name.split('.').pop()?.toLowerCase();
    const capability = extension === 'txt' ? capabilities.txt
      : extension === 'md' ? capabilities.md
        : extension === 'pdf' ? capabilities.pdf
          : extension === 'png' ? capabilities.png
            : extension === 'jpg' || extension === 'jpeg' ? capabilities.jpeg
              : 'unverified';
    if (capability !== 'verified') {
      const reason = capability === 'unavailable' ? 'модель сейчас не поддерживает этот формат'
        : 'этот формат для модели ещё не прошёл проверку';
      return `Файл «${attachment.name}»: ${reason}. Он останется в черновике.`;
    }
  }
  const promptBytes = new TextEncoder().encode(text).byteLength;
  if (imageBytes + promptBytes + PROVIDER_REQUEST_LIMIT_BYTES >= PROVIDER_MEDIA_LIMIT_BYTES) {
    return 'Изображения вместе с текстом запроса могут превысить общий лимит передачи. Уменьшите набор; файлы останутся в черновике.';
  }
  return null;
}

export interface AttachmentPolicy {
  localImportWithinLimit: boolean;
  format: 'documented' | 'unverified';
  documentedDocumentLimit: { amount: 40; unit: 'MB'; unitIsAmbiguous: true } | null;
  modelCapability: 'unknown';
  sendAllowed: false;
}

export function evaluateAttachmentPolicy(name: string, sizeBytes: number): AttachmentPolicy {
  const pathParts = name.split(/[\\/]/);
  const fileName = pathParts[pathParts.length - 1] ?? '';
  const dot = fileName.lastIndexOf('.');
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : '';
  const documented = DOCUMENTED_EXTENSIONS.has(extension);

  return {
    localImportWithinLimit: Number.isSafeInteger(sizeBytes)
      && sizeBytes >= 0 && sizeBytes <= LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES,
    format: documented ? 'documented' : 'unverified',
    documentedDocumentLimit: documented ? { amount: 40, unit: 'MB', unitIsAmbiguous: true } : null,
    modelCapability: 'unknown',
    sendAllowed: false,
  };
}
