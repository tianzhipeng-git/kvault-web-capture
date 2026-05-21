After each crawl attempt, Crawl4AI inspects the HTTP status code and HTML content for known anti-bot signals:

- HTTP 403/429 with short or empty response bodies
- Challenge pages — Cloudflare "Just a moment", Akamai "Access Denied", PerimeterX block pages
- CAPTCHA injection — reCAPTCHA, hCaptcha, or vendor-specific challenges on otherwise empty pages
- Firewall blocks — Imperva/Incapsula resource iframes, Sucuri firewall pages, Cloudflare error codes

https://www.capsolver.com/


https://docs.apify.com/academy/anti-scraping
