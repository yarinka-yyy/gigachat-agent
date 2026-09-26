import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { openStore } from '../src/store';

function samplePdf(): string {
  const stream = 'BT /F1 18 Tf 32 105 Td (GigaChat Agents TEST SAMPLE) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 340 180] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  return `${pdf}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

async function main(): Promise<void> {
  const qaRoot = join(process.cwd(), '.qa');
  const profile = join(qaRoot, 'profile');
  const store = await openStore(profile);
  if ((await store.listChats()).some((chat) => chat.title === '[ТЕСТ] Пример диалога')) return;
  await mkdir(qaRoot, { recursive: true });
  const markdown = join(qaRoot, 'test-sample.md');
  const pdf = join(qaRoot, 'test-sample.pdf');
  await writeFile(markdown, '# Тестовый пример\n\nТолько для отдельного профиля проверки.\n');
  await writeFile(pdf, samplePdf(), 'ascii');

  const chat = await store.createChat();
  await store.updateChat(chat.id, { title: '[ТЕСТ] Пример диалога' });
  await store.appendLocalMessage(chat.id, 'Покажи пример локальной истории и файлов.');
  await store.importFile(chat.id, markdown);
  await store.importFile(chat.id, pdf);

  const path = join(profile, 'chats', chat.id, 'chat.json');
  const detail = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  const messages = detail.messages as Array<Record<string, unknown>>;
  messages.push({
    id: randomUUID(), role: 'assistant',
    text: '[ТЕСТОВЫЙ ОТВЕТ] Это демонстрация вида переписки. Реальная модель не подключена.',
    createdAt: new Date().toISOString(),
  });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(detail, null, 2)}\n`);
  await rename(temporary, path);
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : 'Не удалось создать тестовый профиль.'}\n`);
  process.exitCode = 1;
});
