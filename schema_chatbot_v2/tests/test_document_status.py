"""
Document processing status: runner transitions, the kill endpoint,
the admin and user listings, and the backfill. Storage is a temp SQLite file,
so no shared database is touched.
"""
from datetime import datetime, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api import pipeline_routes as pr
from app.main import app
from app.storage.user_store import Role, get_user_store


@pytest.fixture
def storage(tmp_path, monkeypatch):
    import src.ai.layer3_extraction.storage as storage_mod

    eng = create_engine(f"sqlite:///{tmp_path / 'status_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)
    yield storage_mod
    eng.dispose()


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def jobs():
    yield pr._pipeline_jobs
    pr._pipeline_jobs.clear()
    pr._job_controls.clear()


@pytest.fixture
def no_s3(monkeypatch):
    from src.ai.layer3_extraction import s3_documents

    monkeypatch.setattr(s3_documents, "is_configured", lambda: False)


def _login(client, username: str, password: str) -> dict:
    r = client.post("/auth/login", data={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def users(client):
    store = get_user_store()
    try:
        store.create(username="status_alice", password="password123", role=Role.USER)
    except ValueError:
        pass
    return {
        "admin": _login(client, "admin", "changeme"),
        "alice": _login(client, "status_alice", "password123"),
    }


def _add_job(job_id: str, owner: str, status: str = "running", current: str | None = None) -> None:
    pr._pipeline_jobs[job_id] = {
        "job_id": job_id,
        "status": status,
        "created_at": "2026-10-29T08:00:00+00:00",
        "schema_id": "s1",
        "schema_file": "s1.json",
        "strategy": "graph_memory_concurrent",
        "targets": ["doc.pdf"],
        "successes": [],
        "failures": [],
        "started_at": None,
        "finished_at": None,
        "wall_time_s": None,
        "owner": owner,
        "current_document": current,
    }
    pr._job_controls[job_id] = pr.JobControl()
    pr._job_controls[job_id].progress.attach(pr._pipeline_jobs[job_id])


def _run_job(monkeypatch, tmp_path, owner: str, pdf_name: str, job_id: str, fail: bool = False, seen=None):
    """Run the real runner with OCR and LLM stubbed out. seen collects statuses read mid-run."""
    import src.ai.layer3_extraction.storage as storage_mod

    monkeypatch.setattr(pr, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(pr, "_build_pages_for_pdf", lambda pdf, pdf_bytes=None: [])
    monkeypatch.setattr("src.adapters.llm.factory.get_llm_client", lambda: pr.MockLLMClient())

    def fake_process(**kwargs):
        if seen is not None:
            seen.append(storage_mod.get_document_statuses(owner, doc_ids=[pdf_name])[(owner, pdf_name)]["status"])
        if fail:
            raise RuntimeError("ocr exploded")
        return []

    monkeypatch.setattr(pr, "process_document", fake_process)
    schema_record = {"schema_id": "s1", "document_type": "invoice", "schema": {"fields": []}}
    _add_job(job_id, owner, status="queued")
    pr._run_pipeline_job(job_id, [Path(pdf_name)], Path("s1.json"), schema_record, "graph_memory_concurrent", owner)


# ----------------------------------------------------------------- storage layer

def test_set_document_status_rejects_unknown_status(storage):
    with pytest.raises(ValueError):
        storage.set_document_status("admin", "a.pdf", "job_x", "done")


def test_set_document_status_upserts_one_row_per_owner_and_doc(storage):
    storage.set_document_status("admin", "a.pdf", "job_1", "processing")
    storage.set_document_status("admin", "a.pdf", "job_1", "completed")
    statuses = storage.get_document_statuses("admin", doc_ids=["a.pdf"])
    assert statuses[("admin", "a.pdf")]["status"] == "completed"
    assert statuses[("admin", "a.pdf")]["job_id"] == "job_1"


def test_markdown_row_without_status_reads_as_completed(storage):
    storage.save_markdown_record(doc_id="old.pdf", md_filename="old.md", markdown_content="x" * 200,
                                 owner="admin", page_count=1)
    statuses = storage.get_document_statuses("*", doc_ids=["old.pdf"])
    assert statuses[("admin", "old.pdf")]["status"] == "completed"
    assert statuses[("admin", "old.pdf")]["job_id"] is None


def test_owner_filter_keeps_other_owners_out(storage):
    storage.set_document_status("ocr_alice", "a.pdf", "job_a", "failed", error="boom")
    storage.set_document_status("ocr_bob", "a.pdf", "job_b", "completed")
    alice = storage.get_document_statuses("ocr_alice")
    assert set(alice) == {("ocr_alice", "a.pdf")}
    assert alice[("ocr_alice", "a.pdf")]["error"] == "boom"


def test_legacy_paused_row_reads_as_cancelled(storage):
    """Rows written before pause was removed still hold 'paused'. Reads must not crash or expose it."""
    import src.ai.layer3_extraction.storage as storage_mod

    with storage_mod.SessionLocal() as session:
        session.add(storage_mod.DocumentProcessingStatus(
            owner="admin", doc_id="legacy.pdf", job_id="job_old", status="paused", error=None,
            updated_at=datetime.now(timezone.utc),
        ))
        session.commit()
    st = storage.get_document_statuses("admin", doc_ids=["legacy.pdf"])[("admin", "legacy.pdf")]
    assert st["status"] == "cancelled"
    assert st["job_id"] == "job_old"


# ----------------------------------------------------------------- runner transitions

def test_runner_marks_processing_then_completed(storage, jobs, monkeypatch, tmp_path, no_s3):
    seen: list = []
    _run_job(monkeypatch, tmp_path, "admin", "a.pdf", "job_ok", seen=seen)
    assert seen == ["processing"]
    st = storage.get_document_statuses("admin", doc_ids=["a.pdf"])[("admin", "a.pdf")]
    assert st["status"] == "completed"
    assert st["job_id"] == "job_ok"
    assert st["error"] is None


def test_runner_marks_failed_with_error(storage, jobs, monkeypatch, tmp_path, no_s3):
    _run_job(monkeypatch, tmp_path, "admin", "b.pdf", "job_bad", fail=True)
    st = storage.get_document_statuses("admin", doc_ids=["b.pdf"])[("admin", "b.pdf")]
    assert st["status"] == "failed"
    assert "ocr exploded" in st["error"]


def test_kill_during_document_keeps_cancelled_status(storage, jobs, client, users, monkeypatch, tmp_path, no_s3):
    """The kill endpoint writes 'cancelled' while the document runs. The runner must not overwrite it when the document ends."""
    job_id = "job_kill_mid_doc"
    monkeypatch.setattr(pr, "OUTPUT_DIR", tmp_path / "out")
    monkeypatch.setattr(pr, "_build_pages_for_pdf", lambda pdf, pdf_bytes=None: [])
    monkeypatch.setattr("src.adapters.llm.factory.get_llm_client", lambda: pr.MockLLMClient())

    def kill_then_finish(**kwargs):
        resp = client.post(f"/pipeline/jobs/{job_id}/kill", headers=users["admin"])
        assert resp.status_code == 200, resp.text
        return []

    monkeypatch.setattr(pr, "process_document", kill_then_finish)
    schema_record = {"schema_id": "s1", "document_type": "invoice", "schema": {"fields": []}}
    _add_job(job_id, "admin", status="queued")
    pr._run_pipeline_job(job_id, [Path("k.pdf")], Path("s1.json"), schema_record, "graph_memory_concurrent", "admin")

    assert pr._pipeline_jobs[job_id]["status"] == "killed"
    st = storage.get_document_statuses("admin", doc_ids=["k.pdf"])[("admin", "k.pdf")]
    assert st["status"] == "cancelled"


# ----------------------------------------------------------------- kill

def test_admin_kill_writes_document_status(storage, jobs, client, users):
    _add_job("job_admin_ctl", "admin", status="running", current="c.pdf")
    h = users["admin"]

    assert client.post("/pipeline/jobs/job_admin_ctl/kill", headers=h).status_code == 200
    st = storage.get_document_statuses("admin", doc_ids=["c.pdf"])[("admin", "c.pdf")]
    assert st["status"] == "cancelled"
    assert st["job_id"] == "job_admin_ctl"


def test_user_kill_writes_document_status(storage, jobs, client, users):
    _add_job("job_user_ctl", "status_alice", status="running", current="mine.pdf")
    h = users["alice"]
    assert client.post("/me/pipeline/jobs/job_user_ctl/kill", headers=h).status_code == 200
    assert storage.get_document_statuses("status_alice", doc_ids=["mine.pdf"])[("status_alice", "mine.pdf")]["status"] == "cancelled"


# ----------------------------------------------------------------- listings

def test_admin_list_shows_admin_run_document_as_completed(storage, jobs, client, users, monkeypatch, tmp_path, no_s3):
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    (dataset / "shared.pdf").write_bytes(b"%PDF-1.4 stub")
    monkeypatch.setattr(pr, "DATASET_DIR", dataset)

    _run_job(monkeypatch, tmp_path, "admin", "shared.pdf", "job_admin_list")

    body = client.get("/documents", headers=users["admin"]).json()
    doc = next(d for d in body["documents"] if d["name"] == "shared.pdf")
    assert doc["status"] == "completed"
    assert doc["has_output"] is True
    assert doc["job_id"] == "job_admin_list"
    out = next(o for o in body["outputs"] if o["name"] == "shared.md")
    assert out["owner"] == "admin"
    assert out["job_id"] == "job_admin_list"


def test_admin_list_pending_when_nothing_processed(storage, jobs, client, users, monkeypatch, tmp_path, no_s3):
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    (dataset / "fresh.pdf").write_bytes(b"%PDF-1.4 stub")
    monkeypatch.setattr(pr, "DATASET_DIR", dataset)
    body = client.get("/documents", headers=users["admin"]).json()
    doc = next(d for d in body["documents"] if d["name"] == "fresh.pdf")
    assert doc["status"] == "pending"
    assert doc["has_output"] is False


def test_user_documents_carry_status(storage, jobs, client, users, monkeypatch, tmp_path, no_s3):
    import app.api.user_routes as ur

    storage.set_document_status("status_alice", "mine.pdf", "job_m", "processing")
    user_dir = tmp_path / "users" / "documents"
    user_dir.mkdir(parents=True)
    (user_dir / "mine.pdf").write_bytes(b"%PDF-1.4 stub")
    monkeypatch.setattr(ur, "_user_docs_dir", lambda username: user_dir)

    body = client.get("/me/documents", headers=users["alice"]).json()
    assert body["documents"][0]["name"] == "mine.pdf"
    assert body["documents"][0]["status"] == "processing"
    assert body["documents"][0]["job_id"] == "job_m"


# ----------------------------------------------------------------- backfill

def test_backfill_inserts_once_and_is_idempotent(storage, capsys):
    storage.save_markdown_record(doc_id="seeded.pdf", md_filename="seeded.md", markdown_content="x" * 200,
                                 owner="admin", page_count=1)
    storage.save_extraction_run(doc_id="seeded.pdf", page_count=1, schema_name="s1",
                                result_json={"a": 1}, owner="admin")
    storage.set_document_status("admin", "tracked.pdf", "job_t", "failed", error="x")
    storage.save_markdown_record(doc_id="tracked.pdf", md_filename="tracked.md", markdown_content="x" * 200,
                                 owner="admin", page_count=1)

    assert storage.backfill_document_status() == 1
    assert storage.backfill_document_status() == 0

    st = storage.get_document_statuses("admin", doc_ids=["seeded.pdf"])[("admin", "seeded.pdf")]
    assert st["status"] == "completed"
    # The existing failed row is never overwritten by the backfill.
    assert storage.get_document_statuses("admin", doc_ids=["tracked.pdf"])[("admin", "tracked.pdf")]["status"] == "failed"


def test_backfill_cli_prints_url_before_writing(storage, capsys):
    storage.save_markdown_record(doc_id="cli.pdf", md_filename="cli.md", markdown_content="x" * 200,
                                 owner="admin", page_count=1)
    assert storage._main(["backfill-status"]) == 0
    out = capsys.readouterr().out.splitlines()
    assert out[0].startswith("database: ")
    assert out[1] == "backfill-status: inserted 1 row(s)"
