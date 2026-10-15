import { Buffer } from 'node:buffer';
import type { ProviderV2FunctionContentPart, ProviderV2FunctionWire } from './contracts';

const MAX_ARGUMENT_BYTES = 1_900_000;
const MAX_CONTENT_BYTES = 16_000;
const MAX_WIRE_BYTES = 1_950_000;
const MAX_CONTENT_PARTS = 8;

export interface ProviderV2FunctionCallExpectation {
  name: string;
  arguments: Record<string, unknown>;
  content: string | null;
  functionsStateId: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.prototype.hasOwnProperty.call(value, key)) && keys.every((key) => allowed.has(key));
}

function safeText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= maxBytes;
}

function safeIdentity(value: unknown, maxBytes: number): value is string {
  return safeText(value, maxBytes) && value.length > 0
    // eslint-disable-next-line no-control-regex -- Provider identifiers cannot contain control characters.
    && !/[\u0000-\u001F\u007F]/.test(value);
}

function isUuidV4(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function isUuidV4OrV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-(?:4[0-9a-f]{3}|7[0-9a-f]{3})-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== 'object') throw new Error('Non-JSON provider arguments.');
  if (Array.isArray(value)) return `[${Array.from(value, canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const prototype = Object.getPrototypeOf(record);
  if (prototype !== Object.prototype && prototype !== null) throw new Error('Non-JSON provider arguments.');
  const keys = Object.keys(record).sort();
  if (keys.some((key) => record[key] === undefined)) throw new Error('Non-JSON provider arguments.');
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

function parseArguments(value: unknown): Record<string, unknown> | null {
  let parsed = value;
  if (typeof parsed === 'string') {
    if (Buffer.byteLength(parsed, 'utf8') > MAX_ARGUMENT_BYTES) return null;
    try { parsed = JSON.parse(parsed) as unknown; } catch { return null; }
  }
  if (!isRecord(parsed)) return null;
  try {
    const encoded = canonicalJson(parsed);
    if (Buffer.byteLength(encoded, 'utf8') > MAX_ARGUMENT_BYTES) return null;
    return structuredClone(parsed);
  } catch {
    return null;
  }
}

/** Validates and clones the exact V2 assistant call envelope without normalizing its wire representation. */
export function validateProviderV2FunctionWire(
  value: unknown,
  expected?: ProviderV2FunctionCallExpectation,
): ProviderV2FunctionWire | null {
  try {
    return validateWire(value, expected);
  } catch {
    return null;
  }
}

function validateWire(
  value: unknown,
  expected?: ProviderV2FunctionCallExpectation,
): ProviderV2FunctionWire | null {
  if (!isRecord(value) || !hasExactKeys(value, ['content'], ['messageId', 'toolStateId'])
    || !Array.isArray(value.content) || value.content.length === 0 || value.content.length > MAX_CONTENT_PARTS
    || (value.messageId !== undefined && !safeIdentity(value.messageId, 256))
    || (value.toolStateId !== undefined && !safeIdentity(value.toolStateId, 4096))) return null;

  const content: ProviderV2FunctionContentPart[] = [];
  let functionName: string | null = null;
  let functionArguments: Record<string, unknown> | null = null;
  let functionState: unknown;
  let text = '';
  let hasText = false;
  let callCount = 0;
  for (const part of value.content) {
    if (!isRecord(part)) return null;
    if (hasExactKeys(part, ['text'])) {
      if (!safeText(part.text, MAX_CONTENT_BYTES)) return null;
      hasText = true;
      text += part.text;
      if (Buffer.byteLength(text, 'utf8') > MAX_CONTENT_BYTES) return null;
      content.push({ text: part.text });
      continue;
    }
    if (!hasExactKeys(part, ['function_call']) || !isRecord(part.function_call)) return null;
    const call = part.function_call;
    if (!hasExactKeys(call, ['name', 'arguments'], ['id']) || !safeIdentity(call.name, 128)
      || (call.id !== undefined && !safeIdentity(call.id, 256))) return null;
    if (call.id !== undefined && (!safeIdentity(call.id, 256) || !isUuidV4(call.id))) return null;
    const normalizedArguments = parseArguments(call.arguments);
    if (!normalizedArguments) return null;
    try {
      functionName = call.name;
      functionArguments = normalizedArguments;
      functionState = value.toolStateId;
      callCount += 1;
      content.push({ function_call: {
        ...(call.id === undefined ? {} : { id: call.id as string }),
        name: call.name,
        arguments: typeof call.arguments === 'string' ? call.arguments : structuredClone(call.arguments as Record<string, unknown>),
      } });
    } catch { return null; }
  }
  if (callCount !== 1) return null;
  if (value.toolStateId !== undefined && !isUuidV4OrV7(value.toolStateId)) return null;

  const wire: ProviderV2FunctionWire = {
    content,
    ...(value.messageId === undefined ? {} : { messageId: value.messageId as string }),
    ...(value.toolStateId === undefined ? {} : { toolStateId: value.toolStateId as string }),
  };
  let wireBytes: number;
  try { wireBytes = Buffer.byteLength(JSON.stringify(wire), 'utf8'); } catch { return null; }
  if (wireBytes > MAX_WIRE_BYTES) return null;
  if (expected) {
    try {
      if (functionName !== expected.name || !functionArguments
        || canonicalJson(functionArguments) !== canonicalJson(expected.arguments)
        || (hasText ? text : null) !== expected.content || (functionState ?? null) !== expected.functionsStateId) return null;
    } catch { return null; }
  }
  return wire;
}
