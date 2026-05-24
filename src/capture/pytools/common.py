import json
import os
import re
import sys
from html.parser import HTMLParser
from urllib.parse import urljoin


class PageTextParser(HTMLParser):
    def __init__(self, base_url):
        super().__init__(convert_charrefs=True)
        self.base_url = base_url
        self.title_parts = []
        self.meta_description = ""
        self.body_parts = []
        self.links = []
        self._in_title = False
        self._skip_depth = 0

    def handle_starttag(self, tag, attrs):
        attrs_dict = dict(attrs)
        if tag in ("script", "style", "noscript", "svg"):
            self._skip_depth += 1
        if tag == "title":
            self._in_title = True
        if tag == "meta":
            name = (attrs_dict.get("name") or attrs_dict.get("property") or "").lower()
            if name in ("description", "og:description"):
                self.meta_description = attrs_dict.get("content", "") or self.meta_description
        if tag == "a" and attrs_dict.get("href"):
            self.links.append(urljoin(self.base_url, attrs_dict["href"]))

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript", "svg") and self._skip_depth > 0:
            self._skip_depth -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title_parts.append(text)
        elif self._skip_depth == 0:
            self.body_parts.append(text)


def extract_page(html, final_url):
    parser = PageTextParser(final_url)
    parser.feed(html or "")
    body_text = re.sub(r"\s+", " ", " ".join(parser.body_parts)).strip()
    title = re.sub(r"\s+", " ", " ".join(parser.title_parts)).strip()
    links = list(dict.fromkeys(parser.links))
    return {
        "title": title,
        "metaDescription": parser.meta_description.strip(),
        "bodyText": body_text,
        "links": links,
    }


def read_input():
    try:
        return json.loads(sys.stdin.read())
    except Exception as exc:
        raise RuntimeError(f"invalid bridge input JSON: {exc}") from exc


def redirect_process_stdout_to_stderr():
    original_stdout_fd = os.dup(1)
    os.dup2(2, 1)
    return original_stdout_fd


def write_output(payload, output_fd=None):
    content = json.dumps(payload, ensure_ascii=False)
    if output_fd is None:
        sys.stdout.write(content)
        return
    try:
        os.write(output_fd, content.encode("utf-8"))
    finally:
        os.close(output_fd)
