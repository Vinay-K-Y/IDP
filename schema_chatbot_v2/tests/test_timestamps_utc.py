"""
to_utc_iso: stored datetimes are written as UTC. Naive values carry no offset,
so they are tagged as UTC. Aware values keep their instant.
"""
from datetime import datetime, timedelta, timezone

# pipeline_routes puts the repository root on sys.path, so `src` can be imported after it.
import app.api.pipeline_routes  # noqa: F401,E402
from src.ai.layer3_extraction.storage import to_utc_iso  # noqa: E402


def test_naive_datetime_is_tagged_utc():
    out = to_utc_iso(datetime(2026, 10, 29, 8, 54, 8))
    assert out == "2026-10-29T08:54:08+00:00"
    assert out.endswith("+00:00")


def test_aware_datetime_keeps_the_same_instant():
    ist = timezone(timedelta(hours=5, minutes=30))
    local = datetime(2026, 10, 29, 14, 24, 8, tzinfo=ist)
    out = to_utc_iso(local)
    assert out == "2026-10-29T08:54:08+00:00"
    assert datetime.fromisoformat(out) == local


def test_utc_aware_datetime_is_unchanged():
    value = datetime(2026, 10, 29, 8, 54, 8, tzinfo=timezone.utc)
    assert to_utc_iso(value) == "2026-10-29T08:54:08+00:00"


def test_none_stays_none():
    assert to_utc_iso(None) is None


def test_output_timestamps_from_storage_are_utc(tmp_path, monkeypatch):
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker

    import src.ai.layer3_extraction.storage as storage_mod

    eng = create_engine(f"sqlite:///{tmp_path / 'ts_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)
    try:
        storage_mod.save_markdown_record(doc_id="t.pdf", md_filename="t.md", markdown_content="x" * 200,
                                         owner="ts_owner", page_count=1)
        rows = storage_mod.list_markdown_records("ts_owner")
        assert rows and rows[0]["modified"].endswith("+00:00")
        ocr = storage_mod.list_ocr_document_summaries(owner="ts_owner")
        assert ocr and ocr[0]["created_at"].endswith("+00:00")
    finally:
        eng.dispose()
