import asyncio
import base64
import contextlib
import os
import sys

from common import extract_page, html_to_markdown, read_input, redirect_process_stdout_to_stderr, write_output


SOFT_NETWORK_IDLE_TIMEOUT_MS = 10000


def build_page_action(needs_screenshot):
    capture_state = {}

    async def page_action(page):
        try:
            await page.wait_for_load_state("networkidle", timeout=SOFT_NETWORK_IDLE_TIMEOUT_MS)
        except Exception:
            pass

        if needs_screenshot:
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
        "timeout": 180000,
        "network_idle": False,
        "solve_cloudflare": True,
    }

    if cdp_url:
        fetch_kwargs["cdp_url"] = cdp_url
    else:
        fetch_kwargs["headless"] = True
        if proxy_url:
            fetch_kwargs["proxy"] = proxy_url

    page_action, capture_state = build_page_action("screenshot" in needs)
    fetch_kwargs["page_action"] = page_action

    sys.stderr.write(
        "scrapling fetch start "
        f"network_idle={fetch_kwargs['network_idle']} "
        f"solve_cloudflare={fetch_kwargs['solve_cloudflare']} "
        f"soft_network_idle_timeout_ms={SOFT_NETWORK_IDLE_TIMEOUT_MS} "
        f"cdp={bool(cdp_url)}\n"
    )
    sys.stderr.flush()

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
            "networkIdle": fetch_kwargs["network_idle"],
            "softNetworkIdleTimeoutMs": SOFT_NETWORK_IDLE_TIMEOUT_MS,
            "solveCloudflare": fetch_kwargs["solve_cloudflare"],
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
