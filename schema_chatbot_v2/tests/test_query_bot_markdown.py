"""
FEAT-003: the Query Bot Markdown renderer (static/markdown-lite.js) escapes HTML first.
The tests run the real file under Node, so they check the code the browser loads.
"""
import shutil
import subprocess
from pathlib import Path

import pytest

RENDERER = Path(__file__).resolve().parents[1] / "static" / "markdown-lite.js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node is required to run the browser renderer")


def _node(script: str, *args: str) -> str:
    result = subprocess.run(
        [NODE, "-e", script, str(RENDERER), *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=True,
        timeout=60,
    )
    return result.stdout


def render(text: str) -> str:
    return _node("process.stdout.write(require(process.argv[1]).renderMarkdown(process.argv[2]));", text)


def test_script_tag_is_escaped_not_rendered():
    html = render("<script>alert(1)</script>")
    assert "<script" not in html.lower()
    assert "&lt;script&gt;alert(1)&lt;/script&gt;" in html


def test_img_onerror_is_escaped_not_rendered():
    html = render('<img src=x onerror="alert(1)">')
    assert "<img" not in html.lower()
    assert "&lt;img" in html
    assert 'onerror="' not in html


def test_lists_and_tables_render_as_elements():
    text = (
        "- **Bed Charges**: 30,950.00\n"
        "- Pharmacy: 42,379.25\n"
        "\n"
        "| Category | Amount |\n"
        "|---|---|\n"
        "| Bed | 30,950.00 |\n"
        "| Pharmacy returns | -1,048.00 |\n"
    )
    html = render(text)
    assert "<ul><li><strong>Bed Charges</strong>: 30,950.00</li><li>Pharmacy: 42,379.25</li></ul>" in html
    assert "<th>Category</th>" in html and "<th>Amount</th>" in html
    assert "<td>-1,048.00</td>" in html
    assert 'class="qb-table-wrap"' in html


def test_javascript_and_data_links_are_dropped_but_text_kept():
    html = render("[click me](javascript:alert(1)) and [payload](data:text/html,hi)")
    assert "href" not in html
    assert "click me" in html and "payload" in html
    assert "javascript:" not in html.lower()


def test_http_and_relative_links_are_kept():
    html = render("[site](https://example.com/a) and [page](docs/bill.pdf)")
    assert 'href="https://example.com/a"' in html
    assert 'href="docs/bill.pdf"' in html
    assert 'rel="noopener noreferrer"' in html


def test_inline_code_and_fences_are_escaped():
    html = render("Use `<b>x</b>` here.\n\n```\n<img src=x onerror=alert(1)>\n```")
    assert "<code>&lt;b&gt;x&lt;/b&gt;</code>" in html
    assert "<pre><code>&lt;img src=x onerror=alert(1)&gt;</code></pre>" in html
    assert "<img" not in html.lower()
