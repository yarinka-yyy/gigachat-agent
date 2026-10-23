import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';

export const LOCAL_TOKENIZER_MODEL_ID = 'GigaChat-3-Lightning';

const NATIVE_BINARY = {
  name: 'tokenizers.win32-x64-msvc.node',
  bytes: 5_266_944,
  sha256: 'f5fbacb63b8686de39c943548eb0297bd0d37b8f0a3403636ca31bd3530f5ae4',
};
const TOKENIZER_JSON = {
  name: 'tokenizer.json',
  bytes: 10_680_605,
  sha256: '3fdb3c045850a565109244ef3b89475cc2582769417647a41c46da14a3782aa5',
};

interface TokenizerEncoding {
  getLength(): number;
}

interface LocalTokenizer {
  disablePadding(): void;
  disableTruncation(): void;
  encode(text: string, pair: null, options: { addSpecialTokens: false }): Promise<TokenizerEncoding>;
}

interface TokenizerBindings {
  Tokenizer: { fromString(value: string): LocalTokenizer };
}

export interface LocalTokenizerPaths {
  appPath: string;
  isPackaged: boolean;
  resourcesPath: string;
}

export interface LocalTextTokenCounter {
  countTextTokens(modelId: string, texts: readonly string[], signal: AbortSignal): Promise<number[]>;
}

async function readVerifiedAsset(directory: string, expected: typeof NATIVE_BINARY | typeof TOKENIZER_JSON): Promise<Buffer> {
  const path = resolve(directory, expected.name);
  let stat: Awaited<ReturnType<typeof lstat>>;
  let bytes: Buffer;
  try {
    stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('LOCAL_TOKENIZER_RESOURCE_UNAVAILABLE');
    bytes = await readFile(path);
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCAL_TOKENIZER_RESOURCE_UNAVAILABLE') throw error;
    throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
  }
  if (bytes.length !== expected.bytes || bytes.length !== stat.size
    || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
    throw new Error('LOCAL_TOKENIZER_RESOURCE_INVALID');
  }
  return bytes;
}

export async function countLocalTokenizerText(
  tokenizer: Pick<LocalTokenizer, 'encode'>,
  text: string,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  try {
    const encoding = await tokenizer.encode(text, null, { addSpecialTokens: false });
    signal.throwIfAborted();
    let count: number;
    try { count = encoding.getLength(); }
    catch (error) {
      signal.throwIfAborted();
      if (isAbortError(error)) throw error;
      throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
    }
    if (!Number.isSafeInteger(count) || count < 0) throw new Error('LOCAL_TOKENIZER_COUNT_INVALID');
    return count;
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof Error && error.message === 'LOCAL_TOKENIZER_COUNT_INVALID' || isAbortError(error)) throw error;
    throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
  }
}

function isAbortError(error: unknown): boolean {
  return typeof error === 'object' && error !== null
    && ('name' in error && error.name === 'AbortError' || 'code' in error && error.code === 'ABORT_ERR');
}

export function createLocalTextTokenCounter(paths: LocalTokenizerPaths): LocalTextTokenCounter {
  const resourceDirectory = paths.isPackaged
    ? join(paths.resourcesPath, 'tokenizer')
    : join(paths.appPath, 'resources', 'tokenizer');
  let tokenizerPromise: Promise<LocalTokenizer> | undefined;
  let queue = Promise.resolve();

  const loadTokenizer = (): Promise<LocalTokenizer> => {
    if (!tokenizerPromise) {
      const pending = (async () => {
        if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
        try {
          const binaryPath = resolve(resourceDirectory, NATIVE_BINARY.name);
          await readVerifiedAsset(resourceDirectory, NATIVE_BINARY);
          const tokenizerBytes = await readVerifiedAsset(resourceDirectory, TOKENIZER_JSON);
          const requireNative = createRequire(binaryPath);
          const native = requireNative(binaryPath) as TokenizerBindings;
          const tokenizer = native.Tokenizer.fromString(tokenizerBytes.toString('utf8'));
          tokenizer.disablePadding();
          tokenizer.disableTruncation();
          return tokenizer;
        } catch (error) {
          if (error instanceof Error && /^LOCAL_TOKENIZER_(?:RESOURCE_INVALID|RESOURCE_UNAVAILABLE|UNAVAILABLE)$/.test(error.message)) throw error;
          throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
        }
      })();
      tokenizerPromise = pending;
      void pending.catch(() => {
        if (tokenizerPromise === pending) tokenizerPromise = undefined;
      });
    }
    return tokenizerPromise;
  };

  return Object.freeze({
    async countTextTokens(modelId: string, texts: readonly string[], signal: AbortSignal): Promise<number[]> {
      if (modelId !== LOCAL_TOKENIZER_MODEL_ID || !Array.isArray(texts)
        || !texts.every((text) => typeof text === 'string')) throw new Error('LOCAL_TOKENIZER_UNAVAILABLE');
      signal.throwIfAborted();
      const pending = queue.then(async () => {
        signal.throwIfAborted();
        const tokenizer = await loadTokenizer();
        const counts: number[] = [];
        for (const text of texts) {
          signal.throwIfAborted();
          counts.push(await countLocalTokenizerText(tokenizer, text, signal));
        }
        signal.throwIfAborted();
        return counts;
      });
      queue = pending.then(() => undefined, () => undefined);
      return pending;
    },
  });
}
