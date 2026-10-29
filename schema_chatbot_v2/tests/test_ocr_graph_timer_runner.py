"""
Runs the real _run_pipeline_job against a temp SQLite database. OCR, the LLM
and the graph extractor are stubbed with fixed sleeps, so the per-document
timings can be checked against known durations. The DB writes
(markdown record, graph snapshot) go to the temp file.
"""
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock
import time

import pymupdf
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

OCR_S = 0.3
GRAPH_S = 0.5


@pytest.fixture
def runner(tmp_path, monkeypatch):
    import src.ai.layer3_extraction.storage as storage_mod
    from app.api import pipeline_routes as pr
    JobControl = pr.JobControl
    import src.ai.layer3_extraction.extractor as extractor_mod
    import src.ai.layer3_extraction.schema_validation as sv_mod
    import src.adapters.llm.factory as llm_factory
    import src.adapters.llm.extraction_factory as ext_factory

    eng = create_engine(f"sqlite:///{tmp_path / 'runner_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)

    out_dir = tmp_path / "out"
    monkeypatch.setattr(pr, "OUTPUT_DIR", out_dir)
    monkeypatch.setattr(pr, "DATASET_DIR", tmp_path / "dataset")
    monkeypatch.setattr(pr, "resolve_owner_output_dir", lambda owner: out_dir / owner)
    monkeypatch.setattr(pr, "_build_pages_for_pdf", lambda pdf, pdf_bytes=None: [{"page_number": 1}])
    monkeypatch.setattr(pr, "save_page_irs", lambda **kw: None)

    def fake_process_document(pages, llm_client, document_name, output_dir, **kw):
        time.sleep(OCR_S)
        stem = Path(document_name).stem
        Path(output_dir, f"{stem}.md").write_text("OCR text. " * 20, encoding="utf-8")
        page = SimpleNamespace(
            markdown="OCR text. " * 20, page_number=1, confidence=0.9,
            engines_used=["paddleocr_printed"], capabilities=["has_printed_scan"],
            escalated=False, low_confidence=False, blocks=[],
        )
        return [(page, {})]

    def fake_extract_document(pages, schema, llm, strategy=None, graph_out=None, owner=None):
        time.sleep(GRAPH_S)
        if graph_out is not None and str(strategy).startswith("graph_memory"):
            graph_out["snapshot"] = {"nodes": [{"id": "n1"}], "edges": []}
            graph_out["stats"] = {"nodes": 1}
        return SimpleNamespace(model_dump=lambda: {"f": "value"})

    monkeypatch.setattr(pr, "process_document", fake_process_document)
    monkeypatch.setattr(llm_factory, "get_llm_client", lambda: MagicMock())
    monkeypatch.setattr(ext_factory, "get_extraction_client", lambda: MagicMock())
    monkeypatch.setattr(extractor_mod, "extract_document", fake_extract_document)
    monkeypatch.setattr(sv_mod, "extract_with_retry", lambda fn, schema: fn())

    def run(strategy: str, owner: str, pdf_name: str):
        pdf = tmp_path / pdf_name
        doc = pymupdf.open()
        doc.new_page()
        doc.save(str(pdf))
        doc.close()
        job_id = f"job_{Path(pdf_name).stem}_{strategy}"
        pr._pipeline_jobs[job_id] = {
            "job_id": job_id, "status": "queued", "targets": [pdf_name],
            "successes": [], "failures": [], "created_at": datetime.now().astimezone().isoformat(),
        }
        pr._job_controls[job_id] = JobControl()
        schema_record = {
            "schema_id": "schema_t", "document_type": "t",
            "schema": {"fields": [{"name": "f", "description": ""}]},
        }
        pr._run_pipeline_job(job_id, [pdf], tmp_path / "schema.json", schema_record,
                             strategy=strategy, owner=owner)
        return pr._pipeline_jobs[job_id], storage_mod

    yield run
    pr._pipeline_jobs.clear()
    pr._job_controls.clear()
    eng.dispose()


def _ts(value):
    return datetime.fromisoformat(value)


def test_graph_job_splits_ocr_and_graph_timers(runner):
    job, storage = runner("graph_memory_concurrent", "alice", "alice_notes.pdf")

    assert job["failures"] == []
    assert len(job["successes"]) == 1
    s = job["successes"][0]
    assert OCR_S * 0.8 <= s["ocr_elapsed_s"] <= OCR_S + 0.5
    assert GRAPH_S * 0.8 <= s["graph_elapsed_s"] <= GRAPH_S + 0.5

    # OCR ends before the graph build starts, so the timers do not overlap.
    assert _ts(s["ocr_finished_at"]) <= _ts(s["graph_started_at"])
    assert _ts(s["graph_finished_at"]) >= _ts(s["graph_started_at"])

    assert s["md_db_saved"] is True
    rows = storage.get_ocr_document_records("alice_notes.pdf", owner="alice")
    assert len(rows) == 1 and len(rows[0]["markdown_content"]) > 100
    assert [g["doc_id"] for g in storage.list_document_graphs(owner="alice")] == ["alice_notes.pdf"]


def test_page_scan_job_has_no_graph_time(runner):
    job, _storage = runner("page_scan", "alice", "alice_scan.pdf")

    assert job["failures"] == []
    s = job["successes"][0]
    assert s["graph_elapsed_s"] == 0
    assert s["graph_started_at"] is None
    assert s["ocr_elapsed_s"] > 0
