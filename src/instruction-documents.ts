import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { InstructionDocument } from './contracts';

function normalizedTarget(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLocaleLowerCase('en-US') : resolved;
}

export function instructionFileHash(text: string | null): string | null {
  return text === null ? null : createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createInstructionDocument(path: string, text: string | null): InstructionDocument {
  const normalizedPath = normalizedTarget(path);
  const state = text === null ? 'missing' : 'present';
  const revision = createHash('sha256')
    .update(JSON.stringify([normalizedPath, state, text]), 'utf8')
    .digest('hex');
  return { text: text ?? '', revision };
}
