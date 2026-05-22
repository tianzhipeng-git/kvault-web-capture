After each crawl attempt, Crawl4AI inspects the HTTP status code and HTML content for known anti-bot signals:

- HTTP 403/429 with short or empty response bodies
- Challenge pages — Cloudflare "Just a moment", Akamai "Access Denied", PerimeterX block pages
- CAPTCHA injection — reCAPTCHA, hCaptcha, or vendor-specific challenges on otherwise empty pages
- Firewall blocks — Imperva/Incapsula resource iframes, Sucuri firewall pages, Cloudflare error codes

https://www.capsolver.com/


https://docs.apify.com/academy/anti-scraping

添加类似人类的行为。不要像机器人一样浏览网站（快速地从 1 翻到 100 页）。相反，访问各种类型的页面，添加时间随机性，甚至可以加入一些鼠标移动和点击动作。
