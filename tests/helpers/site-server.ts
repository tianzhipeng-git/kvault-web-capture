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
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>http://127.0.0.1:${port}/content-sitemap.xml</loc></sitemap>
</sitemapindex>`);
    return;
  }

  if (url === '/content-sitemap.xml') {
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

  if (url === '/advanced-screenshot') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
<html>
  <head>
    <title>Advanced Screenshot</title>
    <style>
      body { margin: 0; }
      main { min-height: 1400px; padding: 16px; }
      #scroll-container { height: 160px; overflow-y: auto; border: 1px solid black; }
      .container-item { height: 120px; }
      #lazy-marker { margin-top: 900px; height: 100px; }
    </style>
  </head>
  <body>
    <main>
      <div id="scroll-container">
        <div class="container-item">Container item 1</div>
        <div class="container-item">Container item 2</div>
        <div class="container-item">Container item 3</div>
        <div class="container-item">Container item 4</div>
      </div>
      <div id="lazy-marker">Scroll to load more content</div>
    </main>
    <script>
      let loaded = false;
      addEventListener('scroll', () => {
        if (loaded || scrollY < 500) return;
        loaded = true;
        const content = document.createElement('section');
        content.id = 'lazy-content';
        content.style.height = '700px';
        content.textContent = 'Lazy content loaded';
        document.querySelector('main').appendChild(content);
      });
    </script>
  </body>
</html>`);
    return;
  }

  if (url === '/advanced-screenshot-pending-image') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
<html><body style="min-height: 1200px"><img src="/missing-image.png" alt="missing"></body></html>`);
    return;
  }

  if (url === '/advanced-screenshot-consent') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
<html><body style="min-height: 1200px; overflow: hidden">
  <main>Consent test</main>
  <div id="consent-overlay" style="display: none; position: fixed; inset: 0; background: white">
    <button id="consent-decline">Decline</button>
  </div>
  <script>
    document.querySelector('#consent-decline').addEventListener('click', () => {
      localStorage.setItem('consent', 'declined');
      document.querySelector('#consent-overlay').remove();
      document.body.style.overflow = '';
    });
    setTimeout(() => { document.querySelector('#consent-overlay').style.display = 'block'; }, 100);
  </script>
</body></html>`);
    return;
  }

  if (url === '/advanced-screenshot-stuck-container') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<!doctype html>
<html>
  <body>
    <div id="stuck" style="height: 100px; overflow-y: auto">
      <div style="height: 800px">Virtualized content</div>
    </div>
    <script>
      const stuck = document.querySelector('#stuck');
      stuck.addEventListener('scroll', () => { stuck.scrollTop = 0; });
    </script>
  </body>
</html>`);
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
