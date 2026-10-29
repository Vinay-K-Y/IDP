"""
process_document reports each finished page through on_page_complete, on both
the sequential path and the concurrent (ThreadPoolExecutor) path. process_page
is replaced with a stub, so no OCR engine runs.
"""
import random
import threading
import time

import pytest

import src.ai.layer1_routing.pipeline as pipeline
from src.ai.schemas.page import PageOutput


def _output(page_number: int) -> PageOutput:
    return PageOutput(
        page_number=page_number,
        markdown=f"page {page_number}",
        engines_used=["paddleocr_printed"],
        confidence=0.9,
        escalated=False,
        escalation_attempts=0,
        low_confidence=False,
    )


def _pages(n: int) -> list[dict]:
    return [
        {"page": None, "page_number": i, "context": {}, "image_bytes": b""}
        for i in range(1, n + 1)
    ]


@pytest.fixture
def fake_process_page(monkeypatch):
    def _fake(page, page_number, **kwargs):
        time.sleep(random.uniform(0, 0.005))  # let worker threads interleave
        return _output(page_number), None

    monkeypatch.setattr(pipeline, "process_page", _fake)
    return _fake


def _set_limit(monkeypatch, limit: int) -> None:
    monkeypatch.setattr(pipeline.settings, "page_concurrency_limit", limit, raising=False)


def test_sequential_path_reports_each_page_in_order(monkeypatch, fake_process_page):
    _set_limit(monkeypatch, 1)
    calls: list[int] = []

    results = pipeline.process_document(
        pages=_pages(4), llm_client=None, on_page_complete=calls.append
    )

    assert calls == [1, 2, 3, 4]
    assert [r[0].page_number for r in results] == [1, 2, 3, 4]


def test_concurrent_path_reports_every_page_exactly_once(monkeypatch, fake_process_page):
    _set_limit(monkeypatch, 25)
    calls: list[int] = []
    lock = threading.Lock()

    def _record(page_number: int) -> None:
        with lock:
            calls.append(page_number)

    results = pipeline.process_document(
        pages=_pages(8), llm_client=None, on_page_complete=_record
    )

    assert sorted(calls) == list(range(1, 9))
    assert len(calls) == len(set(calls)) == 8
    # Results keep page order even though completion order may differ.
    assert [r[0].page_number for r in results] == list(range(1, 9))


def test_raising_callback_does_not_change_results(monkeypatch, fake_process_page):
    _set_limit(monkeypatch, 1)

    def _boom(page_number: int) -> None:
        raise RuntimeError("progress bug")

    results = pipeline.process_document(
        pages=_pages(3), llm_client=None, on_page_complete=_boom
    )

    assert [r[0].markdown for r in results] == ["page 1", "page 2", "page 3"]


def test_none_callback_returns_the_same_results(monkeypatch, fake_process_page):
    _set_limit(monkeypatch, 1)

    without = pipeline.process_document(pages=_pages(3), llm_client=None)
    with_none = pipeline.process_document(
        pages=_pages(3), llm_client=None, on_page_complete=None
    )

    assert [r[0].markdown for r in without] == [r[0].markdown for r in with_none]
