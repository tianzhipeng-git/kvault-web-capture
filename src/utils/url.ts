export function normalizeUrl(input: string): string {
  const url = new URL(input);
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();

  const keptEntries = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_'))
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
