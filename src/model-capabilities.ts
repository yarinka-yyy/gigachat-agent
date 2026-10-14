export type ModelCapabilityStatus = 'verified' | 'unavailable' | 'unverified';

export interface ModelCapabilities {
  textStream: ModelCapabilityStatus;
  functionCalls: ModelCapabilityStatus;
  localRead: ModelCapabilityStatus;
  txt: ModelCapabilityStatus;
  md: ModelCapabilityStatus;
  pdf: ModelCapabilityStatus;
  png: ModelCapabilityStatus;
  jpeg: ModelCapabilityStatus;
  usage: ModelCapabilityStatus;
  evidence: {
    source: string;
    verifiedAt: string | null;
    details: string;
  };
}

export interface ModelContextLimitEvidence {
  limitTokens: number | null;
  provenance: 'official-model-docs' | 'unknown';
  source: string | null;
  verifiedAt: string | null;
}

const UNKNOWN_CONTEXT_LIMIT: Readonly<ModelContextLimitEvidence> = {
  limitTokens: null,
  provenance: 'unknown',
  source: null,
  verifiedAt: null,
};

const DOCUMENTED_CONTEXT_LIMITS: Readonly<Record<string, Readonly<ModelContextLimitEvidence>>> = {
  'GigaChat-3-Ultra': {
    limitTokens: 128_000,
    provenance: 'official-model-docs',
    source: 'developers.sber.ru models/main + models/updates',
    verifiedAt: '2026-10-14',
  },
  'GigaChat-2-Max': {
    limitTokens: 128_000,
    provenance: 'official-model-docs',
    source: 'developers.sber.ru models/main + models/updates',
    verifiedAt: '2026-10-14',
  },
};

export function getModelContextLimit(modelId: string | null): ModelContextLimitEvidence {
  const evidence = modelId !== null && Object.prototype.hasOwnProperty.call(DOCUMENTED_CONTEXT_LIMITS, modelId)
    ? DOCUMENTED_CONTEXT_LIMITS[modelId]!
    : UNKNOWN_CONTEXT_LIMIT;
  return { ...evidence };
}

const UNVERIFIED: ModelCapabilities = {
  textStream: 'unverified',
  functionCalls: 'unverified',
  localRead: 'unverified',
  txt: 'unverified',
  md: 'unverified',
  pdf: 'unverified',
  png: 'unverified',
  jpeg: 'unverified',
  usage: 'unverified',
  evidence: { source: 'no semantic API probe', verifiedAt: null, details: 'Capabilities remain unverified until a bounded real-model check.' },
};

const MODEL_CAPABILITIES: Readonly<Record<string, Readonly<ModelCapabilities>>> = {
  'GigaChat-3-Ultra': {
    textStream: 'verified',
    functionCalls: 'verified',
    localRead: 'verified',
    txt: 'verified',
    md: 'verified',
    pdf: 'verified',
    png: 'verified',
    jpeg: 'verified',
    usage: 'verified',
    evidence: {
      source: 'app/.qa/capability-spike/summary.md; app/.qa/post-api-011/stage3-live-893676a7-ae44-4c80-b57c-d0db174e0140; app/.qa/post-api-011/stage3-supplemental-live-26aabefe-ce02-4c2e-8d55-2c0bb65b0196',
      verifiedAt: '2026-10-13',
      details: 'Semantic text answer, local read tool roundtrip, TXT/MD/PDF/PNG/JPEG markers, and usage receipt passed. Pairing multiple images remains unverified; XLSX is unavailable.',
    },
  },
  'GigaChat-2-Max': {
    ...UNVERIFIED,
    textStream: 'verified',
    functionCalls: 'verified',
    localRead: 'verified',
    txt: 'verified',
    usage: 'verified',
    evidence: {
      source: 'app/.qa/post-api-011/results-04c31349-0b7a-416b-8d67-49863e200376.jsonl',
      verifiedAt: '2026-10-12',
      details: 'Реальная проверка: ответ, локальное чтение, TXT и расход токенов подтверждены. PDF и PNG этим запуском не подтверждены.',
    },
  },
  'GigaChat-3-Pro': {
    ...UNVERIFIED,
    textStream: 'verified',
    functionCalls: 'verified',
    localRead: 'verified',
    txt: 'verified',
    usage: 'verified',
    evidence: {
      source: 'app/.qa/post-api-011/results-04c31349-0b7a-416b-8d67-49863e200376.jsonl; plans/011-model-evidence.md',
      verifiedAt: '2026-10-12',
      details: 'Реальная проверка: ответ, локальное чтение, TXT и расход токенов подтверждены. PDF и PNG этим запуском не подтверждены.',
    },
  },
  'GigaChat-3-Lightning': {
    ...UNVERIFIED,
    textStream: 'verified',
    functionCalls: 'verified',
    localRead: 'verified',
    txt: 'verified',
    usage: 'verified',
    png: 'unavailable',
    evidence: {
      source: 'app/.qa/post-api-011/results-04c31349-0b7a-416b-8d67-49863e200376.jsonl; plans/011-model-evidence.md',
      verifiedAt: '2026-10-12',
      details: 'Реальная проверка: ответ, локальное чтение, TXT и расход токенов подтверждены. PDF и PNG этим запуском не подтверждены; PNG-запрос отклонён с HTTP 422.',
    },
  },
};

export function getModelCapabilities(modelId: string): ModelCapabilities {
  const capabilities = MODEL_CAPABILITIES[modelId] ?? UNVERIFIED;
  return { ...capabilities, evidence: { ...capabilities.evidence } };
}

export function basicAgentWorkflowStatus(capabilities: ModelCapabilities): ModelCapabilityStatus {
  const required = [capabilities.textStream, capabilities.functionCalls, capabilities.localRead];
  if (required.includes('unavailable')) return 'unavailable';
  return required.every((status) => status === 'verified') ? 'verified' : 'unverified';
}
