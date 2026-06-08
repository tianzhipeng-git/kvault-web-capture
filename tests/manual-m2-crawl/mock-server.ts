import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

function getArg(flag: string, fallback: string): string {
  const index = process.argv.indexOf(flag);

  if (index === -1) {
    return fallback;
  }

  return process.argv[index + 1] ?? fallback;
}

function renderHtml(input: {
  title: string;
  metaDescription: string;
  bodyText: string;
  links?: string[];
  scripts?: string[];
}): string {
  const links = (input.links ?? [])
    .map((href) => `<a href="${href}">${href}</a>`)
    .join('\n');
  const scripts = (input.scripts ?? [])
    .map((script) => `<script type="application/json">${script}</script>`)
    .join('\n');

  return `<!doctype html>
<html>
  <head>
    <title>${input.title}</title>
    <meta name="description" content="${input.metaDescription}" />
  </head>
  <body>
    <main>
      <h1>${input.title}</h1>
      <p>${input.bodyText}</p>
      <p>M2 Mock keyword: M2 Mock</p>
    </main>
    <nav>${links}</nav>
    ${scripts}
  </body>
</html>`;
}

function largeText(seed: string, repeat: number): string {
  return Array.from({ length: repeat }, (_, index) => `${seed} section ${index + 1}.`).join(' ');
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
  counters: Map<string, number>,
): void {
  const requestUrl = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
  const path = requestUrl.pathname;

  if (path === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (path === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/docs</loc></url>
  <url><loc>http://127.0.0.1:${port}/blog</loc></url>
  <url><loc>http://127.0.0.1:${port}/login</loc></url>
  <url><loc>http://127.0.0.1:${port}/search?q=m2</loc></url>
</urlset>`);
    return;
  }

  if (path === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Home',
      metaDescription: 'M2 mock homepage',
      bodyText: largeText('M2 Mock homepage for discovery and baseline crawl testing', 18),
      links: ['/docs', '/blog', '/login', '/admin', '/search?q=m2'],
    }));
    return;
  }

  if (path === '/docs') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Docs',
      metaDescription: 'M2 mock documentation page',
      bodyText: largeText('M2 Mock docs content for markdown screenshot structured validation', 45),
      links: ['/docs/getting-started', '/product-or-doc-page', '/blog', '/login'],
    }));
    return;
  }

  if (path === '/docs/getting-started') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Getting Started',
      metaDescription: 'M2 mock nested docs page',
      bodyText: largeText('M2 Mock nested documentation content for depth checks', 32),
      links: ['/support'],
    }));
    return;
  }

  if (path === '/product-or-doc-page') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Product Detail',
      metaDescription: 'M2 mock product detail page',
      bodyText: largeText('M2 Mock product detail content with structured fields price specs and availability', 40),
      links: ['/support'],
      scripts: [
        JSON.stringify({
          product: {
            name: 'M2 Mock Product',
            price: '$42',
            comments: [
              {
                id: 'comment-1',
                author: 'tester',
                body: 'Structured JSON payload is present for extraction checks.',
                created_at: '2026-06-08T00:00:00.000Z',
              },
            ],
          },
        }),
      ],
    }));
    return;
  }

  if (path === '/blog') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Blog',
      metaDescription: 'M2 mock blog page',
      bodyText: largeText('M2 Mock blog content for markdown only rule checks', 24),
      links: ['/blog/post-1', '/search?q=blog'],
    }));
    return;
  }

  if (path === '/blog/post-1') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Blog Post',
      metaDescription: 'M2 mock blog post',
      bodyText: largeText('M2 Mock blog post content for second level crawling', 20),
    }));
    return;
  }

  if (path === '/support') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Support',
      metaDescription: 'M2 mock support page',
      bodyText: largeText('M2 Mock support content intentionally outside specific stage2 url whitelists', 16),
    }));
    return;
  }

  if (path === '/login' || path === '/admin') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Restricted',
      metaDescription: 'M2 mock restricted page',
      bodyText: 'This page should be denied by rules before base capture.',
    }));
    return;
  }

  if (path === '/search') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Search',
      metaDescription: 'M2 mock search page',
      bodyText: 'This page should be denied by rules before stage2.',
    }));
    return;
  }

  if (path === '/__manual__/flaky-500-then-200') {
    const count = counters.get(path) ?? 0;
    counters.set(path, count + 1);

    if (count === 0) {
      res.writeHead(500, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderHtml({
        title: 'M2 Mock Temporary Failure',
        metaDescription: 'first request fails',
        bodyText: 'Temporary server failure for retry checks.',
      }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'M2 Mock Retry Success',
      metaDescription: 'retry request succeeds',
      bodyText: largeText('M2 Mock retry success content after the first failing response', 18),
    }));
    return;
  }

  if (path === '/__manual__/always-blocked') {
    res.writeHead(403, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderHtml({
      title: 'Access Denied',
      metaDescription: 'blocked page',
      bodyText: 'Access Denied. Please verify you are human.',
    }));
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

async function main(): Promise<void> {
  const port = Number(getArg('--port', '4328'));

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  const counters = new Map<string, number>();
  const server = createServer((req, res) => handleRequest(req, res, port, counters));

  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve());
  });

  console.log(JSON.stringify({
    status: 'listening',
    baseUrl: `http://127.0.0.1:${port}`,
    sitemapUrl: `http://127.0.0.1:${port}/sitemap.xml`,
  }, null, 2));

  const shutdown = async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
