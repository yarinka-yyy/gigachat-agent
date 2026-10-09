import { spawn as spawnChild, type ChildProcessWithoutNullStreams, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { extname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type { InstructionCommitRequest, InstructionCommitResult, PermissionApprovalRequest, Project } from './contracts';
import { evaluatePermission, requirePermissionProfile, type PermissionProfile, type PermissionResource } from './permissions';
import type { CustomPolicy, LocalAction } from './custom-permissions';

export const MAX_LOCAL_FILE_BYTES = 1024 * 1024;
const MAX_LIST_ENTRIES = 500;
const MAX_SEARCH_FILES = 500;
const MAX_SEARCH_DIRECTORIES = 500;
const MAX_SEARCH_ENTRIES = 5000;
const MAX_SEARCH_MATCHES = 200;
const MAX_SEARCH_DEPTH = 12;
const MAX_ENUMERATION_OUTPUT_BYTES = 1024 * 1024;
const MAX_TOOL_PATH_LENGTH = 2048;
const MAX_SCRIPT_LENGTH = 16 * 1024;
const MAX_RUN_TIMEOUT_MS = 120_000;
const LOCAL_TOOL_TIMEOUT_MS = 30_000;
const LOCAL_FILE_WRITE_TIMEOUT_MS = 30_000;
const OPEN_TEXT_EXTENSIONS = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.log']);

export type LocalToolName = 'list' | 'search' | 'read' | 'write' | 'open' | 'powershell';
export type LocalToolPhase = 'started' | 'completed' | 'failed' | 'cancelled';

export interface LocalToolEvent {
  id: string;
  tool: LocalToolName;
  phase: LocalToolPhase;
  at: string;
  durationMs?: number;
  reason?: string;
}

export interface PowerShellRequest {
  workingFolder: string;
  script: string;
  timeoutMs: number;
  maxOutputBytes: number;
  trustedFullAccess?: boolean;
  projectScoped?: boolean;
  inputDataBase64?: string;
  signal?: AbortSignal;
}

export interface PowerShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimited: boolean;
}

export type PowerShellRunner = (request: PowerShellRequest) => Promise<PowerShellResult>;

export interface ProjectFileWriteRequest {
  workingFolder: string;
  relativePath: string;
  contentsBase64: string;
  signal?: AbortSignal;
}

export interface ProjectFileWriteResult {
  bytes: number;
  replacedExisting: boolean;
}

export type ProjectFileWriter = (request: ProjectFileWriteRequest) => Promise<ProjectFileWriteResult>;

const MAX_HELPER_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_POWER_SHELL_OUTPUT_BYTES = 4 * 1024 * 1024;
const HELPER_RECOVERY_TIMEOUT_MS = 5000;
const MAX_HELPER_INPUT_BASE64_CHARS = Math.ceil(MAX_LOCAL_FILE_BYTES / 3) * 4;

export interface PowerShellHelperOptions {
  helperPath: string;
  recoveryDirectory: string;
  instructionRecoveryDirectory?: string;
  spawnProcess?: (command: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams;
}

export interface PowerShellHelper {
  run: PowerShellRunner;
  writeFile: ProjectFileWriter;
  recover(): Promise<void>;
  writeInstruction?: (request: InstructionCommitRequest) => Promise<InstructionCommitResult>;
  recoverInstructions?: () => Promise<string[]>;
}

interface HelperProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  aborted: boolean;
  timedOut: boolean;
  responseLimit: boolean;
  processError: Error | null;
}

export function resolvePowerShellHelperPath(options: {
  platform: string;
  isPackaged: boolean;
  resourcesPath: string;
  appPath: string;
}): string | null {
  if (options.platform !== 'win32') return null;
  const root = options.isPackaged ? options.resourcesPath : options.appPath;
  if (!isAbsolute(root)) throw new LocalToolError('Путь приложения для PowerShell helper должен быть абсолютным.');
  return options.isPackaged
    ? join(root, 'LocalPowerShell.exe')
    : join(root, 'resources', 'native', 'LocalPowerShell.exe');
}

function invokePowerShellHelper(
  helperPath: string,
  args: string[],
  input: string | undefined,
  timeoutMs: number,
  spawnProcess: (command: string, args: string[], options: SpawnOptions) => ChildProcessWithoutNullStreams,
  signal?: AbortSignal,
): Promise<HelperProcessResult> {
  throwIfAborted(signal);
  return new Promise((resolveResult, rejectResult) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawnProcess(helperPath, args, {
        cwd: process.cwd(),
        windowsHide: true,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      rejectResult(error);
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let totalBytes = 0;
    let closed = false;
    let aborted = false;
    let timedOut = false;
    let responseLimit = false;
    let processError: Error | null = null;
    const stop = (): void => {
      if (closed) return;
      try { child.kill(); } catch { /* Wait for close and recover the helper journal below. */ }
    };
    const capture = (destination: Buffer[], chunk: Buffer | string): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, MAX_HELPER_RESPONSE_BYTES - totalBytes);
      if (remaining > 0) destination.push(Buffer.from(bytes.subarray(0, remaining)));
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_HELPER_RESPONSE_BYTES) {
        responseLimit = true;
        stop();
      }
    };
    const onAbort = (): void => {
      aborted = true;
      stop();
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);
    child.stdout.on('data', (chunk: Buffer | string) => capture(stdout, chunk));
    child.stderr.on('data', (chunk: Buffer | string) => capture(stderr, chunk));
    child.stdin.on('error', () => undefined);
    child.once('error', (error) => { processError = error; });
    child.once('close', (code) => {
      closed = true;
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      resolveResult({
        code,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        aborted,
        timedOut,
        responseLimit,
        processError,
      });
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    if (input === undefined) child.stdin.end();
    else child.stdin.end(input, 'utf8');
  });
}

function parseHelperJson(output: string): unknown {
  try { return JSON.parse(output.trim()) as unknown; }
  catch { throw new LocalToolError('Локальный PowerShell helper вернул некорректный ответ.'); }
}

function requirePowerShellResult(value: unknown, maxOutputBytes: number): PowerShellResult {
  if (!isRecord(value) || !Number.isSafeInteger(value.ExitCode)
    || typeof value.Stdout !== 'string' || typeof value.Stderr !== 'string'
    || typeof value.TimedOut !== 'boolean' || typeof value.OutputLimited !== 'boolean') {
    throw new LocalToolError('Локальный PowerShell helper вернул некорректный ответ.');
  }
  if (Buffer.byteLength(value.Stdout, 'utf8') + Buffer.byteLength(value.Stderr, 'utf8') > maxOutputBytes) {
    throw new LocalToolError('Вывод PowerShell превысил установленный лимит.');
  }
  return {
    exitCode: value.ExitCode as number,
    stdout: value.Stdout,
    stderr: value.Stderr,
    timedOut: value.TimedOut,
    outputLimited: value.OutputLimited,
  };
}

export function createPowerShellHelper(options: PowerShellHelperOptions): PowerShellHelper {
  if (!isAbsolute(options.helperPath) || !isAbsolute(options.recoveryDirectory)
    || (options.instructionRecoveryDirectory !== undefined && !isAbsolute(options.instructionRecoveryDirectory))) {
    throw new LocalToolError('Пути PowerShell helper должны быть абсолютными.');
  }
  const helperPath = resolve(options.helperPath);
  const recoveryDirectory = resolve(options.recoveryDirectory);
  const instructionRecoveryDirectory = options.instructionRecoveryDirectory
    ? resolve(options.instructionRecoveryDirectory)
    : undefined;
  const spawnProcess = options.spawnProcess ?? ((command, args, spawnOptions) =>
    spawnChild(command, args, spawnOptions) as ChildProcessWithoutNullStreams);
  let helperTail: Promise<void> = Promise.resolve();

  function withHelperLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = helperTail;
    let release!: () => void;
    helperTail = new Promise<void>((resolveLock) => { release = resolveLock; });
    return previous.then(action).finally(release);
  }

  const recoverUnlocked = async (): Promise<void> => {
    const result = await invokePowerShellHelper(helperPath,
      ['--recover', recoveryDirectory], undefined, HELPER_RECOVERY_TIMEOUT_MS, spawnProcess);
    if (result.processError || result.code !== 0 || result.timedOut || result.responseLimit) {
      throw new LocalToolError('Не удалось восстановить PowerShell runtime.');
    }
    const response = parseHelperJson(result.stdout);
    if (!isRecord(response) || response.recovered !== true) {
      throw new LocalToolError('Локальный PowerShell helper не подтвердил восстановление runtime.');
    }
  };

  const recover = (): Promise<void> => withHelperLock(recoverUnlocked);

  const runUnlocked: PowerShellRunner = async (request) => {
    throwIfAborted(request.signal);
    const inputDataBase64 = request.inputDataBase64;
    if (inputDataBase64 !== undefined) {
      if (typeof inputDataBase64 !== 'string' || inputDataBase64.length > MAX_HELPER_INPUT_BASE64_CHARS
        || inputDataBase64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(inputDataBase64)) {
        throw new LocalToolError('Входные данные PowerShell превышают лимит 1 МиБ или имеют неверный формат.');
      }
      const decoded = Buffer.from(inputDataBase64, 'base64');
      if (decoded.byteLength > MAX_LOCAL_FILE_BYTES || decoded.toString('base64') !== inputDataBase64) {
        throw new LocalToolError('Входные данные PowerShell превышают лимит 1 МиБ или имеют неверный формат.');
      }
    }
    if (!isAbsolute(request.workingFolder) || request.workingFolder.includes('\0')
      || typeof request.script !== 'string' || request.script.length === 0 || request.script.length > MAX_SCRIPT_LENGTH
      || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 100 || request.timeoutMs > MAX_RUN_TIMEOUT_MS
      || !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes < 1 || request.maxOutputBytes > MAX_POWER_SHELL_OUTPUT_BYTES
      || (request.trustedFullAccess !== undefined && typeof request.trustedFullAccess !== 'boolean')
      || (request.projectScoped !== undefined && typeof request.projectScoped !== 'boolean')) {
      throw new LocalToolError('Некорректные параметры PowerShell.');
    }
    const input = JSON.stringify({
      WorkingFolder: request.workingFolder,
      Script: request.script,
      TimeoutMs: request.timeoutMs,
      MaxOutputBytes: request.maxOutputBytes,
      TrustedFullAccess: request.trustedFullAccess === true,
      ProjectScoped: request.projectScoped !== false,
      ...(inputDataBase64 === undefined ? {} : { InputDataBase64: inputDataBase64 }),
    });
    let result: HelperProcessResult;
    try {
      result = await invokePowerShellHelper(helperPath,
        ['--run', recoveryDirectory], input, request.timeoutMs + 15_000, spawnProcess, request.signal);
    } catch {
      await recoverUnlocked().catch(() => {
        throw new LocalToolError('Не удалось восстановить PowerShell runtime после ошибки запуска.');
      });
      throw new LocalToolError('Не удалось запустить PowerShell helper.');
    }

    if (result.aborted || result.timedOut || result.responseLimit || result.processError || result.code !== 0) {
      const failure = (() => {
        if (!result.stdout) return null;
        try { return JSON.parse(result.stdout.trim()) as unknown; } catch { return null; }
      })();
      await recoverUnlocked().catch(() => {
        throw new LocalToolError('Не удалось восстановить PowerShell runtime после остановки.');
      });
      if (result.aborted) {
        const error = new Error('Локальная операция отменена.');
        error.name = 'AbortError';
        Object.assign(error, { code: 'ABORT_ERR' });
        throw error;
      }
      if (result.timedOut) {
        return { exitCode: 124, stdout: '', stderr: '', timedOut: true, outputLimited: false };
      }
      if (result.responseLimit) throw new LocalToolError('Ответ локального PowerShell helper превысил безопасный лимит.');
      const code = isRecord(failure) && Number.isSafeInteger(failure.Code) ? ` (код ${failure.Code})` : '';
      throw new LocalToolError(`PowerShell helper завершился с ошибкой${code}.`);
    }

    let response: unknown;
    try { response = parseHelperJson(result.stdout); }
    catch (error) {
      await recoverUnlocked();
      throw error;
    }
    if (isRecord(response) && 'Error' in response) {
      await recoverUnlocked();
      const code = Number.isSafeInteger(response.Code) ? ` (${response.Code})` : '';
      throw new LocalToolError(`PowerShell helper отклонил запрос${code}.`);
    }
    try {
      return requirePowerShellResult(response, request.maxOutputBytes);
    } catch (error) {
      await recoverUnlocked();
      if (error instanceof LocalToolError) throw error;
      throw new LocalToolError('Локальный PowerShell helper вернул некорректный ответ.');
    }
  };

  const run: PowerShellRunner = (request) => withHelperLock(() => runUnlocked(request));
  const writeFileUnlocked: ProjectFileWriter = async (request) => {
    throwIfAborted(request.signal);
    if (!isAbsolute(request.workingFolder) || request.workingFolder.includes('\0')) {
      throw new LocalToolError('Рабочая папка должна быть абсолютной.');
    }
    const pathParts = requireRelativePath(request.relativePath, false);
    const contentsBase64 = request.contentsBase64;
    if (typeof contentsBase64 !== 'string' || contentsBase64.length > MAX_HELPER_INPUT_BASE64_CHARS
      || contentsBase64.length % 4 !== 0
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(contentsBase64)) {
      throw new LocalToolError('Содержимое файла превышает лимит 1 МиБ или имеет неверный формат.');
    }
    const payload = Buffer.from(contentsBase64, 'base64');
    if (payload.byteLength > MAX_LOCAL_FILE_BYTES || payload.toString('base64') !== contentsBase64) {
      throw new LocalToolError('Содержимое файла превышает лимит 1 МиБ или имеет неверный формат.');
    }
    const input = JSON.stringify({
      WorkingFolder: resolve(request.workingFolder),
      RelativePath: pathParts.join('\\'),
      ContentsBase64: contentsBase64,
    });
    let result: HelperProcessResult;
    try {
      result = await invokePowerShellHelper(helperPath,
        ['--write', recoveryDirectory], input, LOCAL_FILE_WRITE_TIMEOUT_MS, spawnProcess, request.signal);
    } catch {
      await recoverUnlocked().catch(() => {
        throw new LocalToolError('Не удалось восстановить состояние после ошибки запуска файлового writer.');
      });
      throw new LocalToolError('Не удалось запустить файловый writer.');
    }

    const responseFromOutput = (): unknown => {
      if (!result.stdout) return null;
      try { return JSON.parse(result.stdout.trim()) as unknown; } catch { return null; }
    };
    if (result.aborted || result.timedOut || result.responseLimit || result.processError || result.code !== 0) {
      const failure = responseFromOutput();
      await recoverUnlocked().catch(() => {
        throw new LocalToolError('Не удалось восстановить состояние после операции записи.');
      });
      if (result.aborted) {
        const error = new Error('Запись прервана; перед повтором перечитайте файл, результат мог уже зафиксироваться.');
        error.name = 'AbortError';
        Object.assign(error, { code: 'ABORT_ERR' });
        throw error;
      }
      if (result.timedOut) throw new LocalToolError('Состояние файла после таймаута неизвестно; перечитайте его перед повтором.');
      if (result.responseLimit) throw new LocalToolError('Ответ файлового writer превысил безопасный лимит.');
      const code = isRecord(failure) && Number.isSafeInteger(failure.Code) ? ` (код ${failure.Code})` : '';
      const stage = isRecord(failure) && typeof failure.Stage === 'string' ? `, этап: ${failure.Stage}` : '';
      throw new LocalToolError(`Файловый writer отказал${code}${stage}.`);
    }

    let response: unknown;
    try { response = parseHelperJson(result.stdout); }
    catch (error) {
      await recoverUnlocked();
      throw error;
    }
    if (isRecord(response) && 'Error' in response) {
      await recoverUnlocked();
      const code = Number.isSafeInteger(response.Code) ? ` (код ${response.Code})` : '';
      const stage = typeof response.Stage === 'string' ? `, этап: ${response.Stage}` : '';
      throw new LocalToolError(`Файловый writer отказал${code}${stage}.`);
    }
    if (!isRecord(response) || !Number.isSafeInteger(response.Bytes) || response.Bytes !== payload.byteLength
      || typeof response.ReplacedExisting !== 'boolean') {
      await recoverUnlocked();
      throw new LocalToolError('Файловый writer вернул некорректный ответ.');
    }
    return { bytes: response.Bytes as number, replacedExisting: response.ReplacedExisting };
  };
  const writeFile: ProjectFileWriter = (request) => withHelperLock(() => writeFileUnlocked(request));
  const writeInstruction: PowerShellHelper['writeInstruction'] = instructionRecoveryDirectory
    ? (request: InstructionCommitRequest) => withHelperLock(async () => {
      if (!isAbsolute(request.workingFolder) || request.workingFolder.includes('\0')
        || typeof request.relativePath !== 'string' || request.relativePath.length > MAX_TOOL_PATH_LENGTH
        || request.relativePath.includes('\0') || isAbsolute(request.relativePath)
        || request.relativePath.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part.includes(':'))
        || (request.expectedHash !== null && !/^[0-9a-f]{64}$/.test(request.expectedHash))) {
        throw new LocalToolError('Некорректные параметры записи инструкции.');
      }
      const bytes = Buffer.from(request.contents, 'utf8');
      if (bytes.byteLength > 64 * 1024 || new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes) !== request.contents
        || request.contents.includes('\0')) throw new LocalToolError('Инструкция превышает лимит 64 КБ.');
      const input = JSON.stringify({
        WorkingFolder: resolve(request.workingFolder),
        RelativePath: request.relativePath.replace(/[\\/]/g, '\\'),
        ContentsBase64: bytes.toString('base64'),
        ExpectedHash: request.expectedHash,
      });
      const result = await invokePowerShellHelper(helperPath,
        ['--write-instruction', instructionRecoveryDirectory], input, LOCAL_FILE_WRITE_TIMEOUT_MS, spawnProcess);
      if (result.processError || result.code !== 0 || result.timedOut || result.responseLimit) {
        throw new LocalToolError('Writer инструкций остановился; путь и версии сохранены для проверки.');
      }
      const response = parseHelperJson(result.stdout);
      if (!isRecord(response) || typeof response.Kind !== 'string')
        throw new LocalToolError('Writer инструкций вернул некорректный ответ.');
      if (response.Kind === 'saved') return { kind: 'saved' };
      if (response.Kind === 'conflict-before' && (response.CurrentText === null || typeof response.CurrentText === 'string')) {
        return { kind: 'conflict-before', currentText: response.CurrentText as string | null };
      }
      if (response.Kind === 'conflict-after' && typeof response.CurrentText === 'string'
        && typeof response.PreservedPath === 'string'
        && (response.PreservedText === null || typeof response.PreservedText === 'string')) {
        return {
          kind: 'conflict-after',
          currentText: response.CurrentText,
          preservedPath: response.PreservedPath,
          preservedText: response.PreservedText as string | null,
        };
      }
      throw new LocalToolError('Writer инструкций вернул некорректное состояние конфликта.');
    })
    : undefined;
  const recoverInstructions = instructionRecoveryDirectory
    ? () => withHelperLock(async () => {
      const result = await invokePowerShellHelper(helperPath,
        ['--recover-instructions', instructionRecoveryDirectory], undefined,
        HELPER_RECOVERY_TIMEOUT_MS, spawnProcess);
      if (result.processError || result.code !== 0 || result.timedOut || result.responseLimit)
        throw new LocalToolError('Не удалось восстановить журнал инструкций.');
      const response = parseHelperJson(result.stdout);
      if (!isRecord(response) || typeof response.Recovered !== 'boolean' || !Array.isArray(response.Conflicts)
        || response.Conflicts.some((path) => typeof path !== 'string'))
        throw new LocalToolError('Восстановление инструкций вернуло некорректный ответ.');
      return response.Conflicts as string[];
    })
    : undefined;
  return { run, writeFile, recover, ...(writeInstruction ? { writeInstruction } : {}), ...(recoverInstructions ? { recoverInstructions } : {}) };
}

export interface LocalToolsOptions {
  resolveProject(id: string): Promise<Project | null>;
  protectedDirectory?: string;
  getCustomPolicy?(): Promise<CustomPolicy>;
  requestApproval?(details: Omit<PermissionApprovalRequest, 'id' | 'expiresAt'>, signal?: AbortSignal): Promise<boolean>;
  revealItem?(path: string): Promise<void>;
  openTextFile?(path: string): Promise<void>;
  runPowerShell?: PowerShellRunner;
  writeFile?: ProjectFileWriter;
  onEvent?(event: LocalToolEvent): void;
}

export interface LocalFileEntry {
  path: string;
  kind: 'file' | 'directory' | 'link';
  size: number | null;
}

export interface LocalSearchMatch {
  path: string;
  line: number;
  text: string;
}

export interface LocalTools {
  list(projectId: unknown, profile: unknown, path?: unknown, options?: { signal?: AbortSignal }): Promise<LocalFileEntry[]>;
  search(projectId: unknown, profile: unknown, query: unknown, path?: unknown, options?: { signal?: AbortSignal }): Promise<LocalSearchMatch[]>;
  read(projectId: unknown, profile: unknown, path: unknown, options?: { signal?: AbortSignal }): Promise<string>;
  write(projectId: unknown, profile: unknown, path: unknown, contents: unknown, options?: { signal?: AbortSignal }): Promise<{ bytes: number }>;
  open(projectId: unknown, profile: unknown, path?: unknown): Promise<void>;
  runPowerShell(projectId: unknown, profile: unknown, script: unknown, options?: {
    timeoutMs?: unknown;
    signal?: AbortSignal;
    /** Main-process only: request one explicit user approval for this whole command without AppContainer. */
    fullAccessOnce?: unknown;
  }): Promise<PowerShellResult>;
}

class LocalToolError extends Error {}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Локальная операция отменена.');
  error.name = 'AbortError';
  Object.assign(error, { code: 'ABORT_ERR' });
  throw error;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireProjectId(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) {
    throw new LocalToolError('Некорректный идентификатор проекта.');
  }
  return value;
}

function requireRelativePath(value: unknown, allowRoot: boolean): string[] {
  if (value === '' && allowRoot) return [];
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TOOL_PATH_LENGTH
    || value.includes('\0') || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) {
    throw new LocalToolError('Укажите относительный путь внутри рабочей папки проекта.');
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..' || part.includes(':'))) {
    throw new LocalToolError('Путь содержит недопустимый компонент.');
  }
  return parts;
}

function requireText(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.includes('\0')) {
    throw new LocalToolError(`${label}: значение некорректно.`);
  }
  return value;
}

function quotePowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildTargetScript(rootPath: string, pathParts: string[], body: string): string {
  const relativePath = quotePowerShellString(pathParts.join('\\'));
  const projectRoot = quotePowerShellString(rootPath);
  return `# GigaChat local file operation\n`
    + `$ErrorActionPreference = 'Stop'\n`
    + `$root = [IO.Path]::GetFullPath(${projectRoot})\n`
    + `if ($root.Length -gt [IO.Path]::GetPathRoot($root).Length) { $root = $root.TrimEnd([IO.Path]::DirectorySeparatorChar) }\n`
    + `$rootPrefix = $root + [IO.Path]::DirectorySeparatorChar\n`
    + `$relative = ${relativePath}\n`
    + `$target = if ($relative.Length -eq 0) { $root } else { [IO.Path]::GetFullPath([IO.Path]::Combine($root, $relative)) }\n`
    + `if (($target -ne $root) -and (-not $target.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase))) { throw 'OUTSIDE_PROJECT' }\n`
    + `$utf8Strict = [Text.UTF8Encoding]::new($false, $true)\n`
    + `function Assert-NoReparse([string] $Candidate) {\n`
    + `  if ($Candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase)) { return }\n`
    + `  if (-not $Candidate.StartsWith($rootPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'OUTSIDE_PROJECT' }\n`
    + `  $rel = $Candidate.Substring($rootPrefix.Length)\n`
    + `  $cursor = $root\n`
    + `  foreach ($part in $rel.Split([IO.Path]::DirectorySeparatorChar)) {\n`
    + `    $cursor = [IO.Path]::Combine($cursor, $part)\n`
    + `    if ([IO.Directory]::Exists($cursor) -or [IO.File]::Exists($cursor)) {\n`
    + `      $attrs = [IO.File]::GetAttributes($cursor)\n`
    + `      if (($attrs -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REPARSE_POINT' }\n`
    + `    } else { break }\n`
    + `  }\n`
    + `}\n`
    + `Assert-NoReparse $target\n`
    + body;
}

function buildReadScript(rootPath: string, pathParts: string[]): string {
  return buildTargetScript(rootPath, pathParts,
    `$attributes = [IO.File]::GetAttributes($target)\n`
    + `if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { throw 'NOT_A_FILE' }\n`
    + `$stream = [IO.File]::Open($target, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)\n`
    + `try {\n`
    + `  if ($stream.Length -gt ${MAX_LOCAL_FILE_BYTES}) { throw 'FILE_TOO_LARGE' }\n`
    + `  $bytes = New-Object byte[] ([int]$stream.Length)\n`
    + `  $offset = 0\n`
    + `  while ($offset -lt $bytes.Length) { $count = $stream.Read($bytes, $offset, $bytes.Length - $offset); if ($count -eq 0) { break }; $offset += $count }\n`
    + `  if (($offset -ne $bytes.Length) -or ($stream.ReadByte() -ne -1)) { throw 'FILE_CHANGED' }\n`
    + `  $text = $utf8Strict.GetString($bytes)\n`
    + `  if ($text.IndexOf([char]0) -ge 0) { throw 'BINARY_FILE' }\n`
    + `  [Console]::Out.WriteLine([Convert]::ToBase64String($bytes))\n`
    + `} finally { $stream.Dispose() }\n`);
}

function buildListScript(rootPath: string, pathParts: string[]): string {
  return buildTargetScript(rootPath, pathParts,
    `# GIGACHAT_LOCAL_TOOL:list\n`
    + `$rows = New-Object 'System.Collections.Generic.List[object]'\n`
    + `$entries = [IO.Directory]::GetFileSystemEntries($target)\n`
    + `if ($entries.Length -gt ${MAX_LIST_ENTRIES}) { throw 'TOO_MANY_ENTRIES' }\n`
    + `foreach ($entryPath in $entries) {\n`
    + `  $attributes = [IO.File]::GetAttributes($entryPath)\n`
    + `  $entryRelative = $entryPath.Substring($rootPrefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')\n`
    + `  $kind = 'file'; $size = $null\n`
    + `  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { $kind = 'link' }\n`
    + `  elseif (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { $kind = 'directory' }\n`
    + `  elseif (($attributes -band [IO.FileAttributes]::Device) -eq 0) { $size = [IO.FileInfo]::new($entryPath).Length }\n`
    + `  $null = $rows.Add([PSCustomObject]@{ path = $entryRelative; kind = $kind; size = $size })\n`
    + `}\n`
    + `$json = ConvertTo-Json -InputObject ($rows.ToArray()) -Depth 4 -Compress\n`
    + `if ([Text.Encoding]::UTF8.GetByteCount($json) -gt ${MAX_ENUMERATION_OUTPUT_BYTES}) { throw 'OUTPUT_LIMIT' }\n`
    + `[Console]::Out.WriteLine($json)\n`);
}

function buildSearchScript(rootPath: string, pathParts: string[], query: string): string {
  const quotedQuery = quotePowerShellString(query);
  return buildTargetScript(rootPath, pathParts,
    `# GIGACHAT_LOCAL_TOOL:search\n`
    + `$needle = ${quotedQuery}\n`
    + `$rows = New-Object 'System.Collections.Generic.List[object]'\n`
    + `$pending = New-Object 'System.Collections.Generic.Stack[object]'\n`
    + `$null = $pending.Push([PSCustomObject]@{ FullPath = $target; Depth = 0 })\n`
    + `$inspectedFiles = 0; $inspectedDirectories = 0; $inspectedEntries = 0\n`
    + `while (($pending.Count -gt 0) -and ($rows.Count -lt ${MAX_SEARCH_MATCHES})) {\n`
    + `  $current = $pending.Pop()\n`
    + `  if ($current.Depth -gt ${MAX_SEARCH_DEPTH}) { continue }\n`
    + `  $inspectedDirectories++\n`
    + `  if ($inspectedDirectories -gt ${MAX_SEARCH_DIRECTORIES}) { throw 'TOO_MANY_DIRECTORIES' }\n`
    + `  $entries = [IO.Directory]::GetFileSystemEntries($current.FullPath)\n`
    + `  foreach ($entryPath in $entries) {\n`
    + `    if ($rows.Count -ge ${MAX_SEARCH_MATCHES}) { break }\n`
    + `    $inspectedEntries++\n`
    + `    if ($inspectedEntries -gt ${MAX_SEARCH_ENTRIES}) { throw 'TOO_MANY_ENTRIES' }\n`
    + `    $attributes = [IO.File]::GetAttributes($entryPath)\n`
    + `    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { continue }\n`
    + `    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {\n`
    + `      if ($current.Depth -lt ${MAX_SEARCH_DEPTH}) { $null = $pending.Push([PSCustomObject]@{ FullPath = $entryPath; Depth = $current.Depth + 1 }) }\n`
    + `      continue\n`
    + `    }\n`
    + `    if (($attributes -band [IO.FileAttributes]::Device) -ne 0) { continue }\n`
    + `    $fileInfo = [IO.FileInfo]::new($entryPath)\n`
    + `    if ($fileInfo.Length -gt ${MAX_LOCAL_FILE_BYTES}) { continue }\n`
    + `    $inspectedFiles++\n`
    + `    if ($inspectedFiles -gt ${MAX_SEARCH_FILES}) { throw 'TOO_MANY_FILES' }\n`
    + `    $stream = [IO.File]::Open($entryPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)\n`
    + `    try {\n`
    + `      if ($stream.Length -gt ${MAX_LOCAL_FILE_BYTES}) { continue }\n`
    + `      $bytes = New-Object byte[] ([int]$stream.Length); $offset = 0\n`
    + `      while ($offset -lt $bytes.Length) { $count = $stream.Read($bytes, $offset, $bytes.Length - $offset); if ($count -eq 0) { break }; $offset += $count }\n`
    + `      if (($offset -ne $bytes.Length) -or ($stream.ReadByte() -ne -1)) { throw 'FILE_CHANGED' }\n`
    + `      $isText = $true\n`
    + `      try { $contents = $utf8Strict.GetString($bytes) } catch [System.Text.DecoderFallbackException] { $isText = $false }\n`
    + `      if ($isText -and ($contents.IndexOf([char]0) -lt 0)) {\n`
    + `        $lines = [Regex]::Split($contents, "\\r?\\n")\n`
    + `        $entryRelative = $entryPath.Substring($rootPrefix.Length).Replace([IO.Path]::DirectorySeparatorChar, '/')\n`
    + `        for ($lineIndex = 0; ($lineIndex -lt $lines.Length) -and ($rows.Count -lt ${MAX_SEARCH_MATCHES}); $lineIndex++) {\n`
    + `          $lineText = $lines[$lineIndex]\n`
    + `          if ($lineText.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0) {\n`
    + `            $null = $rows.Add([PSCustomObject]@{ path = $entryRelative; line = $lineIndex + 1; text = $lineText.Substring(0, [Math]::Min($lineText.Length, 2000)) })\n`
    + `          }\n`
    + `        }\n`
    + `      }\n`
    + `    } finally { $stream.Dispose() }\n`
    + `  }\n`
    + `}\n`
    + `$json = ConvertTo-Json -InputObject ($rows.ToArray()) -Depth 4 -Compress\n`
    + `if ([Text.Encoding]::UTF8.GetByteCount($json) -gt ${MAX_ENUMERATION_OUTPUT_BYTES}) { throw 'OUTPUT_LIMIT' }\n`
    + `[Console]::Out.WriteLine($json)\n`);
}

function parseJsonRows(output: string): unknown[] {
  if (Buffer.byteLength(output, 'utf8') > MAX_ENUMERATION_OUTPUT_BYTES) {
    throw new LocalToolError('Результат локального обхода превышает лимит 1 МиБ.');
  }
  let value: unknown;
  try { value = JSON.parse(output.trim()) as unknown; }
  catch { throw new LocalToolError('Локальный обход вернул некорректный JSON.'); }
  if (!Array.isArray(value)) throw new LocalToolError('Локальный обход вернул некорректный список.');
  return value;
}

function parseListRows(output: string, pathParts: string[]): LocalFileEntry[] {
  const prefix = pathParts.map((part) => part.toLocaleLowerCase());
  const values = parseJsonRows(output);
  if (values.length > MAX_LIST_ENTRIES) throw new LocalToolError('Локальный обход вернул слишком много элементов.');
  return values.map((value) => {
    if (!isRecord(value) || typeof value.path !== 'string'
      || (value.kind !== 'file' && value.kind !== 'directory' && value.kind !== 'link')
      || (value.size !== null && (!Number.isSafeInteger(value.size) || (value.size as number) < 0))) {
      throw new LocalToolError('Локальный обход вернул некорректную запись.');
    }
    const parts = requireRelativePath(value.path, false);
    if (parts.length !== prefix.length + 1
      || !prefix.every((part, index) => parts[index]?.toLocaleLowerCase() === part)) {
      throw new LocalToolError('Локальный обход вернул путь вне выбранной папки.');
    }
    return { path: parts.join('/'), kind: value.kind as LocalFileEntry['kind'], size: value.size as number | null };
  }).sort((left, right) => left.path.localeCompare(right.path));
}

function parseSearchRows(output: string, pathParts: string[]): LocalSearchMatch[] {
  const prefix = pathParts.map((part) => part.toLocaleLowerCase());
  const values = parseJsonRows(output);
  if (values.length > MAX_SEARCH_MATCHES) throw new LocalToolError('Поиск вернул слишком много результатов.');
  return values.map((value) => {
    if (!isRecord(value) || typeof value.path !== 'string'
      || !Number.isSafeInteger(value.line) || (value.line as number) < 1
      || typeof value.text !== 'string' || value.text.length > 2000 || value.text.includes('\0')) {
      throw new LocalToolError('Поиск вернул некорректный результат.');
    }
    const parts = requireRelativePath(value.path, false);
    if (parts.length <= prefix.length
      || !prefix.every((part, index) => parts[index]?.toLocaleLowerCase() === part)) {
      throw new LocalToolError('Поиск вернул путь вне выбранной папки.');
    }
    return { path: parts.join('/'), line: value.line as number, text: value.text };
  });
}

function runBoundedFileScript(
  runner: PowerShellRunner | undefined,
  root: string,
  script: string,
  signal: AbortSignal | undefined,
  maxOutputBytes: number,
  inputDataBase64?: string,
): Promise<string> {
  throwIfAborted(signal);
  if (!runner) throw new LocalToolError('Ограниченный PowerShell helper пока недоступен.');
  return runner({
    workingFolder: root,
    script,
    timeoutMs: LOCAL_TOOL_TIMEOUT_MS,
    maxOutputBytes,
    ...(inputDataBase64 === undefined ? {} : { inputDataBase64 }),
    ...(signal ? { signal } : {}),
  }).then((result) => {
    throwIfAborted(signal);
    if (result.timedOut) throw new LocalToolError('Локальная операция превысила лимит времени.');
    if (result.outputLimited) throw new LocalToolError('Вывод локальной операции превысил лимит.');
    if (result.exitCode !== 0) {
      throw new LocalToolError('Ограниченный PowerShell helper отклонил локальную операцию.');
    }
    return result.stdout;
  });
}
function parseBase64Output(output: string, maxBytes: number): Buffer {
  const encoded = output.endsWith('\r\n') ? output.slice(0, -2) : output.endsWith('\n') ? output.slice(0, -1) : output;
  if (encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new LocalToolError('Ограниченная операция вернула неверный формат данных.');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.byteLength > maxBytes || bytes.toString('base64') !== encoded) {
    throw new LocalToolError('Ограниченная операция вернула больше данных, чем разрешено.');
  }
  return bytes;
}

async function assertNoReparseComponents(path: string): Promise<void> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  let current = root;
  const components = absolute.slice(root.length).split(sep).filter(Boolean);
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink()) throw new LocalToolError('Рабочая папка содержит ссылку; доступ запрещён.');
  } catch {
    throw new LocalToolError('Рабочая папка не найдена или недоступна.');
  }
  for (const component of components) {
    current = join(current, component);
    let info;
    try { info = await lstat(current); }
    catch { throw new LocalToolError('Рабочая папка не найдена или недоступна.'); }
    if (info.isSymbolicLink()) throw new LocalToolError('Рабочая папка содержит ссылку; доступ запрещён.');
    if (current !== absolute && !info.isDirectory()) throw new LocalToolError('Компонент рабочей папки не является каталогом.');
  }
}

async function assertSafeTarget(root: string, target: string, allowMissing: boolean): Promise<void> {
  const rel = relative(root, target);
  if (rel === '') return;
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new LocalToolError('Путь выходит за границы рабочей папки проекта.');
  }
  let current = root;
  const parts = rel.split(sep);
  for (let i = 0; i < parts.length; i++) {
    const component = parts[i];
    if (component === undefined) throw new LocalToolError('Некорректный путь проекта.');
    current = join(current, component);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (allowMissing && isRecord(error) && error.code === 'ENOENT') return;
      throw new LocalToolError('Файл или папка проекта не найдены либо недоступны.');
    }
    if (info.isSymbolicLink()) throw new LocalToolError('Символические ссылки и точки повторной обработки запрещены.');
    if (i < parts.length - 1 && !info.isDirectory()) throw new LocalToolError('Компонент пути не является папкой.');
  }
}

function decodeText(bytes: Uint8Array): string {
  if (bytes.byteLength > MAX_LOCAL_FILE_BYTES) throw new LocalToolError('Файл превышает лимит 1 МиБ.');
  if (bytes.includes(0)) throw new LocalToolError('Бинарный файл нельзя читать как текст.');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { throw new LocalToolError('Файл не содержит корректный UTF-8 текст.'); }
}

export function createLocalTools(options: LocalToolsOptions): LocalTools {
  const emit = (event: LocalToolEvent): void => {
    try { options.onEvent?.(event); } catch { /* Activity reporting must not fail a tool. */ }
  };

  async function activity<T>(tool: LocalToolName, action: () => Promise<T>): Promise<T> {
    const id = randomUUID();
    const started = Date.now();
    emit({ id, tool, phase: 'started', at: new Date(started).toISOString() });
    try {
      const result = await action();
      emit({ id, tool, phase: 'completed', at: new Date().toISOString(), durationMs: Date.now() - started });
      return result;
    } catch (error) {
      const cancelled = isRecord(error) && (error.name === 'AbortError' || error.code === 'ABORT_ERR');
      emit({
        id,
        tool,
        phase: cancelled ? 'cancelled' : 'failed',
        at: new Date().toISOString(),
        durationMs: Date.now() - started,
        reason: error instanceof LocalToolError ? error.message : 'Локальный инструмент завершился ошибкой.',
      });
      throw error;
    }
  }

  async function resolveRoot(referenceInput: unknown, profile: PermissionProfile, allowCurrentWorkingDirectory = false) {
    const rootName = typeof referenceInput === 'string' && /^root:[a-z][a-z0-9_-]{0,31}$/.test(referenceInput)
      ? referenceInput.slice(5) : null;
    const canUseCurrentDirectory = referenceInput === null && (profile === 'full' || allowCurrentWorkingDirectory);
    const projectId = rootName ? null : canUseCurrentDirectory ? null : requireProjectId(referenceInput);
    let folder: string | null = null;
    if (rootName) {
      if ((profile !== 'custom' && profile !== 'ask' && profile !== 'approve') || !options.getCustomPolicy) {
        throw new LocalToolError('Дополнительный каталог недоступен для этого профиля.');
      }
      folder = (await options.getCustomPolicy()).roots.find((root) => root.name === rootName)?.path ?? null;
    } else {
      if (projectId) {
        const project = await options.resolveProject(projectId);
        folder = project?.id === projectId ? project.workingFolder : null;
      } else if (canUseCurrentDirectory) {
        folder = process.cwd();
      }
    }
    if (!folder || !isAbsolute(folder)) throw new LocalToolError('рабочая папка не найдена или недоступна.');
    await assertNoReparseComponents(folder);
    const canonical = await realpath(folder).catch(() => {
      throw new LocalToolError('Рабочая папка не найдена или недоступна.');
    });
    await assertNoReparseComponents(canonical);
    if (options.protectedDirectory) {
      const protectedDirectory = await realpath(options.protectedDirectory).catch(() => {
        throw new LocalToolError('Каталог данных приложения недоступен.');
      });
      const inside = (parent: string, child: string): boolean => {
        const path = relative(parent, child);
        return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
      };
      if (inside(canonical, protectedDirectory) || inside(protectedDirectory, canonical)) {
        throw new LocalToolError('Каталог данных приложения недоступен локальным инструментам.');
      }
    }
    return { projectId, rootName, root: canonical };
  }

  async function targetPath(root: string, pathInput: unknown, allowRoot = false, allowMissing = false): Promise<string> {
    const parts = requireRelativePath(pathInput, allowRoot);
    const target = parts.length === 0 ? root : resolve(root, ...parts);
    await assertSafeTarget(root, target, allowMissing);
    return target;
  }

  async function authorize(
    scope: Awaited<ReturnType<typeof resolveRoot>>,
    profile: PermissionProfile,
    resource: PermissionResource,
    action: LocalAction,
    target: string,
    available: boolean,
    signal?: AbortSignal,
  ): Promise<void> {
    const evaluate = async () => evaluatePermission({
      profile, resource, action,
      projectId: scope.projectId,
      targetProjectId: scope.projectId,
      targetRootName: scope.rootName,
      capabilityAvailable: available,
      customPolicy: profile === 'custom' ? await options.getCustomPolicy?.() : null,
    });
    const result = await evaluate();
    if (result.decision === 'deny') throw new LocalToolError(result.reason);
    if (result.decision === 'ask') {
      if (!options.requestApproval || !await options.requestApproval({ resource, action, target, reason: result.reason }, signal)) {
        throw new LocalToolError('Действие не подтверждено.');
      }
      const latest = await evaluate();
      if (latest.decision === 'deny') throw new LocalToolError(latest.reason);
    }
    throwIfAborted(signal);
  }

  async function prepareTarget(
    reference: unknown, profileInput: unknown, resource: PermissionResource, action: LocalAction,
    pathInput: unknown, allowRoot: boolean, allowMissing: boolean, available: boolean, signal?: AbortSignal,
    approvalDetails?: string,
  ): Promise<{ root: string; target: string; projectId: string | null }> {
    const profile = requirePermissionProfile(profileInput);
    const scope = await resolveRoot(reference, profile);
    const target = await targetPath(scope.root, pathInput, allowRoot, allowMissing);
    await authorize(scope, profile, resource, action,
      approvalDetails ? `${target}\n\n${approvalDetails}` : target, available, signal);
    const latest = await resolveRoot(reference, profile);
    if (latest.root !== scope.root) throw new LocalToolError('Рабочая папка изменилась во время подтверждения.');
    await targetPath(latest.root, pathInput, allowRoot, allowMissing);
    return { root: latest.root, target, projectId: latest.projectId };
  }

  return {
    list: (projectIdInput, profileInput, pathInput = '', listOptions = {}) => activity('list', async () => {
      const pathParts = requireRelativePath(pathInput, true);
      const { root } = await prepareTarget(projectIdInput, profileInput, 'project-files', 'list',
        pathParts.join(sep), true, false, true, listOptions.signal);
      throwIfAborted(listOptions.signal);
      const output = await runBoundedFileScript(options.runPowerShell, root,
        buildListScript(root, pathParts), listOptions.signal, MAX_ENUMERATION_OUTPUT_BYTES);
      return parseListRows(output, pathParts);
    }),

    search: (projectIdInput, profileInput, queryInput, pathInput = '', searchOptions = {}) => activity('search', async () => {
      throwIfAborted(searchOptions.signal);
      const query = requireText(queryInput, 'Поисковая строка', 256).toLocaleLowerCase();
      const pathParts = requireRelativePath(pathInput, true);
      const { root } = await prepareTarget(projectIdInput, profileInput, 'project-files', 'search',
        pathParts.join(sep), true, false, true, searchOptions.signal);
      const output = await runBoundedFileScript(options.runPowerShell, root,
        buildSearchScript(root, pathParts, query), searchOptions.signal, MAX_ENUMERATION_OUTPUT_BYTES);
      return parseSearchRows(output, pathParts);
    }),

    read: (projectIdInput, profileInput, pathInput, readOptions = {}) => activity('read', async () => {
      const { root } = await prepareTarget(projectIdInput, profileInput, 'project-files', 'read',
        pathInput, false, false, true, readOptions.signal);
      throwIfAborted(readOptions.signal);
      const output = await runBoundedFileScript(options.runPowerShell, root, buildReadScript(root, requireRelativePath(pathInput, false)),
        readOptions.signal, 2 * 1024 * 1024);
      return decodeText(parseBase64Output(output, MAX_LOCAL_FILE_BYTES));
    }),

    write: (projectIdInput, profileInput, pathInput, contentsInput, writeOptions = {}) => activity('write', async () => {
      const { root } = await prepareTarget(projectIdInput, profileInput, 'project-files', 'write',
        pathInput, false, true, Boolean(options.writeFile), writeOptions.signal);
      throwIfAborted(writeOptions.signal);
      if (typeof contentsInput !== 'string' || contentsInput.includes('\0')) {
        throw new LocalToolError('Содержимое файла должно быть текстом без NUL.');
      }
      const bytes = Buffer.from(contentsInput, 'utf8');
      if (bytes.byteLength > MAX_LOCAL_FILE_BYTES
        || new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== contentsInput) {
        throw new LocalToolError('Текст должен помещаться в лимит 1 МиБ и содержать корректный Unicode.');
      }
      if (!options.writeFile) throw new LocalToolError('Структурированная запись проекта пока недоступна.');
      const result = await options.writeFile({
        workingFolder: root,
        relativePath: requireRelativePath(pathInput, false).join('\\'),
        contentsBase64: bytes.toString('base64'),
        ...(writeOptions.signal ? { signal: writeOptions.signal } : {}),
      });
      if (result.bytes !== bytes.byteLength || typeof result.replacedExisting !== 'boolean') {
        throw new LocalToolError('Файловый writer вернул неверный размер файла.');
      }
      return { bytes: bytes.byteLength };
    }),

    open: (projectIdInput, profileInput, pathInput = '') => activity('open', async () => {
      const { root, target } = await prepareTarget(projectIdInput, profileInput, 'application', 'open',
        pathInput, true, false, Boolean(options.revealItem || options.openTextFile));
      const targetInfo = await lstat(target).catch(() => null);
      if (!targetInfo || targetInfo.isSymbolicLink()) throw new LocalToolError('Файл или папка проекта недоступны.');
      if (targetInfo.isDirectory()) {
        if (!options.revealItem) throw new LocalToolError('Показ папки в Проводнике пока недоступен.');
        await options.revealItem(target);
        return;
      }
      if (!targetInfo.isFile() || !OPEN_TEXT_EXTENSIONS.has(extname(target).toLowerCase())) {
        throw new LocalToolError('Этот тип файла нельзя безопасно открыть для просмотра.');
      }
      if (!options.openTextFile) throw new LocalToolError('Просмотр текста пока недоступен.');

      const readTarget = await prepareTarget(projectIdInput, profileInput, 'project-files', 'read',
        pathInput, false, false, Boolean(options.runPowerShell));
      if (readTarget.root !== root) throw new LocalToolError('Рабочая папка изменилась во время открытия файла.');
      const output = await runBoundedFileScript(options.runPowerShell, root,
        buildReadScript(root, requireRelativePath(pathInput, false)), undefined, 2 * 1024 * 1024);
      decodeText(parseBase64Output(output, MAX_LOCAL_FILE_BYTES));
      await options.openTextFile(target);
    }),

    runPowerShell: (projectIdInput, profileInput, scriptInput, runOptions = {}) => activity('powershell', async () => {
      const available = process.platform === 'win32' && Boolean(options.runPowerShell);
      if (!available || !options.runPowerShell) throw new LocalToolError('PowerShell helper пока недоступен.');
      const profile = requirePermissionProfile(profileInput);
      if (runOptions.fullAccessOnce !== undefined && typeof runOptions.fullAccessOnce !== 'boolean') {
        throw new LocalToolError('Некорректный режим однократного доступа PowerShell.');
      }
      const requestFullAccessOnce = runOptions.fullAccessOnce === true;
      if (requestFullAccessOnce && profile === 'custom') {
        throw new LocalToolError('Однократный выход за пользовательские правила недоступен.');
      }
      const script = requireText(scriptInput, 'PowerShell script', MAX_SCRIPT_LENGTH);
      const timeoutMs = runOptions.timeoutMs === undefined ? 30_000 : runOptions.timeoutMs;
      if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_RUN_TIMEOUT_MS) {
        throw new LocalToolError('Таймаут должен быть целым числом от 100 до 120000 мс.');
      }
      let root: string;
      let projectScoped: boolean;
      let trustedFullAccess = profile === 'full';
      if (requestFullAccessOnce && (profile === 'ask' || profile === 'approve')) {
        const scope = await resolveRoot(projectIdInput, profile, true);
        await targetPath(scope.root, '', true, false);
        const permission = evaluatePermission({
          profile,
          resource: 'process',
          action: 'execute',
          projectId: scope.projectId,
          targetProjectId: null,
          targetRootName: scope.rootName,
          capabilityAvailable: available,
        });
        if (permission.decision === 'deny') throw new LocalToolError(permission.reason);
        const target = `PowerShell без AppContainer\nРабочая папка: ${scope.root}\nКоманда:\n${script}`;
        const reason = `${permission.reason} Команда получит доступ к файлам, доступным текущей учётной записи, и сети; доступ не ограничен одним путём.`;
        if (permission.decision !== 'ask' || !options.requestApproval
          || !await options.requestApproval({ resource: 'process', action: 'execute', target, reason }, runOptions.signal)) {
          throw new LocalToolError('Действие не подтверждено.');
        }
        throwIfAborted(runOptions.signal);
        const latest = await resolveRoot(projectIdInput, profile, true);
        if (latest.root !== scope.root || latest.projectId !== scope.projectId || latest.rootName !== scope.rootName) {
          throw new LocalToolError('Рабочая папка изменилась во время подтверждения.');
        }
        await targetPath(latest.root, '', true, false);
        root = latest.root;
        projectScoped = latest.projectId !== null;
        trustedFullAccess = true;
      } else {
        const scope = await prepareTarget(projectIdInput, profile, 'process', 'execute',
          '', true, false, true, runOptions.signal, `PowerShell:\n${script}`);
        root = scope.root;
        projectScoped = scope.projectId !== null;
      }
      return options.runPowerShell({
        workingFolder: root,
        script,
        timeoutMs,
        maxOutputBytes: MAX_LOCAL_FILE_BYTES,
        trustedFullAccess,
        projectScoped,
        ...(runOptions.signal ? { signal: runOptions.signal } : {}),
      });
    }),
  };
}
