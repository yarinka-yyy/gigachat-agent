import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { GigaChatProvider, ProviderEvent, ProviderTurnRequest } from './contracts';
import type { LocalTools } from './local-tools';
import { createImageGenerationStream, IMAGE_GENERATION_MODEL_ID, IMAGE_RECOVERY_REQUIRED_MESSAGE, inspectGeneratedImageBytes } from './image-generation';
import type { ImageGenerationProvider, ImageGenerationStreamOptions } from './image-generation';
import { GigaChatProviderError } from './gigachat-provider';
import type { ProviderImageGenerationEvent, ProviderImageGenerationRequest } from './gigachat-provider';
import { createTurnRuntime, type PreparedTurn } from './runtime';
import { assertProviderStateOwner, captureProviderStateOwner } from './provider-state';
import { createBalanceScopeGuard } from './usage-view';
import { openStore, type LocalStore } from './store';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jHfQAAAAASUVORK5CYII=', 'base64');
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==', 'base64');
const TEST_KEY = 'image generation synthetic account key';
const USAGE = { promptTokens: 100, completionTokens: 20, totalTokens: 120, precachedPromptTokens: 0 } as const;

function imageEvents(fileId: string, assistantText: string): ProviderImageGenerationEvent[] {
  return [
    { type: 'usage', usage: USAGE },
    { type: 'generated-image', image: { fileId, contentType: 'image/png', assistantText } },
    { type: 'completed' },
  ];
}

async function createImageChat(store: LocalStore, chatName: string) {
  const chat = await store.createChat(undefined, 'image');
  await store.updateChat(chat.id, { title: chatName, modelId: IMAGE_GENERATION_MODEL_ID });
  return chat;
}

async function acceptImageTurn(store: LocalStore, chatId: string, turnId: string, text: string) {
  return store.acceptLocalMessage(chatId, text, turnId, [], IMAGE_GENERATION_MODEL_ID);
}

function createRuntimeForImageStore(store: LocalStore, imageProvider: ImageGenerationProvider, options: {
  guard?: ReturnType<typeof createBalanceScopeGuard>;
  getKey?: () => Promise<string>;
  beforeUsageReceipt?: () => Promise<void>;
  validateDecodedImage?: ImageGenerationStreamOptions['validateDecodedImage'];
  unavailableCoordinatorChatIds?: readonly string[];
  transformRequest?: (request: ProviderTurnRequest) => ProviderTurnRequest;
} = {}) {
  const guard = options.guard ?? createBalanceScopeGuard();
  const getKey = options.getKey ?? (async () => TEST_KEY);
  const preparationCalls: string[] = [];
  const hookEvents: string[] = [];
  const usageObservedAfterDescriptor: boolean[] = [];
  const appendCalls: string[] = [];
  let capturedAccountScope: string | null = null;
  let stageCalls = 0;
  const provider: GigaChatProvider = {
    stream: () => { throw new Error('Image mode used the ordinary text provider.'); },
  };
  const imageStore = new Proxy(store, {
    get(target, property, receiver) {
      if (property === 'getChat') return async (chatId: string) => {
        if (options.unavailableCoordinatorChatIds?.includes(chatId)) throw new Error('synthetic chat unavailable');
        return target.getChat(chatId);
      };
      if (property === 'stageGeneratedImage') return async (...args: Parameters<LocalStore['stageGeneratedImage']>) => {
        stageCalls += 1;
        return target.stageGeneratedImage(...args);
      };
      return Reflect.get(target, property, receiver);
    },
  });
  const runtime = createTurnRuntime({
    provider,
    tools: {} as LocalTools,
    prepareTurn: async (turn, signal): Promise<ProviderTurnRequest | PreparedTurn> => {
      const owner = await captureProviderStateOwner(guard, getKey, signal);
      capturedAccountScope = owner.accountScope;
      await store.validateAcceptedTurn(turn);
      const request: ProviderTurnRequest = {
        system: [],
        modelId: turn.modelId,
        messages: await store.getMessagesThrough(turn.chatId, turn.messageId),
        protocolHistory: await store.getToolProtocolThrough(turn.chatId, turn.messageId),
        permissionProfile: turn.permissionProfile,
        functionCallMode: 'none',
      };
      const preparedRequest = options.transformRequest?.(request) ?? request;
      return {
        request: preparedRequest,
        providerStateOwner: owner,
        imageGeneration: createImageGenerationStream({
          store: imageStore,
          provider: imageProvider,
          owner,
          turn,
          request: preparedRequest,
          signal,
          assertCurrent: (currentSignal) => assertProviderStateOwner(owner, guard, currentSignal),
          validateDecodedImage: options.validateDecodedImage ?? ((bytes, contentType, dimensions) => {
            assert.equal(contentType, 'image/png');
            assert.equal(bytes.byteLength, PNG.byteLength);
            assert.deepEqual(dimensions, { width: 1, height: 1 });
          }),
        }),
      };
    },
    prepareProviderRequest: async (_turn, request) => {
      preparationCalls.push('called');
      return request;
    },
    assertProviderStateOwner: (owner, signal) => assertProviderStateOwner(owner, guard, signal),
    consumeTurn: (turn, signal) => store.consumeTurnReservation(turn, signal),
    releaseTurn: (turn) => store.releaseTurnReservation(turn.turnId),
    persistTurnRecord: (turn) => store.updateRuntimeTurn(turn),
    appendAssistant: async (turn, text, signal, functionsStateId, terminalTurn, owner, generatedArtifactId) => {
      appendCalls.push(turn.turnId);
      assertProviderStateOwner(owner, guard, signal);
      await store.appendAssistantMessageFromRuntime(turn, text, terminalTurn, signal, functionsStateId,
        functionsStateId || generatedArtifactId ? owner.accountScope : undefined, generatedArtifactId);
    },
    recordUsageReceipt: async (receipt) => {
      if (receipt.totalTokens !== null && receipt.modelId === IMAGE_GENERATION_MODEL_ID) {
        const rows = await store.getProviderGeneratedImageEntries(capturedAccountScope ?? '');
        const descriptorExists = rows.some((row) =>
          (row.state === 'generated' || row.state === 'downloaded') && row.remoteFileId !== null);
        usageObservedAfterDescriptor.push(descriptorExists);
        if (descriptorExists) await options.beforeUsageReceipt?.();
      }
      await store.recordUsageReceipt(receipt);
    },
    validateRetry: async (retry, original) => {
      const owner = await captureProviderStateOwner(guard, getKey);
      assertProviderStateOwner(owner, guard);
      const rows = await store.getProviderGeneratedImageEntries(owner.accountScope);
      assertProviderStateOwner(owner, guard);
      if (rows.some((row) => row.chatId === original.chatId && row.anchorMessageId === original.messageId)) {
        throw new Error(IMAGE_RECOVERY_REQUIRED_MESSAGE);
      }
      await store.reserveRetryTurn(original, retry);
    },
    runHooks: async (_turn, input) => {
      hookEvents.push(input.event);
      return [];
    },
  });
  return { runtime, preparationCalls, hookEvents, usageObservedAfterDescriptor, appendCalls, guard, getKey, get stageCalls() { return stageCalls; } };
}

test('PNG/JPEG inspection is bounded and the JPEG fixture is genuine', () => {
  assert.deepEqual(inspectGeneratedImageBytes(PNG, 'image/png'), { width: 1, height: 1 });
  assert.deepEqual(inspectGeneratedImageBytes(JPEG, 'image/jpeg'), { width: 1, height: 1 });
  assert.equal(createHash('sha256').update(JPEG).digest('hex'), 'cb3811c1599a9871648272ceaaa21982c7e92deabc367facea3a6941e9804a9b');
  assert.equal(inspectGeneratedImageBytes(PNG.subarray(0, PNG.length - 8), 'image/png'), null);
  assert.equal(inspectGeneratedImageBytes(JPEG, 'image/png'), null);
  assert.equal(inspectGeneratedImageBytes(Buffer.alloc(15_000_001), 'image/jpeg'), null);
  const oversizedPng = Buffer.from(PNG);
  oversizedPng.writeUInt32BE(0xffff_ffff, 16);
  assert.equal(inspectGeneratedImageBytes(oversizedPng, 'image/png'), null);
  const emptyIdatPadding = Buffer.from([0, 0, 0, 0, 0x49, 0x44, 0x41, 0x54, 0x35, 0xaf, 0x06, 0x1e]);
  const paddedPng = Buffer.concat([PNG.subarray(0, 33), emptyIdatPadding, PNG.subarray(33)]);
  assert.deepEqual(inspectGeneratedImageBytes(paddedPng, 'image/png'), { width: 1, height: 1 });
});

test('Runtime stores image results atomically and the next image retains assistant text without reattaching bytes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-runtime-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await createImageChat(store, 'Image runtime fixture');
  const requests: ProviderImageGenerationRequest[] = [];
  const order: string[] = [];
  const deleted: string[] = [];
  let generation = 0;
  const imageProvider: ImageGenerationProvider = {
    generateImage: (request) => {
      generation += 1;
      requests.push(structuredClone(request));
      order.push(`generation-${generation}`);
      return (async function* () {
        for (const event of imageEvents(`remote-image-${generation}`, `Generated image ${generation}.`)) yield event;
      })();
    },
    downloadGeneratedImage: async (fileId) => {
      order.push(`download-${fileId}`);
      return Buffer.from(PNG);
    },
    deleteFile: async (fileId) => { deleted.push(fileId); order.push(`delete-${fileId}`); },
  };
  const harness = createRuntimeForImageStore(store, imageProvider);
  const first = await acceptImageTurn(store, chat.id, 'image-runtime-first', 'Create the first image.');
  assert.equal(harness.runtime.enqueue(first.turn), first.turn.turnId);
  await harness.runtime.whenIdle();

  const firstDetail = await store.getChat(chat.id);
  const firstAssistant = firstDetail.messages.find((message) => message.id === first.turn.assistantMessageId);
  assert.equal(firstAssistant?.text, 'Generated image 1.');
  assert.equal(firstAssistant?.source, 'runtime');
  assert.equal(firstAssistant?.attachmentIds?.length, 1);
  const firstArtifactId = firstAssistant!.attachmentIds![0]!;
  assert.equal(firstDetail.artifacts.some((artifact) => artifact.id === firstArtifactId && artifact.messageId === firstAssistant?.id), true);
  assert.deepEqual(await readFile(await store.getArtifactPath(chat.id, firstArtifactId)), PNG);
  assert.deepEqual(await store.getProviderGeneratedImageEntries((await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY)).accountScope)
    .then((rows) => rows.map((row) => row.state)), ['downloaded']);
  assert.ok(harness.usageObservedAfterDescriptor.length > 0, 'at least one known usage receipt was persisted after image ownership');
  assert.equal(harness.usageObservedAfterDescriptor.every(Boolean), true);
  assert.deepEqual(harness.preparationCalls, [], 'image mode does not upload or prepare ordinary provider attachments');
  assert.deepEqual(harness.hookEvents, ['user-prompt-submitted', 'stop']);

  const second = await acceptImageTurn(store, chat.id, 'image-runtime-second', 'Create a second image.');
  assert.equal(harness.runtime.enqueue(second.turn), second.turn.turnId);
  await harness.runtime.whenIdle();
  assert.deepEqual(deleted, ['remote-image-1'], 'the prior exact owned backup is deleted only after a verified local result exists');
  assert.ok(order.indexOf('delete-remote-image-1') < order.indexOf('generation-2'));
  const firstAssistantInSecondRequest = requests[1]?.messages.find((message) => message.role === 'assistant');
  assert.equal(firstAssistantInSecondRequest?.text, 'Generated image 1.');
  assert.equal('attachmentIds' in (firstAssistantInSecondRequest ?? {}), false, 'saved assistant image bytes are not silently sent as an edit input');
  assert.deepEqual(requests[1]?.messages.map(({ role, text }) => ({ role, text })), [
    { role: 'user', text: 'Create the first image.' },
    { role: 'assistant', text: 'Generated image 1.' },
    { role: 'user', text: 'Create a second image.' },
  ]);
  assert.equal(harness.runtime.list(chat.id).every((turn) => turn.status === 'completed'), true);
  assert.equal((await store.getProviderGeneratedImageEntries((await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY)).accountScope))
    .every((row) => row.artifactId !== firstArtifactId), true, 'confirmed cleanup removes only the first ledger row');
  const reopened = await openStore(directory);
  const reopenedDetail = await reopened.getChat(chat.id);
  assert.equal(reopenedDetail.messages.some((message) => message.id === firstAssistant?.id && message.attachmentIds?.includes(firstArtifactId)), true);
  assert.deepEqual(await readFile(await reopened.getArtifactPath(chat.id, firstArtifactId)), PNG);
  assert.equal((await reopened.getUsageLedger()).byChat.find((row) => row.key === chat.id)?.totalTokens.knownTokens, 240);
});

test('an account switch after descriptor persistence keeps the known remote row under its captured owner', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-owner-transition-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await createImageChat(store, 'Image owner transition');
  const guard = createBalanceScopeGuard();
  let currentKey = TEST_KEY;
  let switched = false;
  let generationCalls = 0;
  let downloadCalls = 0;
  let deleteCalls = 0;
  const imageProvider: ImageGenerationProvider = {
    generateImage: () => {
      generationCalls += 1;
      return (async function* () { yield* imageEvents('remote-owner-a', 'Known remote result.'); })();
    },
    downloadGeneratedImage: async () => { downloadCalls += 1; return PNG; },
    deleteFile: async () => { deleteCalls += 1; },
  };
  const harness = createRuntimeForImageStore(store, imageProvider, {
    guard,
    getKey: async () => currentKey,
    beforeUsageReceipt: async () => {
      if (switched) return;
      const finishTransition = guard.beginTransition();
      currentKey = `${TEST_KEY} B`;
      finishTransition();
      switched = true;
    },
  });
  const accepted = await acceptImageTurn(store, chat.id, 'image-owner-transition-turn', 'Create one image.');
  assert.equal(harness.runtime.enqueue(accepted.turn), accepted.turn.turnId);
  await harness.runtime.whenIdle();

  const ownerA = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
  const ownerB = await captureProviderStateOwner(createBalanceScopeGuard(), async () => `${TEST_KEY} B`);
  const rowsA = await store.getProviderGeneratedImageEntries(ownerA.accountScope);
  const rowsB = await store.getProviderGeneratedImageEntries(ownerB.accountScope);
  assert.equal(harness.runtime.list(chat.id)[0]?.status, 'failed');
  assert.equal(rowsA.length, 1);
  assert.equal(rowsA[0]?.state, 'generated');
  assert.equal(rowsA[0]?.remoteFileId, 'remote-owner-a');
  assert.deepEqual(rowsB, []);
  assert.equal(generationCalls, 1);
  assert.deepEqual({ downloadCalls, stageCalls: harness.stageCalls, deleteCalls, appendCalls: harness.appendCalls.length },
    { downloadCalls: 0, stageCalls: 0, deleteCalls: 0, appendCalls: 0 });
  assert.ok(harness.usageObservedAfterDescriptor.length > 0);
  assert.equal(harness.usageObservedAfterDescriptor.every(Boolean), true);
});

test('download and decoder failures keep the known remote descriptor and block a same-anchor retry', async (t) => {
  for (const failure of ['download', 'decoder'] as const) {
    const directory = await mkdtemp(join(tmpdir(), `gigachat-image-${failure}-failure-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = await openStore(directory);
    const chat = await createImageChat(store, `Image ${failure} failure`);
    let generationCalls = 0;
    let downloadCalls = 0;
    const imageProvider: ImageGenerationProvider = {
      generateImage: () => {
        generationCalls += 1;
        return (async function* () { yield* imageEvents(`remote-${failure}-failure`, 'Not committed.'); })();
      },
      downloadGeneratedImage: async () => {
        downloadCalls += 1;
        if (failure === 'download') throw new GigaChatProviderError('network', true);
        return PNG;
      },
      deleteFile: async () => { throw new Error('No backup cleanup expected after failure.'); },
    };
    const harness = createRuntimeForImageStore(store, imageProvider, {
      ...(failure === 'decoder' ? { validateDecodedImage: () => { throw new Error('synthetic decoder rejection'); } } : {}),
    });
    const accepted = await acceptImageTurn(store, chat.id, `image-${failure}-failure-turn`, 'Create a protected result.');
    assert.equal(harness.runtime.enqueue(accepted.turn), accepted.turn.turnId);
    await harness.runtime.whenIdle();

    const owner = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
    const rows = await store.getProviderGeneratedImageEntries(owner.accountScope);
    const detail = await store.getChat(chat.id);
    assert.equal(harness.runtime.list(chat.id)[0]?.status, 'failed');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.state, 'generated');
    assert.equal(rows[0]?.remoteFileId, `remote-${failure}-failure`);
    assert.equal(detail.artifacts.some((artifact) => artifact.id === rows[0]?.artifactId), false);
    assert.equal(detail.messages.find((message) => message.id === accepted.turn.assistantMessageId)?.attachmentIds, undefined);
    assert.equal(harness.stageCalls, 0);
    assert.equal(downloadCalls, 1);
    assert.equal((await store.getUsageLedger()).byChat.find((row) => row.key === chat.id)?.totalTokens.knownTokens, USAGE.totalTokens);
    await assert.rejects(harness.runtime.retry(accepted.turn.turnId), { message: IMAGE_RECOVERY_REQUIRED_MESSAGE },
      'the Runtime retry guard rejects the retained result without another generation');
    assert.equal(generationCalls, 1);

    const retryTurn = { ...accepted.turn, turnId: `image-${failure}-same-anchor-retry` };
    await store.updateRuntimeTurn({
      id: retryTurn.turnId,
      chatId: retryTurn.chatId,
      anchorMessageId: retryTurn.messageId,
      assistantMessageId: retryTurn.assistantMessageId,
      modelId: retryTurn.modelId,
      status: 'queued',
      createdAt: new Date().toISOString(),
      activity: [],
    });
    const retryOwner = await captureProviderStateOwner(harness.guard, harness.getKey);
    const retryEvents: ProviderEvent[] = [];
    for await (const event of createImageGenerationStream({
      store,
      provider: imageProvider,
      owner: retryOwner,
      turn: retryTurn,
      request: {
        system: [],
        modelId: retryTurn.modelId,
        messages: await store.getMessagesThrough(chat.id, retryTurn.messageId),
        protocolHistory: await store.getToolProtocolThrough(chat.id, retryTurn.messageId),
        permissionProfile: retryTurn.permissionProfile,
        functionCallMode: 'none',
      },
      signal: new AbortController().signal,
      assertCurrent: (signal) => assertProviderStateOwner(retryOwner, harness.guard, signal),
      validateDecodedImage: () => undefined,
    })) retryEvents.push(event);
    assert.equal(retryEvents.some((event) => event.type === 'error' && event.category === 'storage'), true,
      'the coordinator rejects a new queued turn that reuses the retained image anchor');
    assert.equal(retryEvents.some((event) => event.type === 'image-result' || event.type === 'completed'), false);
    assert.equal(generationCalls, 1);
    assert.equal(downloadCalls, 1);
    assert.equal(harness.stageCalls, 0);
    assert.equal(harness.appendCalls.length, 0);
    const rowsAfterDirectRetry = await store.getProviderGeneratedImageEntries(owner.accountScope);
    assert.equal(rowsAfterDirectRetry.length, 1);
    assert.equal(rowsAfterDirectRetry[0]?.state, 'generated');
  }
});

test('wrong image kind, model, attachment and stale anchor fail before an intent or provider call', async (t) => {
  const scenarios = ['wrong-kind', 'wrong-model', 'user-attachment', 'changed-prompt', 'assistant-tail'] as const;
  for (const [index, scenario] of scenarios.entries()) {
    const directory = await mkdtemp(join(tmpdir(), `gigachat-image-preflight-${index}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const store = await openStore(directory);
    const imageChat = scenario !== 'wrong-kind';
    const chat = imageChat ? await createImageChat(store, scenario) : await store.createChat(undefined, 'text');
    const modelId = scenario === 'wrong-model' ? 'GigaChat-3-Pro' : IMAGE_GENERATION_MODEL_ID;
    await store.updateChat(chat.id, { modelId });
    let attachmentIds: string[] = [];
    if (scenario === 'user-attachment') {
      const sourcePath = join(directory, 'fixture.txt');
      await writeFile(sourcePath, 'Synthetic attachment.');
      const staged = await store.stageChatDraftFile(chat.id, sourcePath);
      attachmentIds = [staged.draftAttachments[0]!.id];
    }
    const accepted = await store.acceptLocalMessage(chat.id, 'Create an image.', `image-preflight-${index}`,
      attachmentIds, modelId);
    let generationCalls = 0;
    let downloadCalls = 0;
    let deleteCalls = 0;
    const imageProvider: ImageGenerationProvider = {
      generateImage: () => {
        generationCalls += 1;
        return (async function* () { yield* imageEvents('remote-should-not-exist', 'Never generated.'); })();
      },
      downloadGeneratedImage: async () => { downloadCalls += 1; return PNG; },
      deleteFile: async () => { deleteCalls += 1; },
    };
    const harness = createRuntimeForImageStore(store, imageProvider, {
      transformRequest: (request) => scenario === 'changed-prompt'
        ? { ...request, messages: request.messages.map((message) => message.id === accepted.turn.messageId ? { ...message, text: 'Changed after acceptance.' } : message) }
        : scenario === 'assistant-tail'
          ? { ...request, messages: [...request.messages, {
            id: 'unexpected-assistant-tail', role: 'assistant', text: 'Unexpected tail.', createdAt: new Date().toISOString(),
          }] }
          : request,
    });
    assert.equal(harness.runtime.enqueue(accepted.turn), accepted.turn.turnId);
    await harness.runtime.whenIdle();

    const owner = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
    assert.equal(harness.runtime.list(chat.id)[0]?.status, 'failed', scenario);
    assert.deepEqual(await store.getProviderGeneratedImageEntries(owner.accountScope), [], scenario);
    assert.deepEqual({ generationCalls, downloadCalls, deleteCalls, stageCalls: harness.stageCalls, appendCalls: harness.appendCalls.length },
      { generationCalls: 0, downloadCalls: 0, deleteCalls: 0, stageCalls: 0, appendCalls: 0 }, scenario);
  }
});

test('an unavailable prior image chat preserves its remote backup while a separate image proceeds', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-unavailable-chat-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const oldChat = await createImageChat(store, 'Prior image chat');
  let generationCalls = 0;
  const deleted: string[] = [];
  const imageProvider: ImageGenerationProvider = {
    generateImage: () => {
      generationCalls += 1;
      return (async function* () { yield* imageEvents(`remote-unavailable-${generationCalls}`, `Image ${generationCalls}.`); })();
    },
    downloadGeneratedImage: async () => PNG,
    deleteFile: async (fileId) => { deleted.push(fileId); },
  };
  const firstHarness = createRuntimeForImageStore(store, imageProvider);
  const first = await acceptImageTurn(store, oldChat.id, 'image-unavailable-first', 'Prior image.');
  assert.equal(firstHarness.runtime.enqueue(first.turn), first.turn.turnId);
  await firstHarness.runtime.whenIdle();
  const owner = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
  const priorRow = (await store.getProviderGeneratedImageEntries(owner.accountScope))[0]!;

  const currentChat = await createImageChat(store, 'Current image chat');
  const nextHarness = createRuntimeForImageStore(store, imageProvider, { unavailableCoordinatorChatIds: [oldChat.id] });
  const next = await acceptImageTurn(store, currentChat.id, 'image-unavailable-next', 'Current image.');
  assert.equal(nextHarness.runtime.enqueue(next.turn), next.turn.turnId);
  await nextHarness.runtime.whenIdle();

  const rows = await store.getProviderGeneratedImageEntries(owner.accountScope);
  assert.equal(generationCalls, 2);
  assert.deepEqual(deleted, []);
  assert.ok(rows.some((row) => row.artifactId === priorRow.artifactId && row.remoteFileId === priorRow.remoteFileId && row.state === 'downloaded'));
  assert.ok(rows.some((row) => row.turnId === next.turn.turnId && row.state === 'downloaded'));
});

test('provider failure preserves a received remote image descriptor and known usage without downloading', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-known-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await createImageChat(store, 'Known descriptor failure');
  let downloads = 0;
  const imageProvider: ImageGenerationProvider = {
    generateImage: () => (async function* () {
      yield { type: 'usage', usage: USAGE };
      yield { type: 'generated-image', image: { fileId: 'remote-known-failure', contentType: 'image/png' } };
      yield { type: 'error', category: 'network', retryable: true };
    })(),
    downloadGeneratedImage: async () => { downloads += 1; return PNG; },
    deleteFile: async () => undefined,
  };
  const harness = createRuntimeForImageStore(store, imageProvider);
  const accepted = await acceptImageTurn(store, chat.id, 'image-known-failure-turn', 'Create an image.');
  assert.equal(harness.runtime.enqueue(accepted.turn), accepted.turn.turnId);
  await harness.runtime.whenIdle();

  const owner = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
  const entries = await store.getProviderGeneratedImageEntries(owner.accountScope);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.state, 'generated');
  assert.equal(entries[0]?.remoteFileId, 'remote-known-failure');
  assert.equal(downloads, 0);
  assert.equal((await store.getChat(chat.id)).messages.length, 1, 'no assistant artifact is appended on provider failure');
  const ledger = await store.getUsageLedger();
  const usage = ledger.byChat.find((row) => row.key === chat.id);
  assert.equal(usage?.totalTokens.knownTokens, USAGE.totalTokens);
  assert.equal(usage?.failedRequestCount, 1);
});

test('provider failure before a descriptor retains an unknown intent and does not list or guess remote IDs', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-unknown-failure-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await createImageChat(store, 'Unknown image outcome');
  let generations = 0;
  let downloads = 0;
  let deletions = 0;
  const imageProvider: ImageGenerationProvider = {
    generateImage: () => {
      generations += 1;
      return (async function* () {
        yield { type: 'usage', usage: USAGE };
        yield { type: 'error', category: 'network', retryable: true };
      })();
    },
    downloadGeneratedImage: async () => { downloads += 1; return PNG; },
    deleteFile: async () => { deletions += 1; },
  };
  const harness = createRuntimeForImageStore(store, imageProvider);
  const accepted = await acceptImageTurn(store, chat.id, 'image-unknown-failure-turn', 'Create an image.');
  assert.equal(harness.runtime.enqueue(accepted.turn), accepted.turn.turnId);
  await harness.runtime.whenIdle();
  const owner = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
  const entries = await store.getProviderGeneratedImageEntries(owner.accountScope);
  assert.equal(generations, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.state, 'unknown');
  assert.equal(entries[0]?.remoteFileId, null);
  assert.deepEqual({ downloads, deletions, prepareProviderRequest: harness.preparationCalls.length }, { downloads: 0, deletions: 0, prepareProviderRequest: 0 });
  assert.equal((await store.getUsageLedger()).byChat.find((row) => row.key === chat.id)?.totalTokens.knownTokens, USAGE.totalTokens);
});

test('cleanup 404 remains pending and missing local bytes never authorize deletion', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-cleanup-404-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await createImageChat(store, 'Image cleanup evidence');
  let generationCount = 0;
  let rejectDelete = false;
  const deleted: string[] = [];
  const imageProvider: ImageGenerationProvider = {
    generateImage: () => {
      generationCount += 1;
      return (async function* () {
        for (const event of imageEvents(`remote-cleanup-${generationCount}`, `Image ${generationCount}.`)) yield event;
      })();
    },
    downloadGeneratedImage: async () => PNG,
    deleteFile: async (fileId) => {
      deleted.push(fileId);
      if (rejectDelete) throw new GigaChatProviderError('model', false, 404);
    },
  };
  const harness = createRuntimeForImageStore(store, imageProvider);
  const first = await acceptImageTurn(store, chat.id, 'image-cleanup-first', 'First image.');
  assert.equal(harness.runtime.enqueue(first.turn), first.turn.turnId);
  await harness.runtime.whenIdle();
  const owner = await captureProviderStateOwner(createBalanceScopeGuard(), async () => TEST_KEY);
  const firstRow = (await store.getProviderGeneratedImageEntries(owner.accountScope))[0]!;
  const firstAssistant = (await store.getChat(chat.id)).messages.find((message) => message.id === first.turn.assistantMessageId)!;
  const localPath = await store.getArtifactPath(chat.id, firstRow.artifactId);
  assert.equal(firstAssistant.attachmentIds?.includes(firstRow.artifactId), true);

  rejectDelete = true;
  const second = await acceptImageTurn(store, chat.id, 'image-cleanup-404', 'Second image.');
  assert.equal(harness.runtime.enqueue(second.turn), second.turn.turnId);
  await harness.runtime.whenIdle();
  const pending = await store.getProviderGeneratedImageEntries(owner.accountScope);
  assert.equal(generationCount, 2, 'an exact delete 404 leaves cleanup pending but does not block a distinct new image request');
  assert.ok(pending.some((row) => row.artifactId === firstRow.artifactId && row.state === 'cleanup-pending'));
  assert.ok(pending.some((row) => row.turnId === second.turn.turnId && row.state === 'downloaded'));
  assert.equal(pending.find((row) => row.artifactId === firstRow.artifactId)?.remoteFileId, firstRow.remoteFileId);
  assert.deepEqual(deleted, [firstRow.remoteFileId]);

  rejectDelete = false;
  await rm(localPath);
  const third = await acceptImageTurn(store, chat.id, 'image-cleanup-missing-original', 'Third image.');
  assert.equal(harness.runtime.enqueue(third.turn), third.turn.turnId);
  await harness.runtime.whenIdle();
  const afterMissingOriginal = await store.getProviderGeneratedImageEntries(owner.accountScope);
  assert.equal(generationCount, 3);
  assert.deepEqual(deleted, [firstRow.remoteFileId, 'remote-cleanup-2']);
  assert.equal(afterMissingOriginal.some((row) => row.turnId === second.turn.turnId), false);
  assert.ok(afterMissingOriginal.some((row) => row.artifactId === firstRow.artifactId && row.state === 'cleanup-pending'));
});

test('coordinator propagates an unconfirmed provider iterator return', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'gigachat-image-provider-return-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = await openStore(directory);
  const chat = await createImageChat(store, 'Image iterator stop');
  const accepted = await acceptImageTurn(store, chat.id, 'image-provider-return-turn', 'Create an image.');
  const guard = createBalanceScopeGuard();
  const owner = await captureProviderStateOwner(guard, async () => TEST_KEY);
  const request: ProviderTurnRequest = {
    system: [], messages: await store.getMessagesThrough(chat.id, accepted.turn.messageId),
    protocolHistory: [], modelId: IMAGE_GENERATION_MODEL_ID, permissionProfile: accepted.turn.permissionProfile,
    functionCallMode: 'none',
  };
  let returnCalls = 0;
  const underlying: AsyncIterator<ProviderImageGenerationEvent> = {
    next: async () => ({ done: false, value: { type: 'error', category: 'network', retryable: true } }),
    return: async () => { returnCalls += 1; throw new Error('underlying iterator did not confirm close'); },
  };
  const imageProvider: ImageGenerationProvider = {
    generateImage: () => ({ [Symbol.asyncIterator]: () => underlying }),
    downloadGeneratedImage: async () => PNG,
    deleteFile: async () => undefined,
  };
  const stream = createImageGenerationStream({
    store, provider: imageProvider, owner, turn: accepted.turn, request, signal: new AbortController().signal,
    assertCurrent: (signal) => assertProviderStateOwner(owner, guard, signal),
    validateDecodedImage: () => undefined,
  });
  const iterator = stream[Symbol.asyncIterator]();
  const first = await iterator.next();
  assert.equal(first.done, false);
  assert.deepEqual(first.value, { type: 'error', category: 'network', retryable: true });
  await assert.rejects(iterator.next());
  assert.equal(returnCalls, 1);
});
