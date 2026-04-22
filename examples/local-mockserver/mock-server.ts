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
}): string {
  const links = (input.links ?? [])
    .map((href) => `<a href="${href}">${href}</a>`)
    .join('');

  return `<!doctype html>
<html>
  <head>
    <title>${input.title}</title>
    <meta name="description" content="${input.metaDescription}" />
  </head>
  <body>
    <main>${input.bodyText}</main>
    ${links}
  </body>
</html>`;
}

function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  port: number,
): void {
  const url = req.url ?? '/';

  if (url === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('ok');
    return;
  }

  if (url === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderHtml({
        title: 'Mock Home',
        metaDescription: 'Mock homepage',
        bodyText: 'Mock homepage for manual smoke checks.',
        links: ['/docs'],
      }),
    );
    return;
  }

  if (url === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml; charset=utf-8' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/docs</loc></url>
  <url><loc>http://127.0.0.1:${port}/login</loc></url>
</urlset>`);
    return;
  }

  if (url === '/docs') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderHtml({
        title: 'Docs',
        metaDescription: 'Mock docs page',
        bodyText: 'Docs content for preview, classification, and crawl testing.',
        links: ['/product', '/support', '/login'],
      }),
    );
    return;
  }

  if (url === '/product') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderHtml({
        title: 'Product',
        metaDescription: 'Mock product page',
        bodyText: 'Product details for markdown artifact capture.',
        links: ['/support'],
      }),
    );
    return;
  }

  if (url === '/support') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderHtml({
        title: 'Support',
        metaDescription: 'Mock support page',
        bodyText: 'Support content that falls back to generic classification.',
      }),
    );
    return;
  }

  if (url === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(
      renderHtml({
        title: 'Login',
        metaDescription: 'Mock login page',
        bodyText: 'Sign in here.',
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
  res.end('not found');
}

async function main(): Promise<void> {
  const port = Number(getArg('--port', '4318'));

  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid --port value: ${port}`);
  }

  const server = createServer((req, res) => handleRequest(req, res, port));

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
