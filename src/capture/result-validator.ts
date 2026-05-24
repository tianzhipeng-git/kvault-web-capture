import type {
  CaptureCapability,
  CaptureValidationConfig,
  CaptureValidationRule,
  SiteConfig,
} from '../domain/types.js';
import type { CaptureToolResult } from './types.js';

const DEFAULT_REJECT_PATTERNS = [
  'Access Denied',
  'Just a moment',
  'verify you are human',
  'Please enable JavaScript',
] as const;

export interface CapabilityValidationResult {
  accepted: boolean;
  message?: string;
}

function mergeRule(
  globalRule: CaptureValidationRule | undefined,
  profileRule: CaptureValidationRule | undefined,
): CaptureValidationRule | undefined {
  if (!globalRule && !profileRule) {
    return undefined;
  }

  return {
    ...globalRule,
    ...profileRule,
    rejectRegex: [
      ...(globalRule?.rejectRegex ?? []),
      ...(profileRule?.rejectRegex ?? []),
    ],
    requireRegex: [
      ...(globalRule?.requireRegex ?? []),
      ...(profileRule?.requireRegex ?? []),
    ],
  };
}

function textMatchesAny(text: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    if (new RegExp(pattern, 'i').test(text)) {
      return pattern;
    }
  }
  return null;
}

function validateText(
  value: string,
  rule: CaptureValidationRule | undefined,
  defaultRejectPatterns: readonly string[] = [],
): CapabilityValidationResult {
  const minLength = rule?.minLength ?? 1;
  if (value.trim().length < minLength) {
    return { accepted: false, message: `text length is below ${minLength}` };
  }

  const rejectedBy = textMatchesAny(value, [
    ...defaultRejectPatterns,
    ...(rule?.rejectRegex ?? []),
  ]);
  if (rejectedBy) {
    return { accepted: false, message: `text matched rejectRegex ${rejectedBy}` };
  }

  for (const pattern of rule?.requireRegex ?? []) {
    if (!new RegExp(pattern, 'i').test(value)) {
      return { accepted: false, message: `text did not match requireRegex ${pattern}` };
    }
  }

  return { accepted: true };
}

function validateBaseText(
  html: string,
  bodyText: string,
  rule: CaptureValidationRule | undefined,
): CapabilityValidationResult {
  const minLength = rule?.minLength ?? 1;
  if (bodyText.trim().length < minLength) {
    return { accepted: false, message: `bodyText length is below ${minLength}` };
  }

  const rejectedBy = textMatchesAny(html, [
    ...DEFAULT_REJECT_PATTERNS,
    ...(rule?.rejectRegex ?? []),
  ]);
  if (rejectedBy) {
    return { accepted: false, message: `html matched rejectRegex ${rejectedBy}` };
  }

  for (const pattern of rule?.requireRegex ?? []) {
    if (!new RegExp(pattern, 'i').test(html)) {
      return { accepted: false, message: `html did not match requireRegex ${pattern}` };
    }
  }

  return { accepted: true };
}

function isJsonSerializable(value: unknown): boolean {
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

export class ResultValidator {
  private rules(input: {
    siteConfig: SiteConfig;
    profileValidation?: CaptureValidationConfig;
  }): Required<Record<CaptureCapability, CaptureValidationRule | undefined>> {
    return {
      base: mergeRule(input.siteConfig.validation?.base, input.profileValidation?.base),
      markdown: mergeRule(input.siteConfig.validation?.markdown, input.profileValidation?.markdown),
      screenshot: mergeRule(input.siteConfig.validation?.screenshot, input.profileValidation?.screenshot),
      structured: mergeRule(input.siteConfig.validation?.structured, input.profileValidation?.structured),
    };
  }

  validate(input: {
    capability: CaptureCapability;
    result: CaptureToolResult;
    siteConfig: SiteConfig;
    profileValidation?: CaptureValidationConfig;
  }): CapabilityValidationResult {
    const rules = this.rules(input);

    switch (input.capability) {
      case 'base': {
        const statusCode = input.result.statusCode;
        if (statusCode !== undefined && (statusCode < 200 || statusCode >= 400)) {
          return { accepted: false, message: `statusCode ${statusCode} is not successful` };
        }
        if (!input.result.html || input.result.html.trim() === '') {
          return { accepted: false, message: 'html is empty' };
        }
        if (!input.result.extracted) {
          return { accepted: false, message: 'extracted page is missing' };
        }
        return validateBaseText(input.result.html, input.result.extracted.bodyText, rules.base);
      }
      case 'markdown': {
        if (!input.result.markdown) {
          return { accepted: false, message: 'markdown is missing' };
        }
        return validateText(input.result.markdown, rules.markdown, DEFAULT_REJECT_PATTERNS);
      }
      case 'screenshot': {
        const minBytes = rules.screenshot?.minBytes ?? 1;
        if (!input.result.screenshot || input.result.screenshot.byteLength < minBytes) {
          return { accepted: false, message: `screenshot is below ${minBytes} bytes` };
        }
        return { accepted: true };
      }
      case 'structured': {
        if (input.result.structured === undefined) {
          return { accepted: false, message: 'structured result is missing' };
        }
        if (!isJsonSerializable(input.result.structured)) {
          return { accepted: false, message: 'structured result is not JSON serializable' };
        }
        return { accepted: true };
      }
      default: {
        const exhaustive: never = input.capability;
        return exhaustive;
      }
    }
  }
}
