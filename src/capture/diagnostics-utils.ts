import type { CaptureDiagnostic } from './types.js';

export function failedToolDiagnostics(diagnostics: CaptureDiagnostic[]): CaptureDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.status === 'failed');
}

export function succeededToolDiagnostics(diagnostics: CaptureDiagnostic[]): CaptureDiagnostic[] {
  return diagnostics.filter((diagnostic) => diagnostic.status === 'succeeded');
}

export function formatToolFallbackSummary(diagnostics: CaptureDiagnostic[]): string {
  const failed = failedToolDiagnostics(diagnostics);
  const succeeded = succeededToolDiagnostics(diagnostics);

  if (failed.length === 0) {
    return '';
  }

  const failedSummary = failed
    .map((diagnostic) => `${diagnostic.toolName}: ${diagnostic.message ?? 'failed'}`)
    .join(' | ');
  const succeededSummary = succeeded.map((diagnostic) => diagnostic.toolName).join(', ');

  return succeededSummary
    ? `failed tools: ${failedSummary}; succeeded via: ${succeededSummary}`
    : `failed tools: ${failedSummary}`;
}
