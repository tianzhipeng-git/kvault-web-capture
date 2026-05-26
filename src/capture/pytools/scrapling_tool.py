import asyncio
import contextlib
import os
import sys

from common import extract_page, read_input, redirect_process_stdout_to_stderr, write_output


async def run(payload):
    try:
        from scrapling import StealthyFetcher
    except Exception as exc:
        raise RuntimeError(f"scrapling is not installed or failed to import: {exc}") from exc

    needs = set(payload.get("needs") or [])
    url = payload["url"]
    proxy_url = payload.get("proxyUrl") or None
    cdp_url = payload.get("cdpWebSocketUrl") or None
    fetch_kwargs = {
        "timeout": 120000,
        "network_idle": True,
        "solve_cloudflare": True,
    }

    if cdp_url:
        fetch_kwargs["cdp_url"] = cdp_url
        fetch = StealthyFetcher.async_fetch
    else:
        fetch_kwargs["headless"] = True
        if proxy_url:
            fetch_kwargs["proxy"] = proxy_url
        fetch = StealthyFetcher.async_fetch

    with contextlib.redirect_stdout(sys.stderr):
        response = await fetch(
            url,
            **fetch_kwargs,
        )

    html = getattr(response, "html_content", "") or getattr(response, "text", "") or ""
    final_url = getattr(response, "url", None) or url
    status_code = getattr(response, "status", None) or getattr(response, "status_code", None)
    extracted = extract_page(html, final_url)

    return {
        "toolName": "scrapling-page",
        "finalUrl": final_url,
        "statusCode": status_code,
        "html": html,
        **extracted,
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
