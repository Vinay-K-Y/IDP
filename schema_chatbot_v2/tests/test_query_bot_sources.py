"""
FEAT-003: source deduplication and ordering, the "Page X" label, and the programmatic
total check on the 189,771.25 bill example (summary-page rows from output/graph_memory_8.json,
page 10).
"""
import json
import shutil
import subprocess
from decimal import Decimal
from pathlib import Path

import pytest

# pipeline_routes puts the repository root on sys.path, so `src` can be imported after it.
import app.api.pipeline_routes  # noqa: F401,E402
from src.ai.layer3_extraction.graph_agent import query_service as qs  # noqa: E402

RENDERER = Path(__file__).resolve().parents[1] / "static" / "markdown-lite.js"
NODE = shutil.which("node")

# The ten category rows on page 10 of the 189,771.25 bill, as the graph stores them.
BILL_SPANS = [
    (10, "BED CHARGES 0.00 30,950.00"),
    (10, "CARDIOLOGY 0.00 7,600.00"),
    (10, "DIETETICS 0.00 1,350.00"),
    (10, "DOCTOR FEES 0.00 17,400.00"),
    (10, "HOSPITAL SERVICES 0.00 10,120.00"),
    (10, "IMAGING 0.00 44,800.00"),
    (10, "LABMEDICINE 0.00 34,720.00"),
    (10, "MATERIALS MGMT 0.00 1,500.00"),
    (10, "PHARMACY 0.00 42,379.25"),
    (10, "PHARMACY Returns 0.00 -1,048.00"),
    (10, "Total Bill Amount 0.00 189,771.25"),
    (10, "Net Bill Amount 189,771.25"),
]


def _amounts(rows):
    return [amount for _label, amount, _page in rows]


def test_extract_rows_sums_to_stated_total_on_bill_example():
    rows = qs.extract_summary_rows(BILL_SPANS)
    stated = qs.find_stated_total(BILL_SPANS, page=10)

    assert len(rows) == 10
    assert stated == Decimal("189771.25")
    check = qs.check_itemised_total(_amounts(rows), stated)
    assert check["matched"] is True
    assert check["sum"] == "189771.25"
    assert check["stated"] == "189771.25"
    assert check["missing_amount"] == "0.00"
    assert check["missing_note"] is None


def test_total_check_flags_missing_amount_when_a_row_is_absent():
    spans = [span for span in BILL_SPANS if "PHARMACY Returns" not in span[1]]
    rows = qs.extract_summary_rows(spans)
    check = qs.check_itemised_total(_amounts(rows), qs.find_stated_total(spans, page=10))

    assert check["matched"] is False
    assert check["sum"] == "190819.25"
    assert check["missing_amount"] == "-1048.00"
    assert "190,819.25" in check["missing_note"]
    assert "not fully detailed" in check["missing_note"]


def test_total_check_reports_no_rows_explicitly():
    check = qs.check_itemised_total([], Decimal("100.00"))
    assert check["matched"] is None
    assert "not available" in check["missing_note"]


def test_subtotal_and_tax_rows_are_not_counted_as_categories():
    spans = [(10, "GST 0.00 1,200.00"), (10, "Net Payable Amount 0.00 189,771.00"), (10, "IMAGING 0.00 44,800.00")]
    rows = qs.extract_summary_rows(spans)
    assert [label for label, _a, _p in rows] == ["IMAGING"]


def test_rows_come_from_one_table_page_only():
    spans = [(1, "IMAGING 0.00 99.00"), (10, "IMAGING 0.00 44,800.00"), (10, "PHARMACY 0.00 42,379.25")]
    rows = qs.extract_summary_rows(spans)
    assert {page for _l, _a, page in rows} == {10}
    assert [str(a) for a in _amounts(rows)] == ["44800.00", "42379.25"]


def test_dedupe_sources_keeps_one_per_page_sorted_by_page():
    sources = [
        {"page": 3, "evidence": "later snippet"},
        {"page": 1, "evidence": "first page"},
        {"page": 3, "evidence": "same page again"},
        {"page": None, "evidence": "no page"},
    ]
    out = qs.dedupe_sources_by_page(sources)
    assert [s["page"] for s in out] == [1, 3]
    assert out[1]["evidence"] == "later snippet"


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


@pytest.mark.skipif(NODE is None, reason="node is required to run the browser helpers")
def test_client_source_helpers_dedupe_sort_and_label():
    sources = [{"page": 3, "evidence": "b"}, {"page": 1, "evidence": "a"}, {"page": 3, "evidence": "c"}]
    script = (
        "const r = require(process.argv[1]);"
        "const out = r.dedupeSources(JSON.parse(process.argv[2]));"
        "process.stdout.write(JSON.stringify({labels: out.map(r.sourceLabel), evidence: out.map(s => s.evidence)}));"
    )
    result = json.loads(_node(script, json.dumps(sources)))
    assert result["labels"] == ["Page 1", "Page 3"]
    assert result["evidence"] == ["a", "b"]
