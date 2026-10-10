export const LOCAL_ATTACHMENT_IMPORT_LIMIT_BYTES = 25 * 1024 * 1024;

const DOCUMENTED_EXTENSIONS = new Set(['txt', 'doc', 'docx', 'pdf', 'epub', 'ppt', 'pptx', 'xlsx']);

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
