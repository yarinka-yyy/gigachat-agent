export type ModelCapabilityStatus = 'verified' | 'unavailable' | 'unverified';

export interface ModelCapabilities {
  textStream: ModelCapabilityStatus;
  functionCalls: ModelCapabilityStatus;
  localRead: ModelCapabilityStatus;
  txt: ModelCapabilityStatus;
  pdf: ModelCapabilityStatus;
  png: ModelCapabilityStatus;
  usage: ModelCapabilityStatus;
  evidence: {
    source: string;
    verifiedAt: string | null;
    details: string;
  };
}

const UNVERIFIED: ModelCapabilities = {
  textStream: 'unverified',
  functionCalls: 'unverified',
  localRead: 'unverified',
  txt: 'unverified',
  pdf: 'unverified',
  png: 'unverified',
  usage: 'unverified',
  evidence: { source: 'no semantic API probe', verifiedAt: null, details: 'Capabilities remain unverified until a bounded real-model check.' },
};

const MODEL_CAPABILITIES: Readonly<Record<string, Readonly<ModelCapabilities>>> = {
  'GigaChat-3-Ultra': {
    textStream: 'verified',
    functionCalls: 'verified',
    localRead: 'verified',
    txt: 'verified',
    pdf: 'verified',
    png: 'verified',
    usage: 'verified',
    evidence: {
      source: 'installed-app real API spike in app/.qa/capability-spike/summary.md',
      verifiedAt: '2026-10-12',
      details: 'Semantic text answer, local read tool roundtrip, TXT/PDF/PNG markers, and usage receipt passed; XLSX is unavailable.',
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
