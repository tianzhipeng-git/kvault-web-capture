import type { UrlNormalizationConfig } from '../domain/types.js';

function uniqueLowercase(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))];
}

export function mergeUrlNormalizationConfigs(
  systemConfig: UrlNormalizationConfig,
  siteConfig?: UrlNormalizationConfig,
): UrlNormalizationConfig {
  return {
    stripQueryParams: uniqueLowercase([
      ...systemConfig.stripQueryParams,
      ...(siteConfig?.stripQueryParams ?? []),
    ]),
    stripQueryParamPrefixes: uniqueLowercase([
      ...(systemConfig.stripQueryParamPrefixes ?? []),
      ...(siteConfig?.stripQueryParamPrefixes ?? []),
    ]),
  };
}

export function normalizeUrl(input: string, config?: UrlNormalizationConfig): string {
  const url = new URL(input);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  const stripQueryParams = new Set((config?.stripQueryParams ?? []).map((key) => key.toLowerCase()));
  const stripQueryParamPrefixes = (config?.stripQueryParamPrefixes ?? []).map((prefix) => prefix.toLowerCase());

  const keptEntries = [...url.searchParams.entries()]
    .filter(([key]) => {
      const k = key.toLowerCase();
      return !stripQueryParams.has(k) && !stripQueryParamPrefixes.some((prefix) => k.startsWith(prefix));
    })
    .sort(([left], [right]) => left.localeCompare(right));

  url.search = '';

  for (const [key, value] of keptEntries) {
    url.searchParams.append(key, value);
  }

  if (url.pathname !== '/' && url.pathname.endsWith('/')) {
    url.pathname = url.pathname.slice(0, -1);
  }

  return url.toString();
}

export function isInvalidUrlError(error: unknown): boolean {
  return error instanceof TypeError && error.message === 'Invalid URL';
}
