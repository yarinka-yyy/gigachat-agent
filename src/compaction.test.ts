import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ChatArtifact, ChatMessage, ChatToolReceipt } from './contracts';
import {
  compileExtractiveCompaction,
  compileSemanticCompactionMemory,
  compileGeneratedSemanticCompactionMemory,
  compileSemanticSourceNotes,
  semanticSourceNotesResponseFormat,
  semanticCompactionResponseFormat,
  semanticReviewEvidenceIndex,
  compileAnchoredSemanticCompactionMemory,
  compileResolvedSemanticCompactionMemory,
  createCompactionSources,
  formatArchivedCompactionNotes,
  formatSemanticCompactionMemory,
  getSemanticCompactionCoverageRefSet,
  selectRetainedCompactionMessages,
  serializeCompactionTranscript,
  serializeSemanticCompactionTranscript,
  splitSemanticCompactionTranscript,
  validateSemanticCompactionMemory,
} from './compaction';

const at = '2026-10-18T12:00:00.000Z';
const reviewJson = (value: unknown): string => JSON.stringify(value);
const user = (id: string, text: string, attachmentIds?: string[]): ChatMessage => ({
  id, role: 'user', text, createdAt: at, ...(attachmentIds ? { attachmentIds } : {}),
});
const assistant = (id: string, text: string): ChatMessage => ({ id, role: 'assistant', text, createdAt: at, source: 'runtime' });

function selection(...retained: boolean[]): string {
  return JSON.stringify({ version: 2, decisions: retained.map((retain, index) => ({ sourceRef: `m${index}`, retain })) });
}

function candidate(decisions: unknown[], version = 2): string {
  return JSON.stringify({ version, decisions });
}

function retainedRefs(...indices: number[]): unknown[] {
  return ['retained-source-refs', indices.map((index) => `m${index}`)];
}

function semanticSources() {
  const messages = [
    user('semantic-task', 'Продолжить подготовку отчёта.'),
    assistant('semantic-facts', 'Лимит 7300 ₽ согласован. Не изменять исходный файл.'),
    user('semantic-marker', 'В диагностическом выводе есть символ |.'),
  ];
  const receipt: ChatToolReceipt = {
    receiptId: 'semantic-receipt', anchorMessageId: 'semantic-task', name: 'read', arguments: { path: 'report.txt' },
    content: 'Проверено чтением без записи.', functionsStateId: null, status: 'completed',
    result: 'Найдено 3 строки.', createdAt: at,
  };
  return createCompactionSources(messages, [receipt], []);
}

function largeSemanticSources() {
  const messages = Array.from({ length: 66 }, (_, index) => {
    if (index === 0) return user('inventory-task', 'Продолжить подготовку отчёта.');
    if (index === 1) return assistant('inventory-fact', 'Лимит 7300 ₽ согласован. Не изменять исходный файл.');
    return index % 2 === 0
      ? user(`inventory-user-${index}`, `History item ${index}.`)
      : assistant(`inventory-assistant-${index}`, `History item ${index}.`);
  });
  const receipts: ChatToolReceipt[] = [0, 64].map((index) => ({
    receiptId: `inventory-tool-${index}`, anchorMessageId: messages[index]!.id, name: 'read', arguments: { index },
    content: `Проверено чтением ${index}.`, functionsStateId: null, status: 'completed',
    result: `Результат инструмента ${index}.`, createdAt: at,
  }));
  return { messages, sources: createCompactionSources(messages, receipts, []) };
}

function semanticCandidate(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: 'gigachat-semantic-memory',
    version: 1,
    activeTask: { text: 'Завершить подготовку отчёта.', sourceRefs: ['m0'] },
    constraints: [{ scope: 'Исходный файл', text: 'Не изменять исходное содержимое.', sourceRefs: ['m1'] }],
    decisions: [{ text: 'Сохранить согласованный лимит.', sourceRefs: ['m1'] }],
    openWork: [{ text: 'Получить следующий результат только чтением.', sourceRefs: ['t0'] }],
    facts: [{ text: 'Согласованный лимит составляет 7300 ₽.', sourceRefs: ['m1'],
      exactQuotes: [{ sourceRef: 'm1', text: 'Лимит 7300 ₽ согласован.' }] }],
    pastTopics: [{ text: 'Ранее обсуждалась подготовка отчёта.', sourceRefs: ['m0'] }],
    ...overrides,
  });
}

test('sends only message refs, roles and text while keeping tool and attachment data app-side', () => {
  const messages = [
    user('local-user-id', 'Открой заметку.', ['local-attachment-id']),
    assistant('local-assistant-id', 'Запись говорит: «готово».\nТочный код: `x\\y`.') ,
  ];
  const receipt: ChatToolReceipt = {
    receiptId: 'private-receipt-id', anchorMessageId: 'local-user-id', name: 'read',
    arguments: { path: 'notes.txt' }, content: null, functionsStateId: 'private-state-id',
    status: 'unknown', result: 'effect unknown', createdAt: at,
  };
  const artifact: ChatArtifact = {
    id: 'local-attachment-id', name: 'notes.txt', storedName: 'private-local-name', size: 12,
    sha256: 'a'.repeat(64), createdAt: at, messageId: 'local-user-id',
  };
  const sources = createCompactionSources(messages, [receipt], [artifact]);
  const transcript = serializeCompactionTranscript(sources);
  const records = JSON.parse(transcript.slice(transcript.indexOf('\n') + 1)) as Array<Record<string, unknown>>;

  assert.deepEqual(records, [
    { sourceRef: 'm0', role: 'user', text: 'Открой заметку.' },
    { sourceRef: 'm1', role: 'assistant', text: 'Запись говорит: «готово».\nТочный код: `x\\y`.' },
  ]);
  assert.equal(transcript.includes('local-user-id'), false);
  assert.equal(transcript.includes('private-receipt-id'), false);
  assert.equal(transcript.includes('private-state-id'), false);
  assert.equal(transcript.includes('powershell'), false);
  assert.equal(transcript.includes('notes.txt'), false);
  assert.deepEqual(sources.tools.map(({ anchorRef, status, result }) => ({ anchorRef, status, result })), [
    { anchorRef: 'm0', status: 'unknown', result: 'effect unknown' },
  ]);
  assert.deepEqual(sources.messages[0]?.attachments, [{ name: 'notes.txt', sizeBytes: 12, sha256: 'a'.repeat(64) }]);
  assert.ok(Object.isFrozen(sources) && Object.isFrozen(sources.messages) && Object.isFrozen(sources.tools));
});

test('serializes semantic sources with ordered attachment/tool metadata and no private IDs', () => {
  const messages = [user('semantic-source-user', 'Inspect the report.', ['semantic-source-file']), assistant('semantic-source-assistant', 'One fact.')];
  const receipt: ChatToolReceipt = {
    receiptId: 'private-semantic-receipt', anchorMessageId: messages[0]!.id, name: 'read', arguments: { path: 'report.txt' },
    content: 'Read-only content.', functionsStateId: 'private-semantic-state', status: 'completed', result: 'Three rows.', createdAt: at,
  };
  const artifact: ChatArtifact = {
    id: 'semantic-source-file', name: 'report.txt', storedName: 'private-local-storage-path', size: 25,
    sha256: 'c'.repeat(64), createdAt: at, messageId: messages[0]!.id,
  };
  const sources = createCompactionSources(messages, [receipt], [artifact]);
  const candidate = JSON.stringify({
    format: 'gigachat-semantic-memory', version: 1,
    activeTask: { text: 'Inspect the report.', sourceRefs: ['m0'] },
    constraints: [], decisions: [], openWork: [],
    facts: [{ text: 'The tool read the report.', sourceRefs: ['t0'], exactQuotes: [{ sourceRef: 't0', text: 'Read-only content.' }] }],
    pastTopics: [],
  });
  const memory = validateSemanticCompactionMemory(candidate, sources);
  const serialized = serializeSemanticCompactionTranscript(sources, memory);
  const envelope = JSON.parse(serialized.slice(serialized.indexOf('\n') + 1)) as {
    format: string; version: number; previousMemory: unknown;
    coverageRefSet: string[];
    messages: Array<{ sourceRef: string; role: string; text: string; attachments: unknown[] }>;
    tools: Array<Record<string, unknown>>;
  };

  assert.equal(envelope.format, 'gigachat-semantic-compaction-input');
  assert.equal(envelope.version, 1);
  assert.deepEqual(envelope.previousMemory, memory);
  assert.deepEqual(envelope.coverageRefSet, ['m0', 't0', 'm1'], 'prior memory refs precede new message and tool refs');
  assert.deepEqual(envelope.messages.map(({ sourceRef, role, text }) => [sourceRef, role, text]), [
    ['m0', 'user', 'Inspect the report.'], ['m1', 'assistant', 'One fact.'],
  ]);
  assert.deepEqual(envelope.messages[0]?.attachments, [{
    name: 'report.txt', sizeBytes: 25, sha256: 'c'.repeat(64), contentAvailable: false,
  }]);
  assert.deepEqual(envelope.tools, [{
    sourceRef: 't0', anchorRef: 'm0', name: 'read', arguments: { path: 'report.txt' },
    status: 'completed', content: 'Read-only content.', result: 'Three rows.',
  }]);
  for (const privateValue of ['semantic-source-user', 'private-semantic-receipt', 'private-semantic-state', 'private-local-storage-path']) {
    assert.equal(serialized.includes(privateValue), false);
  }
  assert.throws(() => serializeSemanticCompactionTranscript(sources, null, 3), /Граница нового фрагмента/);
});

test('keeps both sides of an exchange when either its question or answer is selected', () => {
  const messages = [
    user('question-1', 'Сколько строк осталось?'),
    assistant('answer-1', 'Осталось 11 строк.'),
    user('question-2', 'Можно перезаписать исходник?'),
    assistant('answer-2', 'Нет, исходник остаётся неизменным.'),
  ];
  const sources = createCompactionSources(messages, [], []);
  const expectedFirstExchange = [
    retainedRefs(0, 1),
    ['user', 'Сколько строк осталось?'],
    ['assistant', 'Осталось 11 строк.'],
  ];
  assert.deepEqual(JSON.parse(compileExtractiveCompaction(selection(true, false, false, false), sources)), expectedFirstExchange);
  assert.deepEqual(JSON.parse(compileExtractiveCompaction(selection(false, true, false, false), sources)), expectedFirstExchange);
});

test('drops a wholly excluded filler exchange but keeps the selected exchange whole', () => {
  const messages = [
    user('filler', 'Привет.'),
    assistant('ack', 'Привет, чем помочь?'),
    user('question', 'Нужно ли сохранять контрольный файл?'),
    assistant('answer', 'Да, контрольный файл нужно сохранить.'),
  ];
  const sources = createCompactionSources(messages, [], []);
  const compiled = compileExtractiveCompaction(selection(false, false, true, false), sources);

  assert.deepEqual(JSON.parse(compiled), [
    retainedRefs(2, 3),
    ['user', 'Нужно ли сохранять контрольный файл?'],
    ['assistant', 'Да, контрольный файл нужно сохранить.'],
  ]);
});

test('retains a tool anchor and actual tool result even when its decision excludes the message', () => {
  const messages = [
    user('tool-anchor', 'Проверь output.tsv только чтением.'),
    assistant('noise', 'Фоновое сообщение без новых сведений.'),
    user('next', 'Проверь, кто отвечает за следующий шаг.'),
  ];
  const receipt: ChatToolReceipt = {
    receiptId: 'receipt', anchorMessageId: 'tool-anchor', name: 'read', arguments: { path: 'output.tsv' },
    content: 'Прочитано без изменений.', functionsStateId: null, status: 'completed',
    result: 'read-only success', createdAt: at,
  };
  const sources = createCompactionSources(messages, [receipt], []);
  const compiled = compileExtractiveCompaction(selection(false, false, true), sources);

  assert.deepEqual(JSON.parse(compiled), [
    retainedRefs(0, 1, 2),
    ['user', 'Проверь output.tsv только чтением.'],
    ['tool', 'read', 'completed', { path: 'output.tsv' }, 'Прочитано без изменений.', 'read-only success'],
    ['assistant', 'Фоновое сообщение без новых сведений.'],
    ['user', 'Проверь, кто отвечает за следующий шаг.'],
  ]);
});

test('keeps leading assistant runs and groups across empty users and consecutive assistants', () => {
  const messages = [
    assistant('leading-kept', 'Первая вводная реплика.'),
    assistant('leading-excluded', 'Продолжение вводной реплики.'),
    user('empty-user', ''),
    assistant('reply-kept', 'Ответ после пустого пользовательского сообщения.'),
    assistant('consecutive-excluded', 'Следующая реплика того же обмена.'),
    user('filler', 'Привет.'),
    assistant('ack', 'Здравствуйте.'),
    user('question', 'Сохранить контрольный файл?'),
    assistant('answer', 'Да, сохраните его.'),
  ];
  const sources = createCompactionSources(messages, [], []);
  const compiled = compileExtractiveCompaction(candidate([
    { sourceRef: 'm0', retain: true },
    { sourceRef: 'm1', retain: false },
    { sourceRef: 'm3', retain: true },
    { sourceRef: 'm4', retain: false },
    { sourceRef: 'm5', retain: false },
    { sourceRef: 'm6', retain: false },
    { sourceRef: 'm7', retain: true },
    { sourceRef: 'm8', retain: false },
  ]), sources);

  assert.deepEqual(JSON.parse(compiled), [
    retainedRefs(0, 1, 2, 3, 4, 7, 8),
    ['assistant', 'Первая вводная реплика.'],
    ['assistant', 'Продолжение вводной реплики.'],
    ['assistant', 'Ответ после пустого пользовательского сообщения.'],
    ['assistant', 'Следующая реплика того же обмена.'],
    ['user', 'Сохранить контрольный файл?'],
    ['assistant', 'Да, сохраните его.'],
  ]);
});

test('keeps an attached exchange and its metadata when only the answer is selected', () => {
  const messages = [user('attached', 'Проверь файл.', ['attachment']), assistant('kept', 'Проверка не выполнялась.')];
  const artifact: ChatArtifact = {
    id: 'attachment', name: 'report.pdf', storedName: 'internal-name', size: 42,
    sha256: 'b'.repeat(64), createdAt: at, messageId: 'attached',
  };
  const sources = createCompactionSources(messages, [], [artifact]);
  const compiled = compileExtractiveCompaction(selection(false, true), sources);

  assert.deepEqual(JSON.parse(compiled), [
    retainedRefs(0, 1),
    ['user', 'Проверь файл.'],
    ['attachment', 'report.pdf', 42, 'b'.repeat(64), false],
    ['assistant', 'Проверка не выполнялась.'],
  ]);
});

test('retains omitted source messages while applying ordered explicit exclusions', () => {
  const messages = [
    user('u1', 'Закрытый вопрос.'), assistant('a1', 'Подтверждённый итог.'),
    user('u2', 'Фоновый вопрос.'), assistant('a2', 'Фоновый ответ.'),
    user('u3', 'Ещё один закрытый вопрос.'), assistant('a3', 'Ещё один итог.'),
  ];
  const sources = createCompactionSources(messages, [], []);
  const compiled = compileExtractiveCompaction(candidate([
    { sourceRef: 'm0', retain: false },
    { sourceRef: 'm1', retain: false },
    { sourceRef: 'm2', retain: false },
    { sourceRef: 'm4', retain: false },
    { sourceRef: 'm5', retain: false },
  ]), sources);

  assert.deepEqual(JSON.parse(compiled)[0], retainedRefs(2, 3));
  assert.deepEqual(selectRetainedCompactionMessages(compiled, messages), messages.slice(2, 4));
});

test('rejects malformed, empty, duplicated, unordered, all-exclude, or oversized message decisions', () => {
  const sources = createCompactionSources([user('u1', 'Исходный вопрос.'), assistant('a1', 'Подтверждённый ответ.')], [], []);
  const complete = [
    { sourceRef: 'm0', retain: true },
    { sourceRef: 'm1', retain: false },
  ];
  const valid = candidate(complete);
  const invalidCandidates: Array<[string, string, RegExp]> = [
    ['wrong version', candidate(complete, 1), /неверную структуру/],
    ['wrong root shape', JSON.stringify({ version: 2, decisions: complete, extra: true }), /неверную структуру/],
    ['wrong decisions type', JSON.stringify({ version: 2, decisions: 'm0' }), /неверную структуру/],
    ['wrong decision shape', candidate([{ sourceRef: 'm0', retain: true, reason: 'extra' }, complete[1]]), /некорректное решение/],
    ['wrong retain type', candidate([{ sourceRef: 'm0', retain: 'true' }, complete[1]]), /некорректное решение/],
    ['raw control character', valid.replace('m0', 'm\u0001'), /корректным JSON/],
    ['escaped control ref', candidate([{ sourceRef: 'm\u0001', retain: true }, complete[1]]), /некорректное решение/],
    ['unknown ref', candidate([{ sourceRef: 'm9', retain: true }, complete[1]]), /неизвестный или повторный/],
    ['duplicate ref', candidate([complete[0], complete[0]]), /неизвестный или повторный/],
    ['empty decisions', candidate([]), /не содержит решений/],
    ['out of order', candidate([...complete].reverse()), /исходном порядке/],
    ['all nonempty messages excluded', candidate(complete.map((decision) => ({ ...decision, retain: false }))), /все непустые сообщения/],
    ['candidate byte limit', ' '.repeat(64 * 1024 + 1), /превышает допустимый размер/],
  ];
  for (const [name, candidate, expectedError] of invalidCandidates) {
    assert.throws(() => compileExtractiveCompaction(candidate, sources), expectedError, name);
  }

  const longSource = `${'x'.repeat(32 * 1024)}.`;
  const longSources = createCompactionSources([assistant('long', longSource)], [], []);
  assert.throws(() => compileExtractiveCompaction(selection(true), longSources), /размером до 32 КиБ/);
});

test('rejects excluding every nonempty message even when tool data would remain', () => {
  const messages = [user('tool-anchor', 'Проверь заметку.'), assistant('answer', 'Результат проверки.')];
  const receipt: ChatToolReceipt = {
    receiptId: 'receipt', anchorMessageId: 'tool-anchor', name: 'read', arguments: { path: 'notes.txt' },
    content: null, functionsStateId: null, status: 'completed', result: 'Прочитано.', createdAt: at,
  };
  const sources = createCompactionSources(messages, [receipt], []);

  assert.throws(() => compileExtractiveCompaction(selection(false, false), sources), /все непустые сообщения/);
  const emptySources = createCompactionSources([user('empty-only', '')], [], []);
  assert.throws(() => compileExtractiveCompaction(candidate([]), emptySources), /исключил все сообщения истории/);
});

test('restores complete source messages from retained refs and rejects malformed or partial manifests', () => {
  const messages: ChatMessage[] = [
    { ...user('u1', 'Question', ['file']), createdAt: at },
    { ...assistant('a1', 'Answer'), functionsStateId: 'old-state' },
    user('empty-tool-anchor', ''),
    assistant('a2', 'Tool response'),
    user('u2', 'Filler'),
    assistant('a3', 'Filler response'),
  ];
  const receipt: ChatToolReceipt = {
    receiptId: 'receipt', anchorMessageId: 'empty-tool-anchor', name: 'read', arguments: { path: 'notes.txt' },
    content: null, functionsStateId: null, status: 'completed', result: 'Read only.', createdAt: at,
  };
  const artifact: ChatArtifact = {
    id: 'file', name: 'notes.txt', storedName: 'private-file', size: 12,
    sha256: 'a'.repeat(64), createdAt: at, messageId: 'u1',
  };
  const sources = createCompactionSources(messages, [receipt], [artifact]);
  const compiled = compileExtractiveCompaction(candidate([
    { sourceRef: 'm0', retain: true },
    { sourceRef: 'm1', retain: false },
    { sourceRef: 'm3', retain: false },
    { sourceRef: 'm4', retain: false },
    { sourceRef: 'm5', retain: false },
  ]), sources);
  const restored = selectRetainedCompactionMessages(compiled, messages);

  assert.deepEqual(JSON.parse(compiled)[0], retainedRefs(0, 1, 2, 3));
  assert.deepEqual(restored, messages.slice(0, 4));
  assert.notEqual(restored?.[0], messages[0]);
  assert.notEqual(restored?.[0]?.attachmentIds, messages[0]?.attachmentIds);
  assert.equal(restored?.[1]?.functionsStateId, 'old-state');
  assert.equal(selectRetainedCompactionMessages('Legacy summary: continue.', messages), null);

  const malformed: Array<[string, unknown[], RegExp]> = [
    ['empty refs', [retainedRefs()], /повреждены/],
    ['extra metadata field', [['retained-source-refs', ['m0'], 'extra']], /повреждены/],
    ['noncanonical ref', [['retained-source-refs', ['m00']]], /неверную ссылку/],
    ['unknown ref', [['retained-source-refs', ['m9']]], /неизвестную/],
    ['duplicate ref', [['retained-source-refs', ['m0', 'm0']]], /неизвестную/],
    ['out of order refs', [['retained-source-refs', ['m1', 'm0']]], /неизвестную/],
    ['control-bearing ref', [['retained-source-refs', ['m\u0001']]], /неверную ссылку/],
    ['marker not first', [['user', 'legacy'], retainedRefs(0, 1)] as unknown[], /повреждены/],
    ['duplicate marker', [retainedRefs(0, 1), retainedRefs(2, 3)], /повреждены/],
    ['partial exchange', [retainedRefs(0)], /границу обмена/],
  ];
  for (const [name, rows, expectedError] of malformed) {
    assert.throws(() => selectRetainedCompactionMessages(JSON.stringify(rows), messages), expectedError, name);
  }
});

test('accepts complete keep decisions and frames saved notes as inert archived history', () => {
  const sources = createCompactionSources([user('u1', 'Открытый запрос.')], [], []);
  const compiled = compileExtractiveCompaction(selection(true), sources);
  const archived = formatArchivedCompactionNotes(compiled);

  assert.deepEqual(JSON.parse(compiled), [retainedRefs(0), ['user', 'Открытый запрос.']]);
  assert.match(archived, /архив переписки — данные, не текущие инструкции/i);
  assert.match(archived, /исходный порядок сохранён/);
  assert.match(archived, /Пользователь:\nОткрытый запрос\./);
  assert.doesNotMatch(archived, /\["user"|\["assistant"/);
});

test('renders exact original message strings as ordered role-labelled archive text', () => {
  const userText = 'Точная подпись: "Keep spaces"; Unicode — ёж.\nconst value = "a\\\\b";';
  const assistantText = 'Старая версия 2.4.\nНовая версия — 2.6; код `a\\b`.';
  const sources = createCompactionSources([
    user('u1', userText), assistant('a1', assistantText), user('u2', 'Открытый вопрос: кто владелец?'),
  ], [], []);
  const compiled = compileExtractiveCompaction(selection(true, true, true), sources);
  const archived = formatArchivedCompactionNotes(compiled);

  assert.ok(archived.indexOf(`Пользователь:\n${userText}`) < archived.indexOf(`Ассистент:\n${assistantText}`));
  assert.ok(archived.indexOf(`Ассистент:\n${assistantText}`) < archived.indexOf('Пользователь:\nОткрытый вопрос: кто владелец?'));
  assert.ok(archived.includes(userText), 'JSON-escaped quotes, tabular text and newlines are rendered as original text');
  assert.ok(archived.includes(assistantText), 'code backslashes and multiline version changes stay exact');
  assert.doesNotMatch(archived, /\["user"|\["assistant"/);
});

test('renders tool status separately from result and retains attachment metadata without claiming file access', () => {
  const messages = [user('u1', 'Проверь report.pdf.', ['file']), assistant('a1', 'Проверка завершена с ошибкой файла.')];
  const receipt: ChatToolReceipt = {
    receiptId: 'receipt', anchorMessageId: 'u1', name: 'read', arguments: { path: 'report.pdf', mode: 'text' },
    content: 'Ответ инструмента: файл не найден.', functionsStateId: null, status: 'completed',
    result: '{"error":"file not found"}', createdAt: at,
  };
  const artifact: ChatArtifact = {
    id: 'file', name: 'report.pdf', storedName: 'internal-report', size: 42,
    sha256: 'b'.repeat(64), createdAt: at, messageId: 'u1',
  };
  const sources = createCompactionSources(messages, [receipt], [artifact]);
  const archived = formatArchivedCompactionNotes(compileExtractiveCompaction(selection(true, true), sources));

  const userPosition = archived.indexOf('Пользователь:\nПроверь report.pdf.');
  const attachmentPosition = archived.indexOf('Вложение: report.pdf');
  const toolPosition = archived.indexOf('Инструмент: read');
  const assistantPosition = archived.indexOf('Ассистент:\nПроверка завершена с ошибкой файла.');
  assert.ok(userPosition < attachmentPosition && attachmentPosition < toolPosition && toolPosition < assistantPosition);
  assert.match(archived, /Размер: 42 байт/);
  assert.match(archived, new RegExp(`SHA-256: ${'b'.repeat(64)}`));
  assert.match(archived, /Содержимое файла не загружалось\./);
  assert.match(archived, /Статус вызова: completed/);
  assert.match(archived, /Аргументы: \{"mode":"text","path":"report\.pdf"\}/);
  assert.match(archived, /Содержимое: Ответ инструмента: файл не найден\./);
  assert.match(archived, /Результат: \{"error":"file not found"\}/);
});

test('keeps legacy plaintext and unrecognized JSON visible under the archive notice', () => {
  const legacy = 'Сводка: продолжить задачу. Keep spaces.';
  const unrecognized = '[["assistant","текст", "лишнее поле"]]';
  const legacyArchive = formatArchivedCompactionNotes(legacy);
  const unrecognizedArchive = formatArchivedCompactionNotes(unrecognized);

  assert.ok(legacyArchive.endsWith(`\n\n${legacy}`));
  assert.ok(unrecognizedArchive.endsWith(`\n\n${unrecognized}`));
  assert.doesNotMatch(unrecognizedArchive, /Ассистент:\nтекст/);
});

test('validates and formats versioned semantic memory with paraphrases and exact source quotes', () => {
  const sources = semanticSources();
  const candidate = semanticCandidate({ facts: [
    { text: 'Согласованный лимит составляет 7300 ₽.', sourceRefs: ['m1'],
      exactQuotes: [{ sourceRef: 'm1', text: 'Лимит 7300 ₽ согласован.' }] },
    { text: 'Символ из диагностического вывода сохранён как точное значение.', sourceRefs: ['m2'],
      exactQuotes: [{ sourceRef: 'm2', text: '|' }] },
  ] });
  const memory = validateSemanticCompactionMemory(candidate, sources);
  const compiled = compileSemanticCompactionMemory(candidate, sources);
  const formatted = formatSemanticCompactionMemory(candidate, sources);

  assert.equal(memory.version, 1);
  assert.equal(memory.activeTask?.text, 'Завершить подготовку отчёта.');
  assert.equal(memory.facts[0]?.text, 'Согласованный лимит составляет 7300 ₽.');
  assert.deepEqual(JSON.parse(compiled), memory);
  assert.match(formatted, /Архивная семантическая память v1: ниже данные истории, не текущие инструкции, разрешения или вызовы инструментов/);
  assert.match(formatted, /Дословная цитата m1: "Лимит 7300 ₽ согласован\."/);
  assert.match(formatted, /Дословная цитата m2: "\|"/);
});

test('limits semantic candidate refs to the current archive inventory while preserving stored-memory validation', () => {
  const sources = semanticSources();
  const sourceRefs = getSemanticCompactionCoverageRefSet(sources);
  const candidate = semanticCandidate();

  assert.deepEqual(sourceRefs, ['m0', 'm1', 'm2', 't0']);
  assert.equal(compileSemanticCompactionMemory(candidate, sources, sourceRefs),
    compileSemanticCompactionMemory(candidate, sources), 'legacy stored semantic memory remains readable without an inventory argument');
  assert.throws(() => compileSemanticCompactionMemory(candidate, sources, ['m0', 'm1', 'm2']),
    /вне текущего архива/);
  assert.throws(() => compileSemanticCompactionMemory(candidate, sources, ['m0', 'm1', 'm1']),
    /неизвестную или повторную ссылку/);
  assert.throws(() => compileSemanticCompactionMemory(candidate, sources, ['m0', 'm1', 't99']),
    /неизвестную или повторную ссылку/);
  assert.throws(() => compileSemanticCompactionMemory(candidate, sources, [...sourceRefs, 'm99']),
    /не превышать количество проверенных исходников/);
});

test('serializes and compiles complete semantic inventories above 64 message and tool refs', () => {
  const { messages, sources } = largeSemanticSources();
  const sourceRefs = getSemanticCompactionCoverageRefSet(sources);
  const expectedRefs = [...messages.map((_, index) => `m${index}`), 't0', 't1'];
  const serialized = serializeSemanticCompactionTranscript(sources);
  const envelope = JSON.parse(serialized.slice(serialized.indexOf('\n') + 1)) as {
    coverageRefSet: string[];
    messages: Array<{ sourceRef: string }>;
    tools: Array<{ sourceRef: string }>;
  };

  assert.equal(sourceRefs.length, 68);
  assert.deepEqual(sourceRefs, expectedRefs);
  assert.deepEqual(envelope.coverageRefSet, expectedRefs);
  assert.deepEqual(envelope.messages.map(({ sourceRef }) => sourceRef), expectedRefs.slice(0, messages.length));
  assert.deepEqual(envelope.tools.map(({ sourceRef }) => sourceRef), ['t0', 't1']);
  assert.equal(compileSemanticCompactionMemory(semanticCandidate(), sources, sourceRefs),
    compileSemanticCompactionMemory(semanticCandidate(), sources));
});

test('keeps prior memory refs and the new suffix messages and tools in rolling coverage', () => {
  const { sources } = largeSemanticSources();
  const previousMemory = validateSemanticCompactionMemory(semanticCandidate(), sources);
  const sourceRefs = getSemanticCompactionCoverageRefSet(sources, previousMemory, 64);
  const serialized = serializeSemanticCompactionTranscript(sources, previousMemory, 64);
  const envelope = JSON.parse(serialized.slice(serialized.indexOf('\n') + 1)) as {
    coverageRefSet: string[];
    messages: Array<{ sourceRef: string }>;
    tools: Array<{ sourceRef: string }>;
  };
  const nextCandidate = JSON.stringify({
    ...previousMemory,
    facts: [...previousMemory.facts, {
      text: 'The latest tool returned a result.', sourceRefs: ['t1'], exactQuotes: [{ sourceRef: 't1', text: 'Результат инструмента 64.' }],
    }],
  });

  assert.deepEqual(sourceRefs, ['m0', 'm1', 't0', 'm64', 'm65', 't1']);
  assert.deepEqual(envelope.coverageRefSet, sourceRefs);
  assert.deepEqual(envelope.messages.map(({ sourceRef }) => sourceRef), ['m64', 'm65']);
  assert.deepEqual(envelope.tools.map(({ sourceRef }) => sourceRef), ['t1']);
  assert.doesNotThrow(() => compileSemanticCompactionMemory(nextCandidate, sources, sourceRefs));
});
test('allows no active task when sourced durable memory remains', () => {
  const sources = semanticSources();
  const memory = validateSemanticCompactionMemory(semanticCandidate({ activeTask: null }), sources);

  assert.equal(memory.activeTask, null);
  assert.equal(memory.facts.length, 1);
  assert.match(formatSemanticCompactionMemory(semanticCandidate({ activeTask: null }), sources), /Активная задача: отсутствует\./);
});

test('requires exact quotes to be nonempty substrings of the referenced source value', () => {
  const sources = semanticSources();

  const contentQuote = semanticCandidate({ facts: [{ text: 'Tool content was read.', sourceRefs: ['t0'],
    exactQuotes: [{ sourceRef: 't0', text: 'Проверено чтением' }] }] });
  assert.equal(validateSemanticCompactionMemory(contentQuote, sources).facts[0]?.exactQuotes?.[0]?.text, 'Проверено чтением');
  assert.throws(() => validateSemanticCompactionMemory(semanticCandidate({ facts: [{ text: 'Mismatched quote.', sourceRefs: ['m1'],
    exactQuotes: [{ sourceRef: 'm1', text: 'Найдено 3 строки.' }] }] }), sources), /не совпадает/);
  assert.throws(() => validateSemanticCompactionMemory(semanticCandidate({ facts: [{ text: 'Cross-source quote.', sourceRefs: ['m1'],
    exactQuotes: [{ sourceRef: 't0', text: 'Найдено 3 строки.' }] }] }), sources), /не связана/);
  assert.throws(() => validateSemanticCompactionMemory(semanticCandidate({ facts: [{ text: 'Combined tool values.', sourceRefs: ['t0'],
    exactQuotes: [{ sourceRef: 't0', text: 'Проверено чтением без записи.Найдено 3 строки.' }] }] }), sources), /не совпадает/);
  assert.deepEqual(validateSemanticCompactionMemory(semanticCandidate({ facts: [{
    text: 'The fact is paraphrased without a quote.', sourceRefs: ['m1'], exactQuotes: [],
  }] }), sources).facts[0]?.exactQuotes, [], 'strict JSON may require an empty quote array when no exact quote is needed');
});

test('source notes cover every source before compression without becoming a snapshot', () => {
  const refs = ['m0', 'm1', 't0'];
  const notes = { m0: 'Earlier restriction stays active.', m1: 'Discussion closed.', t0: 'Read passed; import untested.' };
  const verbatim = Object.fromEntries(refs.map(ref => [ref, false]));
  const topics = [{ subject: 'Read discussion', sourceRefs: ['m1', 't0'] }];
  assert.deepEqual(JSON.parse(compileSemanticSourceNotes(JSON.stringify({ taskSubject: 'Current task', state: 'Current task.', activeTask: 'm0', topics, notes, verbatim }), refs)), { taskSubject: 'Current task', state: 'Current task.', activeTask: 'm0', topics, notes, verbatim });
  assert.deepEqual(semanticSourceNotesResponseFormat(refs).schema.properties.notes.required, refs);
  for (const invalid of [{ notes: { m0: notes.m0 } }, { notes: { ...notes, unknown: 'extra' } },
    { notes: { ...notes, m1: '' } }, { notes: { ...notes, m1: 'x'.repeat(161) } }, { notes, facts: [] },
    { notes, topics: {} }, { notes, topics: [{ subject: 'Read', sourceRefs: ['unknown'] }] },
    { notes, topics: [{ subject: '', sourceRefs: ['m1'] }] }, { notes, topics: [{ subject: 'x'.repeat(81), sourceRefs: ['m1'] }] },
    { notes, topics: [{ subject: 'Read', sourceRefs: ['m1', 'm1'] }] }, { notes, topics: [...topics, ...topics] },
    { notes, topics: [{ subject: 'A', sourceRefs: ['m0'] }, { subject: 'B', sourceRefs: ['m1'] }, { subject: 'C', sourceRefs: ['t0'] }] }]) {
    assert.throws(() => compileSemanticSourceNotes(JSON.stringify({ taskSubject: 'Current task', state: 'Current task.', activeTask: 'm0', topics, verbatim, ...invalid }), refs));
  }
  assert.throws(() => validateSemanticCompactionMemory(JSON.stringify({ notes }), semanticSources()));
});

test('critical anchors are materialized without model paraphrases and reject unavailable refs', () => {
  const sources = semanticSources(), refs = getSemanticCompactionCoverageRefSet(sources);
  const archive = serializeSemanticCompactionTranscript(sources);
  const value = { format: 'gigachat-semantic-memory', version: 1, activeTask: null,
    constraints: [{ scope: 'Boundary', sourceRefs: ['m0'] }], facts: [{ sourceRefs: ['t0'] }], decisions: [], openWork: [], pastTopics: [] };
  const memory = JSON.parse(compileAnchoredSemanticCompactionMemory(JSON.stringify(value), sources, refs, archive));
  assert.equal(memory.constraints[0].text, sources.messages[0]!.text);
  assert.ok(memory.facts[0].exactQuotes.length > 0);
  assert.throws(() => compileAnchoredSemanticCompactionMemory(JSON.stringify({ ...value,
    constraints: [{ ...value.constraints[0], text: 'A broader restriction.' }] }), sources, refs, archive));
  assert.throws(() => compileAnchoredSemanticCompactionMemory(JSON.stringify(value), sources, ['t0'], archive));
});

test('topic closure removes all its details and defect state survives compilation and recall formatting', () => {
  const sources = createCompactionSources([
    user('policy', 'Keep all original reports.'), user('chart', 'Compare chart widths.'),
    user('queue', 'The upload queue is still unresolved.'), assistant('legend', 'Use a small chart legend.'),
    user('close', 'Chart styling is complete.'), user('result', 'UPLOAD-62: length passed; restored path differs. Upload not attempted; mismatch unresolved.'),
  ], [], []), refs = getSemanticCompactionCoverageRefSet(sources);
  const archive = serializeSemanticCompactionTranscript(sources);
  const notes = JSON.stringify({ taskSubject: 'Upload', state: 'Chart closed; upload unresolved.', activeTask: 'm2', topics: [], notes: Object.fromEntries(refs.map(ref => [ref, `Note ${ref}`])), verbatim: Object.fromEntries(refs.map(ref => [ref, true])) });
  const index = semanticReviewEvidenceIndex(archive);
  const idsFor = (ref: string) => Object.keys(index).filter(id => index[id]!.sourceRef === ref);
  const resolution = { topicUpdates: {}, assistantOrigins: { m3: 'self' }, sourceUpdates: { m0: 'none', m1: `closes:${idsFor('m4')[0]}`, m2: 'none', m3: `closes:${idsFor('m4')[0]}`, m4: 'none', m5: 'none' },
    activeTask: 'm2', classifications: { m0: 'constraint', m1: 'fact', m2: 'openWork', m3: 'decision', m4: 'drop', m5: 'fact' },
    unresolvedDefects: idsFor('m5').join(',') };
  const format = semanticCompactionResponseFormat(undefined, archive, `ЗАМЕТКИ\n${notes}`);
  assert.ok('sourceUpdates' in format.schema.properties);
  assert.ok(!format.schema.properties.activeTask.enum.includes('m3'));
  assert.ok(!format.schema.properties.activeTask.enum.includes('keep'));
  assert.deepEqual(format.schema.properties.sourceUpdates.required, refs);
  const emptyDraft = JSON.stringify({ ...JSON.parse(notes), activeTask: 'none', verbatim: Object.fromEntries(refs.map(ref => [ref, false])) });
  const emptyState = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson({ ...resolution, sourceUpdates: { ...resolution.sourceUpdates, m1: 'none', m3: 'none' }, activeTask: 'none', classifications: { ...resolution.classifications, m1: 'drop', m3: 'drop' } }), emptyDraft, sources, refs, archive));
  assert.equal(emptyState.activeTask, null, 'an explicitly absent task must stay absent');
  assert.deepEqual(emptyState.closedTopics ?? [], [], 'an explicitly empty closure selection is valid');
  const corrected = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson({ ...resolution, activeTask: 'm5' }), notes, sources, refs, archive));
  assert.deepEqual(corrected.activeTask.sourceRefs, ['m5'], 'review may correct a draft selection explicitly');
  const mistakenDraft = JSON.stringify({ ...JSON.parse(notes), topics: [{ subject: 'Mixed discussion', sourceRefs: refs }] });
  assert.deepEqual(JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson({ ...resolution, topicUpdates: { 'Mixed discussion': 'none' } }), mistakenDraft, sources, refs, archive)).closedTopics,
    corrected.closedTopics, 'draft grouping cannot replace independent literal review proof');
  const memory = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson(resolution), notes, sources, refs, archive));
  const automaticDefect = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson({ ...resolution,
    classifications: { ...resolution.classifications, m5: 'defect' }, unresolvedDefects: '' }),
  JSON.stringify({ ...JSON.parse(notes), verbatim: { ...JSON.parse(notes).verbatim, m5: false } }), sources, refs, archive));
  assert.deepEqual(automaticDefect, memory, 'a defect label must materialize exact state even without a second quote selection');
  assert.deepEqual(memory.constraints[0].sourceRefs, ['m0']);
  assert.equal(memory.constraints[0].text, sources.messages[0]!.text);
  assert.deepEqual(memory.facts.map((entry: { sourceRefs: string[] }) => entry.sourceRefs), [['m5']]);
  assert.deepEqual(memory.openWork.map((entry: { sourceRefs: string[] }) => entry.sourceRefs), [['m2'], ['m5']]);
  assert.equal(memory.openWork[1].text, `Наблюдённый неустранённый дефект: ${sources.messages[5]!.text}`);
  assert.deepEqual(memory.closedTopics, [{ text: 'Chart styling is complete.', sourceRefs: ['m1', 'm3'], closedBy: 'm4', closureEvidence: 'Chart styling is complete.' }]);
  assert.deepEqual(memory.unresolvedDefects[0].exactQuotes, idsFor('m5').map(id => ({ sourceRef: 'm5', text: index[id]!.text })));
  assert.deepEqual(validateSemanticCompactionMemory(JSON.stringify(memory), sources), memory, 'typed state round trips in snapshots');
  const formatted = formatSemanticCompactionMemory(JSON.stringify(memory), sources);
  assert.match(formatted, /НЕУСТРАНЁННЫЙ ДЕФЕКТ/);
  assert.match(formatted, /restored path differs/);
  assert.doesNotMatch(formatted, /Compare chart widths|small chart legend|Дословная цитата m5:/);
  for (const change of [{ sourceUpdates: undefined }, { sourceUpdates: {} }, { unresolvedDefects: undefined }, { observedDefect: true, defectEvidence: '' },
    { unresolvedDefects: 'q999' }, { activeTask: 'm999' }, { activeTask: '' }, { activeTask: 'none' }, { activeTask: 'm3' }, { activeTask: 'keep' },
    { pastTopics: '' }, { pastTopics: 'keep' }, { openWork: 'q2,q3' }, { classifications: { m0: 'constraint' } },
    { classifications: { ...resolution.classifications, m3: 'openWork' } }, { classifications: { ...resolution.classifications, m3: 'defect' } },
    { classifications: { ...resolution.classifications, m3: 'fact' } }, { classifications: { ...resolution.classifications, m3: 'constraint' } },
    { classifications: { ...resolution.classifications, m1: 'closed:q999' } }, { classifications: { ...resolution.classifications, m1: `closed:${idsFor('m0')[0]}` } },
    { classifications: { ...resolution.classifications, m2: 'q2' } }, { pastTopics: 'none', classifications: { ...resolution.classifications, m1: 'closed' } },
    { pastTopics: 'm3:m1,m3' }, { pastTopics: `${idsFor('m0')[0]}:m1,m3` },
    { unresolvedDefects: ';' }, { unresolvedDefects: [{ sourceRefs: ['m5'], exactQuotes: [] }] }]) {
    assert.throws(() => compileResolvedSemanticCompactionMemory(reviewJson({ ...resolution, ...change }), notes, sources, refs, archive));
  }
  assert.throws(() => validateSemanticCompactionMemory(JSON.stringify({ ...memory, openWork: [] }), sources), /Состояние дефекта/);
  assert.throws(() => validateSemanticCompactionMemory(JSON.stringify({ ...memory, facts: [] }), sources), /Состояние дефекта/);
  assert.throws(() => validateSemanticCompactionMemory(JSON.stringify({ ...memory, decisions: [{ text: 'Reopen legend.', sourceRefs: ['m3'] }] }), sources), /Закрытые/);
  const rollingSources = createCompactionSources([
    ...sources.messages.map(source => source.role === 'user' ? user(source.ref, source.text) : assistant(source.ref, source.text)),
    user('continue', 'Continue the upload investigation; no repair has been performed.'),
  ], [], []);
  const rollingArchive = serializeSemanticCompactionTranscript(rollingSources, memory, 6);
  const rollingRefs = getSemanticCompactionCoverageRefSet(rollingSources, memory, 6);
  const rollingNotes = JSON.stringify({ taskSubject: 'Upload', state: 'Mismatch still unresolved.', activeTask: 'm2', topics: [],
    notes: Object.fromEntries(rollingRefs.map(ref => [ref, 'Available memory.'])), verbatim: Object.fromEntries(rollingRefs.map(ref => [ref, true])) });
  const rollingIndex = semanticReviewEvidenceIndex(rollingArchive);
  const rolling = { ...resolution, classifications: { ...resolution.classifications, m1: 'drop', m3: 'drop', m6: 'openWork' }, unresolvedDefects: Object.keys(rollingIndex).filter(id => rollingIndex[id]!.sourceRef === 'm5').join(',') };
  const rollingResolution = { ...rolling, assistantOrigins: {}, sourceUpdates: Object.fromEntries(rollingRefs.map(ref => [ref, 'none'])) };
  const continued = JSON.parse(compileResolvedSemanticCompactionMemory(reviewJson(rollingResolution), rollingNotes, rollingSources, rollingRefs, rollingArchive));
  assert.deepEqual(continued.closedTopics, memory.closedTopics, 'later review cannot silently reopen closed details');
  assert.deepEqual(continued.unresolvedDefects, memory.unresolvedDefects, 'state survives a second compaction without prefix accumulation');
  assert.throws(() => compileResolvedSemanticCompactionMemory(reviewJson({ ...rollingResolution, unresolvedDefects: '' }), rollingNotes,
    rollingSources, rollingRefs, rollingArchive), /нельзя потерять/);
  assert.throws(() => compileResolvedSemanticCompactionMemory(reviewJson({ ...rollingResolution, unresolvedDefects: rolling.unresolvedDefects.split(',').slice(-1)[0] }), rollingNotes,
    rollingSources, rollingRefs, rollingArchive), /нельзя заменить/);
  const legacyWitness = { ...memory, unresolvedDefects: [{ ...memory.openWork[1], exactQuotes: [{ sourceRef: 'm5', text: sources.messages[5]!.text }] }] };
  const legacyArchive = serializeSemanticCompactionTranscript(rollingSources, legacyWitness, 6);
  const legacyIndex = semanticReviewEvidenceIndex(legacyArchive);
  const legacyId = Object.keys(legacyIndex).find(id => legacyIndex[id]!.sourceRef === 'm5' && legacyIndex[id]!.text === sources.messages[5]!.text);
  assert.ok(legacyId, 'a prior multi-sentence literal witness must remain addressable as a whole');
  assert.doesNotThrow(() => compileResolvedSemanticCompactionMemory(reviewJson({ ...rollingResolution, unresolvedDefects: legacyId }), rollingNotes, rollingSources, rollingRefs, legacyArchive));
  assert.throws(() => compileResolvedSemanticCompactionMemory(' '.repeat(4097), notes, sources, refs, archive), /4096 байт/);
});

test('source state transitions override stale categories without dropping durable exceptions or independent work', () => {
  const messages = [
    user('policy', 'Do not write files. Exclude public scores; an internal retry counter is allowed. The ownerCode field name may appear, but never its values.'),
    user('pending', 'The upload queue remains unresolved; return to it after the chart discussion.'),
    user('chart', 'Compare chart borders and spacing.'), assistant('legend', 'Use a small legend and two columns.'),
    user('old', 'The tentative budget is 900; this does not authorize spending.'),
    user('close', 'The chart discussion is closed. Continue investigating the upload queue without writing files.'),
    user('revision', 'Replace the old budget with 640. No purchase or local write is authorized.'),
    user('return', 'Return only to the chart legend later; this aside does not close the upload investigation.'),
    user('outcome', 'READ-43: the copy and checksum passed on Linux build 2.8; restored path differs. Upload was not attempted; the mismatch remains unresolved.'),
    assistant('overreach', 'All ownerCode mentions are forbidden; the upload is complete.'),
  ];
  const sources = createCompactionSources(messages, [], []), refs = getSemanticCompactionCoverageRefSet(sources);
  const archive = serializeSemanticCompactionTranscript(sources), evidence = semanticReviewEvidenceIndex(archive);
  const idsFor = (ref: string) => Object.keys(evidence).filter(id => evidence[id]!.sourceRef === ref);
  const notes = JSON.stringify({ taskSubject: 'Upload queue', state: 'Chart closed, upload unresolved.', activeTask: 'm5', topics: [],
    notes: Object.fromEntries(refs.map(ref => [ref, 'An incomplete extraction.'])), verbatim: Object.fromEntries(refs.map(ref => [ref, true])) });
  const sourceUpdates = { m0: 'none', m1: 'none', m2: `closes:${idsFor('m5')[0]}`, m3: `closes:${idsFor('m5')[0]}`, m4: `supersedes:${idsFor('m6')[0]}`, m5: 'none', m6: 'none', m7: 'none', m8: 'none', m9: 'none' };
  const resolution = { topicUpdates: {}, assistantOrigins: { m3: 'self', m9: 'self' }, sourceUpdates, activeTask: 'm5', unresolvedDefects: '',
    classifications: { m0: 'constraint', m1: 'openWork', m2: 'fact', m3: 'decision', m4: 'fact', m5: 'openWork', m6: 'fact', m7: 'fact', m8: 'defect', m9: 'drop' } };
  const compile = (value: unknown) => JSON.parse(compileResolvedSemanticCompactionMemory(JSON.stringify(value), notes, sources, refs, archive));
  const memory = compile(resolution);
  const active = [memory.activeTask, ...memory.constraints, ...memory.decisions, ...memory.openWork, ...memory.facts];
  assert.ok(active.every(entry => entry.sourceRefs.every((ref: string) => !['m2', 'm3', 'm4', 'm9'].includes(ref))));
  assert.equal(memory.constraints[0].text, messages[0]!.text, 'negation, permission exception, and value/name boundary remain exact');
  assert.ok(memory.openWork.some((entry: { sourceRefs: string[] }) => entry.sourceRefs.includes('m1')), 'old independent pending stays open');
  assert.ok(memory.facts.some((entry: { sourceRefs: string[] }) => entry.sourceRefs.includes('m7')), 'a later return is retained without reopening old details');
  assert.equal(memory.facts.find((entry: { sourceRefs: string[] }) => entry.sourceRefs.includes('m6')).text, messages[6]!.text);
  assert.equal(memory.unresolvedDefects[0].text, `Наблюдённый неустранённый дефект: ${idsFor('m8').map(id => evidence[id]!.text).join(' ')}`);
  assert.ok(Buffer.byteLength(JSON.stringify(memory)) <= 32768);
  for (const updates of [
    { ...sourceUpdates, m0: undefined }, { ...sourceUpdates, m99: 'none' },
    { ...sourceUpdates, m2: '' }, { ...sourceUpdates, m2: 'closes:q999' },
    { ...sourceUpdates, m2: `closes:${idsFor('m0')[0]}` },
    { ...sourceUpdates, m2: `closes:${idsFor('m2')[0]}` },
    { ...sourceUpdates, m2: `closes:${idsFor('m3')[0]}` },
    { ...sourceUpdates, m2: `closes:${idsFor('m5')[0]}:m2,m2` },
    { ...sourceUpdates, m2: `closes:${idsFor('m5')[0]};supersedes:${idsFor('m6')[0]}` },
    { ...sourceUpdates, m5: `supersedes:${idsFor('m6')[0]}` },
  ]) assert.throws(() => compile({ ...resolution, sourceUpdates: updates }));
  for (const ref of ['m0', 'm1', 'm6', 'm7']) assert.throws(() => compile({ ...resolution,
    classifications: { ...resolution.classifications, [ref]: 'drop' } }), /Критичный|Замена/);
  const withoutTransitions = { ...resolution, sourceUpdates: Object.fromEntries(Object.keys(sourceUpdates).map(ref => [ref, 'none'])) };
  assert.throws(() => compile({ ...withoutTransitions, classifications: { ...resolution.classifications, m0: 'drop' } }), /Критичный/,
    'explicit none everywhere cannot authorize dropping a live exception');
  const schema = semanticCompactionResponseFormat(undefined, archive, `ЗАМЕТКИ\n${notes}`).schema;
  assert.ok('sourceUpdates' in schema.properties);
  assert.deepEqual(schema.properties.sourceUpdates.required, Object.keys(sourceUpdates));

  const grouped = JSON.stringify({ ...JSON.parse(notes), topics: [{ subject: 'Chart', sourceRefs: ['m1', 'm2', 'm3', 'm7'] }] });
  const topicReview = { ...resolution, topicUpdates: { Chart: `closes:${idsFor('m5')[0]}` },
    sourceUpdates: { ...sourceUpdates, m1: 'keep', m2: 'none', m3: 'none' },
    assistantOrigins: { m3: 'self', m9: 'm0' }, classifications: { ...resolution.classifications, m9: 'decision' } };
  const groupedCompile = (value: unknown) => JSON.parse(compileResolvedSemanticCompactionMemory(JSON.stringify(value), grouped, sources, refs, archive));
  const groupedMemory = groupedCompile(topicReview);
  assert.deepEqual(groupedMemory, memory, 'one whole-topic closure suppresses stale details and a broadened assistant paraphrase while keeping pending, exceptions and a later return');
  for (const change of [
    { topicUpdates: {} }, { topicUpdates: { Chart: `closes:${idsFor('m0')[0]}` } },
    { topicUpdates: { Chart: `supersedes:${idsFor('m5')[0]}` } },
    { assistantOrigins: {} }, { assistantOrigins: { m3: 'self', m9: 'm9' } },
    { assistantOrigins: { m3: 'm9', m9: 'm0' } },
    { classifications: { ...topicReview.classifications, m0: 'drop' } },
    { sourceUpdates: { ...topicReview.sourceUpdates, m9: 'keep' } },
  ]) assert.throws(() => groupedCompile({ ...topicReview, ...change }));
  const groupedSchema = semanticCompactionResponseFormat(undefined, archive, `ЗАМЕТКИ\n${grouped}`).schema;
  assert.ok('topicUpdates' in groupedSchema.properties);
  const witness = `${evidence[idsFor('m5')[0]!]!.text} [${idsFor('m5')[0]}]`;
  assert.ok(groupedSchema.properties.topicUpdates.properties.Chart!.enum.includes(witness));
  const decision = { state: 'Chart closed; independent queue and the observed mismatch remain open.',
    topicUpdates: { Chart: witness }, sourceUpdates: topicReview.sourceUpdates,
    activeTask: 'm5', unresolvedDefects: '', classifications: { ...topicReview.classifications, m9: 'paraphrase' } };
  assert.deepEqual(groupedCompile(decision), memory, 'explicit semantic decisions share the exact provenance and chronological guards');
  for (const change of [
    { topicUpdates: { Chart: `${witness} forged` } }, { topicUpdates: {} },
    { topicUpdates: { Chart: `${evidence[idsFor('m0')[0]!]!.text} [${idsFor('m0')[0]}]` } },
    { sourceUpdates: {} }, { classifications: { ...decision.classifications, m0: 'paraphrase' } },
    { activeTask: 'm3' },
    { state: '' }, { extra: 'forbidden' },
  ]) assert.throws(() => groupedCompile({ ...decision, ...change }));
});

test('review decision schema requires every source once and only later new user witnesses', () => {
  const { sources } = largeSemanticSources(), refs = getSemanticCompactionCoverageRefSet(sources);
  const archive = serializeSemanticCompactionTranscript(sources), evidence = semanticReviewEvidenceIndex(archive);
  const notes = JSON.stringify({ taskSubject: 'Report', state: 'Pending.', activeTask: 'm0', topics: [],
    notes: Object.fromEntries(refs.map(ref => [ref, 'Source note.'])), verbatim: Object.fromEntries(refs.map(ref => [ref, false])) });
  const reserved = semanticCompactionResponseFormat(undefined, archive).schema;
  const actual = semanticCompactionResponseFormat(undefined, archive, `ЗАМЕТКИ\n${notes}`).schema;
  assert.ok('sourceUpdates' in actual.properties && 'sourceUpdates' in reserved.properties);
  assert.deepEqual(actual.properties.sourceUpdates, reserved.properties.sourceUpdates);
  assert.deepEqual(actual.properties.sourceUpdates.required, refs);
  assert.deepEqual(actual.properties.classifications.properties.m1!.enum, ['paraphrase', 'decision', 'drop']);
  assert.ok(actual.properties.classifications.properties.m0!.enum.includes('constraint'));
  assert.deepEqual(actual.properties.topicUpdates.required, []);
  assert.equal(reserved.properties.topicUpdates.required.length, 2);
  assert.ok(reserved.properties.topicUpdates.required.every(subject => subject.length === 80));
  for (const [id, proof] of Object.entries(evidence)) {
    assert.equal(new RegExp(actual.properties.sourceUpdates.properties.m0!.pattern).test(`closes:${id}`), proof.role === 'user' && Number(proof.sourceRef.slice(1)) > 0);
  }
  assert.equal(Object.keys(actual.properties)[0], 'state');
});

test('rolling review decisions retain previous tools without replaying their raw prefix', () => {
  const { sources } = largeSemanticSources(), previous = validateSemanticCompactionMemory(semanticCandidate(), sources);
  const archive = serializeSemanticCompactionTranscript(sources, previous, 64), evidence = semanticReviewEvidenceIndex(archive);
  const schema = semanticCompactionResponseFormat(undefined, archive).schema;
  assert.ok('sourceUpdates' in schema.properties);
  assert.deepEqual(schema.properties.sourceUpdates.required, getSemanticCompactionCoverageRefSet(sources, previous, 64));
  for (const [id, proof] of Object.entries(evidence)) assert.equal(Object.values(schema.properties.topicUpdates.properties)[0]!.enum.includes(`${proof.text} [${id}]`), proof.role === 'user' && Number(proof.sourceRef.slice(1)) >= 64);
  assert.ok(schema.properties.sourceUpdates.properties.t0);
  assert.equal(schema.properties.sourceUpdates.properties.m2, undefined);
});

test('explicit absence of a task retains a primary constraint and rolling review cannot silently erase it', () => {
  const sources = createCompactionSources([user('policy', 'Do not delete backup copies.')], [], []);
  const notes = JSON.stringify({ taskSubject: 'Standing constraint', state: 'No active task.', activeTask: 'none', topics: [], notes: { m0: 'Preserve backups.' }, verbatim: { m0: true } });
  const memory = JSON.parse(compileResolvedSemanticCompactionMemory(JSON.stringify({ topicUpdates: {}, assistantOrigins: {}, sourceUpdates: { m0: 'none' }, activeTask: 'none', unresolvedDefects: '', classifications: { m0: 'constraint' } }), notes, sources, ['m0'], serializeSemanticCompactionTranscript(sources)));
  assert.equal(memory.activeTask, null);
  const rolling = createCompactionSources([user('policy', sources.messages[0]!.text), user('new', 'There is still no task; the restriction remains.')], [], []);
  const rollingNotes = JSON.stringify({ ...JSON.parse(notes), topics: [], notes: { m0: 'Old policy.', m1: 'No task.' }, verbatim: { m0: false, m1: false } });
  assert.throws(() => compileResolvedSemanticCompactionMemory(JSON.stringify({ topicUpdates: {}, assistantOrigins: {}, sourceUpdates: { m0: 'none', m1: 'none' }, activeTask: 'none', unresolvedDefects: '', classifications: { m0: 'drop', m1: 'fact' } }), rollingNotes, rolling, ['m0', 'm1'], serializeSemanticCompactionTranscript(rolling, memory, 1)), /Критичный/);
  const continued = JSON.parse(compileResolvedSemanticCompactionMemory(JSON.stringify({ topicUpdates: {}, assistantOrigins: {}, sourceUpdates: { m0: 'none', m1: 'none' }, activeTask: 'none', unresolvedDefects: '', classifications: { m0: 'decision', m1: 'fact' } }), rollingNotes, rolling, ['m0', 'm1'], serializeSemanticCompactionTranscript(rolling, memory, 1)));
  assert.equal(continued.decisions[0].text, sources.messages[0]!.text, 'rolling critical text survives reclassification even when the new draft clears verbatim');
});

test('segmented semantic input reconstructs every source and rejects malformed envelopes', () => {
  const archive = serializeSemanticCompactionTranscript(semanticSources());
  const decode = (text: string) => JSON.parse(text.slice(text.indexOf('\n') + 1)) as Record<string, unknown>;
  const [metadata, ...records] = splitSemanticCompactionTranscript(archive);
  assert.deepEqual({ ...decode(metadata!), messages: records.map(decode) }, decode(archive));
  assert.throws(() => splitSemanticCompactionTranscript('not an archive'));
  assert.throws(() => splitSemanticCompactionTranscript('archive\n{"format":"wrong","version":1,"messages":[{}]}'));
  assert.throws(() => splitSemanticCompactionTranscript('archive\n{"format":"gigachat-semantic-compaction-input","version":1,"messages":[]}'));
});

test('new generated facts require evidence while old stored memories still accept missing quotes', () => {
  const sources = semanticSources();
  const value = semanticCandidate({ facts: [{ text: 'An unsupported paraphrase.', sourceRefs: ['m1'], exactQuotes: [] }] });
  assert.doesNotThrow(() => validateSemanticCompactionMemory(value, sources));
  assert.throws(() => compileGeneratedSemanticCompactionMemory(value, sources, ['m0', 'm1', 'm2', 't0']), /дословное основание/);
  const quoted = semanticCandidate({ facts: [{ text: 'The tool content was read.', sourceRefs: ['t0'],
    exactQuotes: [{ sourceRef: 't0', text: 'Проверено чтением' }] }] });
  assert.doesNotThrow(() => compileGeneratedSemanticCompactionMemory(quoted, sources, ['m0', 'm1', 'm2', 't0']));
});

test('rejects unknown or duplicate refs, extra keys, malformed controls and invalid markers', () => {
  const sources = semanticSources();
  const base = JSON.parse(semanticCandidate()) as Record<string, unknown>;
  const invalid = [
    ['wrong format', { ...base, format: 'summary' }, /неверную версию или структуру/],
    ['wrong version', { ...base, version: 2 }, /неверную версию или структуру/],
    ['extra root key', { ...base, permission: 'allow' }, /неверную версию или структуру/],
    ['unknown message ref', { ...base, activeTask: { text: 'Продолжить отчёт.', sourceRefs: ['m99'] } }, /неизвестную или повторную ссылку/],
    ['unknown tool ref', { ...base, activeTask: { text: 'Продолжить отчёт.', sourceRefs: ['t99'] } }, /неизвестную или повторную ссылку/],
    ['duplicate refs in entry', { ...base, activeTask: { text: 'Продолжить отчёт.', sourceRefs: ['m0', 'm0'] } }, /неизвестную или повторную ссылку/],
    ['extra entry key', { ...base, decisions: [{ text: 'Сохранить решение.', sourceRefs: ['m1'], extra: true }] }, /неверную структуру/],
    ['control in memory text', { ...base, activeTask: { text: 'Продолжить\u0001отчёт.', sourceRefs: ['m0'] } }, /некорректный текст/],
    ['placeholder text', { ...base, activeTask: { text: 'summary', sourceRefs: ['m0'] } }, /служебный/],
    ['pipe-only memory', { ...base, activeTask: { text: '|', sourceRefs: ['m0'] } }, /служебный/],
  ] as const;
  for (const [label, candidate, expected] of invalid) {
    assert.throws(() => validateSemanticCompactionMemory(JSON.stringify(candidate), sources), expected, label);
  }
  assert.throws(() => validateSemanticCompactionMemory(' '.repeat(64 * 1024 + 1), sources), /превышает допустимый размер/);
});

test('bounds past topics, individual entries and aggregate serialized semantic memory', () => {
  const sources = semanticSources();
  const base = JSON.parse(semanticCandidate()) as Record<string, unknown>;
  const tooManyTopics = Array.from({ length: 9 }, (_, index) => ({ text: `Закрытая тема ${index + 1}.`, sourceRefs: ['m0'] }));
  assert.throws(() => validateSemanticCompactionMemory(JSON.stringify({ ...base, pastTopics: tooManyTopics }), sources), /Список семантической памяти превышает/);
  assert.throws(() => validateSemanticCompactionMemory(semanticCandidate({ activeTask: { text: 'x'.repeat(4 * 1024 + 1), sourceRefs: ['m0'] } }), sources), /служебный или некорректный текст/);
  const oversizedFacts = Array.from({ length: 8 }, (_, index) => ({ text: `${index + 1}${'x'.repeat(4 * 1024 - 1)}`, sourceRefs: ['m1'] }));
  assert.throws(() => compileSemanticCompactionMemory(semanticCandidate({ facts: oversizedFacts }), sources), /ограничение 32 КиБ/);

  const legacyMemory = {
    format: 'gigachat-semantic-memory', version: 1, activeTask: null,
    constraints: [], decisions: [], openWork: [], facts: [],
    pastTopics: Array.from({ length: 8 }, (_, index) => ({
      text: `Подробный архивный итог ${index + 1}. `.repeat(40).trim(), sourceRefs: ['m0'],
    })),
  };
  const reopened = validateSemanticCompactionMemory(JSON.stringify(legacyMemory), sources);
  assert.equal(reopened.pastTopics.length, 8, 'the stricter provider generation schema does not restrict stored-memory compatibility');
  assert.ok(reopened.pastTopics.every((topic) => topic.text.length > 256));
});

test('keeps the legacy extractive version-2 contract separate from semantic memory version 1', () => {
  const sources = createCompactionSources([user('u1', 'Сохранить старый формат.')], [], []);
  const legacy = compileExtractiveCompaction(selection(true), sources);

  assert.deepEqual(JSON.parse(legacy), [retainedRefs(0), ['user', 'Сохранить старый формат.']]);
  assert.throws(() => validateSemanticCompactionMemory(legacy, sources), /неверную версию или структуру/);
});
