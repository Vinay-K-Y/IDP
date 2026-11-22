"""
Routing check for a scanned page with no text layer (the page 33 signature from
the report: is_scanned=True, char_count=0, image_coverage=1.0,
primary_script=unknown). The page must reach printed OCR in both routing modes.

Only the page inspection and the OCR call are replaced. The routing decisions
are the real functions in src/ai/layer1_routing.
"""
from unittest.mock import MagicMock

import pytest

# pipeline_routes puts the repository root on sys.path, so `src` can be imported after it.
import app.api.pipeline_routes  # noqa: F401,E402
from src.ai.layer1_routing import pipeline  # noqa: E402
from src.ai.layer1_routing.router import (
    build_engine_plan,
    capabilities_from_profile,
    route_from_profile,
)
from src.ai.schemas.page import PageProfile
from src.config.settings import settings

PAGE_33 = PageProfile(
    page_number=33,
    has_text=False,
    char_count=0,
    image_coverage=1.0,
    has_tables=False,
    is_scanned=True,
    has_vector_drawings=False,
    primary_script="unknown",
    complexity_score=0,
    dpi_estimate=150,
)


def test_step_a_does_not_claim_page_33_so_the_scanned_default_applies():
    # route_from_profile returns None for this page. process_page then picks 'scanned' because is_scanned is set.
    assert route_from_profile(PAGE_33) is None


def test_capability_plan_for_page_33_includes_printed_ocr_and_not_skip_or_docling():
    plan = [t.engine for t in build_engine_plan(capabilities_from_profile(PAGE_33))]
    assert "paddleocr_printed" in plan
    assert "docling" not in plan
    assert "skip" not in plan


@pytest.fixture
def stubbed_page(monkeypatch):
    """Replace page inspection and the OCR call. Record the plan that process_page runs."""
    monkeypatch.setattr(pipeline, "inspect_page", lambda page, page_number: PAGE_33)
    monkeypatch.setattr(pipeline, "_probe_enabled", lambda: False)
    calls = {"plans": []}

    def fake_run_plan(plan, page_context, llm_client):
        calls["plans"].append([t.engine for t in plan])
        return [(t, f"text from {t.engine}", 0.9, 1.0, []) for t in plan]

    monkeypatch.setattr(pipeline, "_run_plan", fake_run_plan)
    return calls


def _run(stages=None):
    def on_stage(page_number, stage):
        if stages is not None:
            stages.append((page_number, stage))

    return pipeline.process_page(
        page=None,
        page_number=33,
        page_context={},
        llm_client=MagicMock(),
        page_image_bytes=b"",
        document_name="doc.pdf",
        document_id="doc-33",
        on_stage=on_stage,
    )


def test_page_33_goes_to_printed_ocr_in_single_engine_mode(monkeypatch, stubbed_page):
    monkeypatch.setattr(settings, "routing_mode", "single_engine")
    stages = []
    output, _metadata = _run(stages)

    assert stubbed_page["plans"] == [["paddleocr_printed"]]
    assert output.engines_used == ["paddleocr_printed"]
    assert output.markdown == "text from paddleocr_printed"
    assert [s for _n, s in stages] == ["inspect_done", "route_done", "ocr_start"]


def test_page_33_goes_to_printed_ocr_in_capability_mode(monkeypatch, stubbed_page):
    monkeypatch.setattr(settings, "routing_mode", "capability_based")
    output, _metadata = _run()

    planned = stubbed_page["plans"][0]
    assert "paddleocr_printed" in planned
    assert "skip" not in planned
    assert "paddleocr_printed" in output.engines_used
