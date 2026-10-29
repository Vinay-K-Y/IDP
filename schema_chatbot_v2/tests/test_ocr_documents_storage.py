"""
Storage helpers for OCR'd documents (document_markdowns). Runs against a temp
SQLite file: the module-level engine is swapped for the test, so no shared
database is touched.
"""
from pathlib import Path

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker


@pytest.fixture
def storage(tmp_path, monkeypatch):
    import src.ai.layer3_extraction.storage as storage_mod

    eng = create_engine(f"sqlite:///{tmp_path / 'ocr_docs_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)
    yield storage_mod
    eng.dispose()


def _save_md(storage, owner: str, doc_id: str, text: str) -> None:
    rec_id = storage.save_markdown_record(
        doc_id=doc_id,
        md_filename=f"{Path(doc_id).stem}.md",
        markdown_content=text,
        owner=owner,
        schema_id="schema_s",
        page_count=2,
    )
    assert rec_id is not None


def test_list_summaries_filters_by_owner_and_reports_graph_flag(storage):
    _save_md(storage, "alice", "alice1.pdf", "alpha text")
    _save_md(storage, "bob", "bob1.pdf", "bravo")
    _save_md(storage, "bob", "bob2.pdf", "charlie charlie")
    storage.save_document_graph(
        doc_id="alice1.pdf", graph_dict={"nodes": [], "edges": []},
        job_id="job_x", owner="alice", schema_id="schema_s", strategy="graph_memory_concurrent",
    )

    alice = storage.list_ocr_document_summaries(owner="alice")
    assert [d["doc_id"] for d in alice] == ["alice1.pdf"]
    assert alice[0]["has_graph"] is True
    assert alice[0]["has_extraction"] is False
    assert alice[0]["size_chars"] == len("alpha text")
    assert alice[0]["md_filename"] == "alice1.md"
    assert alice[0]["page_count"] == 2
    assert "markdown_content" not in alice[0]

    everyone = storage.list_ocr_document_summaries(owner=None)
    assert {d["owner"] for d in everyone} == {"alice", "bob"}
    assert len(everyone) == 3

    bob = storage.list_ocr_document_summaries(owner="bob")
    assert {d["doc_id"] for d in bob} == {"bob1.pdf", "bob2.pdf"}
    assert all(d["has_graph"] is False for d in bob)

    assert len(storage.list_ocr_document_summaries(owner="bob", limit=1)) == 1


def test_get_records_returns_markdown_and_every_owner_match(storage):
    _save_md(storage, "alice", "shared.pdf", "from alice")
    _save_md(storage, "bob", "shared.pdf", "from bob")

    both = storage.get_ocr_document_records("shared.pdf")
    assert {r["owner"] for r in both} == {"alice", "bob"}

    only_bob = storage.get_ocr_document_records("shared.pdf", owner="bob")
    assert len(only_bob) == 1
    assert only_bob[0]["markdown_content"] == "from bob"
    assert storage.get_ocr_document_records("shared.pdf", owner="carol") == []
