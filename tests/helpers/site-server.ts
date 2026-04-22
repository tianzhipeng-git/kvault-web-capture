import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export interface TestSiteServer {
  baseUrl: string;
  close(): Promise<void>;
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

  if (url === '/sitemap.xml') {
    res.writeHead(200, { 'content-type': 'application/xml' });
    res.end(`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>http://127.0.0.1:${port}/docs</loc></url>
  <url><loc>http://127.0.0.1:${port}/login</loc></url>
</urlset>`);
    return;
  }

  if (url === '/docs') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      renderHtml({
        title: 'Docs',
        metaDescription: 'Example docs page',
        bodyText: 'Docs content for inventory and crawl testing.',
        links: ['/product'],
      }),
    );
    return;
  }

  if (url === '/product') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      renderHtml({
        title: 'Product',
        metaDescription: 'Example product page',
        bodyText: 'Product content for artifact capture.',
      }),
    );
    return;
  }

  if (url === '/login') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(
      renderHtml({
        title: 'Login',
        metaDescription: 'Login page',
        bodyText: 'Please sign in.',
      }),
    );
    return;
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

export async function startTestSiteServer(): Promise<TestSiteServer> {
  let port = 0;
  const server = createServer((req, res) => handleRequest(req, res, port));

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();

  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  port = address.port;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      }),
  };
}
