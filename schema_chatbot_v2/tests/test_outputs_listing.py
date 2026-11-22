"""
Outputs lists: GET /documents (admin, all owners) and GET /me/outputs (caller only).
Each output carries job_id from the status table, or null when no status row exists,
and has_extracted from extraction_runs. Storage is a temp SQLite file.
"""
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

import app.api.pipeline_routes as pr
from app.main import app
from app.storage.user_store import Role, get_user_store


@pytest.fixture
def storage(tmp_path, monkeypatch):
    import src.ai.layer3_extraction.storage as storage_mod

    eng = create_engine(f"sqlite:///{tmp_path / 'outputs_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)
    yield storage_mod
    eng.dispose()


@pytest.fixture
def client(tmp_path, monkeypatch):
    from src.ai.layer3_extraction import s3_documents

    monkeypatch.setattr(s3_documents, "is_configured", lambda: False)
    dataset = tmp_path / "dataset"
    dataset.mkdir()
    monkeypatch.setattr(pr, "DATASET_DIR", dataset)
    return TestClient(app)


def _login(client, username: str, password: str) -> dict:
    r = client.post("/auth/login", data={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def seeded(client, storage):
    store = get_user_store()
    for name in ("out_alice", "out_bob"):
        try:
            store.create(username=name, password="password123", role=Role.USER)
        except ValueError:
            pass

    # Alice's output has a status row with a job id and an extraction run.
    storage.save_markdown_record(doc_id="a.pdf", md_filename="a.md", markdown_content="# A " * 40,
                                 owner="out_alice", page_count=1)
    storage.set_document_status("out_alice", "a.pdf", "job_alice", "completed")
    storage.save_extraction_run(doc_id="a.pdf", page_count=1, schema_name="s1",
                                result_json={"k": "v"}, owner="out_alice")

    # Bob's output has no status row, so its job id is null.
    storage.save_markdown_record(doc_id="b.pdf", md_filename="b.md", markdown_content="# B " * 40,
                                 owner="out_bob", page_count=1)

    # An admin-run output, which is the case the old _admin-only query missed.
    storage.save_markdown_record(doc_id="c.pdf", md_filename="c.md", markdown_content="# C " * 40,
                                 owner="admin", page_count=1)
    storage.set_document_status("admin", "c.pdf", "job_admin", "completed")

    return {
        "admin": _login(client, "admin", "changeme"),
        "alice": _login(client, "out_alice", "password123"),
        "bob": _login(client, "out_bob", "password123"),
    }


def test_admin_sees_every_owner_output_with_job_id(client, seeded):
    body = client.get("/documents", headers=seeded["admin"]).json()
    by_name = {o["name"]: o for o in body["outputs"]}
    assert set(by_name) == {"a.md", "b.md", "c.md"}
    assert by_name["a.md"]["owner"] == "out_alice"
    assert by_name["a.md"]["job_id"] == "job_alice"
    assert by_name["a.md"]["has_extracted"] is True
    assert by_name["c.md"]["job_id"] == "job_admin"
    assert by_name["c.md"]["has_extracted"] is False


def test_output_without_job_row_returns_null_job_id(client, seeded):
    body = client.get("/documents", headers=seeded["admin"]).json()
    b = next(o for o in body["outputs"] if o["name"] == "b.md")
    assert b["job_id"] is None
    assert b["has_extracted"] is False


def test_output_created_time_is_utc_iso(client, seeded):
    body = client.get("/documents", headers=seeded["admin"]).json()
    created = next(o for o in body["outputs"] if o["name"] == "a.md")["created_at"]
    parsed = datetime.fromisoformat(created)
    assert parsed.utcoffset() == timezone.utc.utcoffset(None)


def test_user_sees_only_own_outputs(client, seeded):
    alice = client.get("/me/outputs", headers=seeded["alice"]).json()["outputs"]
    assert [o["name"] for o in alice] == ["a.md"]
    assert alice[0]["job_id"] == "job_alice"
    assert alice[0]["owner"] == "out_alice"

    bob = client.get("/me/outputs", headers=seeded["bob"]).json()["outputs"]
    assert [o["name"] for o in bob] == ["b.md"]
    assert bob[0]["job_id"] is None


def test_user_cannot_download_another_users_output(client, seeded):
    r = client.get("/me/outputs/output/a.md", headers=seeded["bob"])
    assert r.status_code == 403


def test_outputs_require_login(client, seeded):
    assert client.get("/me/outputs").status_code == 401
