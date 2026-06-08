import asyncio
import base64
import contextlib
import os
import sys

from common import extract_page, html_to_markdown, read_input, redirect_process_stdout_to_stderr, write_output


def build_page_action(needs_screenshot):
    if not needs_screenshot:
        return None, None

    capture_state = {}

    async def page_action(page):
        capture_state["screenshot"] = await page.screenshot(type="png", full_page=True)

    return page_action, capture_state


async def run(payload):
    try:
        from scrapling.fetchers import StealthyFetcher
    except Exception as exc:
        raise RuntimeError(f"scrapling is not installed or failed to import: {exc}") from exc

    needs = set(payload.get("needs") or [])
    url = payload["url"]
    proxy_url = payload.get("proxyUrl") or None
    cdp_url = payload.get("cdpWebSocketUrl") or None
    fetch_kwargs = {
        "timeout": 120000,
    }

    if cdp_url:
        fetch_kwargs["cdp_url"] = cdp_url
        fetch_kwargs["network_idle"] = False
        fetch_kwargs["solve_cloudflare"] = False
    else:
        fetch_kwargs["headless"] = True
        fetch_kwargs["network_idle"] = True
        fetch_kwargs["solve_cloudflare"] = True
        if proxy_url:
            fetch_kwargs["proxy"] = proxy_url

    page_action, capture_state = build_page_action("screenshot" in needs)
    if page_action is not None:
        fetch_kwargs["page_action"] = page_action

    with contextlib.redirect_stdout(sys.stderr):
        response = await StealthyFetcher.async_fetch(
            url,
            **fetch_kwargs,
        )

    html = getattr(response, "html_content", "") or getattr(response, "text", "") or ""
    if not isinstance(html, str):
        html = str(html)
    final_url = getattr(response, "url", None) or url
    status_code = getattr(response, "status", None) or getattr(response, "status_code", None)
    extracted = extract_page(html, final_url)
    screenshot_bytes = capture_state.get("screenshot") if capture_state else None

    return {
        "toolName": "scrapling-page",
        "finalUrl": final_url,
        "statusCode": status_code,
        "html": html,
        **extracted,
        "markdown": html_to_markdown(html) if "markdown" in needs else None,
        "screenshotBase64": base64.b64encode(screenshot_bytes).decode("ascii")
        if screenshot_bytes
        else None,
        "structured": {
            "statusCode": status_code,
            "finalUrl": final_url,
            "contentLength": len(html),
            "title": extracted["title"],
            "metaDescription": extracted["metaDescription"],
        } if "structured" in needs else None,
        "diagnostics": {
            "source": "scrapling",
            "cdpUrlUsed": bool(cdp_url),
            "markdownSource": "markdownify" if "markdown" in needs else None,
            "screenshotSource": "page_action" if screenshot_bytes else None,
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
