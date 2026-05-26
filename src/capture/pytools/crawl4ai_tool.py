import asyncio
import contextlib
import os
import sys

from common import extract_page, read_input, redirect_process_stdout_to_stderr, write_output


async def run(payload):
    try:
        from crawl4ai import AsyncWebCrawler, BrowserConfig, CacheMode, CrawlerRunConfig
    except Exception as exc:
        raise RuntimeError(f"crawl4ai is not installed or failed to import: {exc}") from exc

    needs = set(payload.get("needs") or [])
    url = payload["url"]

    cdp_url = payload.get("cdpWebSocketUrl") or payload.get("cdpHttpUrl") or None
    browser_cfg_kwargs = {
        "headless": True,
        "enable_stealth": True,
        "verbose": False,
        "proxy": payload.get("proxyUrl") or None,
    }
    if cdp_url:
        browser_cfg_kwargs["cdp_url"] = cdp_url
    browser_cfg = BrowserConfig(**browser_cfg_kwargs)
    run_cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        delay_before_return_html=2.0,
        screenshot="screenshot" in needs,
    )

    async with AsyncWebCrawler(config=browser_cfg) as crawler:
        with contextlib.redirect_stdout(sys.stderr):
            result = await crawler.arun(url=url, config=run_cfg)

    if not getattr(result, "success", False):
        raise RuntimeError(getattr(result, "error_message", "") or "crawl4ai crawl failed")

    html = getattr(result, "html", "") or ""
    markdown = getattr(result, "markdown", None)
    screenshot = getattr(result, "screenshot", None)
    final_url = getattr(result, "url", None) or url
    extracted = extract_page(html, final_url)

    return {
        "toolName": "crawl4ai-page",
        "finalUrl": final_url,
        "statusCode": getattr(result, "status_code", None),
        "html": html,
        **extracted,
        "markdown": markdown if "markdown" in needs else None,
        "screenshotBase64": screenshot if "screenshot" in needs else None,
        "structured": {
            "success": True,
            "finalUrl": final_url,
            "contentLength": len(html),
        } if "structured" in needs else None,
        "diagnostics": {
            "source": "crawl4ai",
            "cdpUrlUsed": bool(cdp_url),
        },
    }


def main():
    output_fd = redirect_process_stdout_to_stderr()
    try:
        write_output(asyncio.run(run(read_input())), output_fd=output_fd)
    except Exception as exc:
        try:
            os.close(output_fd)
        except OSError:
            pass
        sys.stderr.write(str(exc))
        sys.exit(1)


if __name__ == "__main__":
    main()
