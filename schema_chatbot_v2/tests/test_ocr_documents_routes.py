"""
OCR document endpoints: admin routes in pipeline_routes.py and the caller-scoped
/me routes in user_routes.py. Storage is a temp SQLite file, so no shared
database is touched.
"""
import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.api.pipeline_routes import validate_ocr_doc_id
from app.main import app
from app.storage.user_store import Role, get_user_store


@pytest.fixture
def storage(tmp_path, monkeypatch):
    import src.ai.layer3_extraction.storage as storage_mod

    eng = create_engine(f"sqlite:///{tmp_path / 'ocr_routes_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)
    yield storage_mod
    eng.dispose()


@pytest.fixture
def client():
    return TestClient(app)


def _login(client, username: str, password: str) -> dict:
    r = client.post("/auth/login", data={"username": username, "password": password})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def seeded(client, storage):
    store = get_user_store()
    for name in ("ocr_alice", "ocr_bob"):
        try:
            store.create(username=name, password="password123", role=Role.USER)
        except ValueError:
            pass
    storage.save_markdown_record(doc_id="alice1.pdf", md_filename="alice1.md",
                                 markdown_content="# Alice\nhello", owner="ocr_alice", page_count=1)
    storage.save_markdown_record(doc_id="bob1.pdf", md_filename="bob1.md",
                                 markdown_content="# Bob", owner="ocr_bob", page_count=1)
    storage.save_markdown_record(doc_id="shared.pdf", md_filename="shared.md",
                                 markdown_content="a", owner="ocr_alice", page_count=1)
    storage.save_markdown_record(doc_id="shared.pdf", md_filename="shared.md",
                                 markdown_content="b", owner="ocr_bob", page_count=1)
    return {
        "admin": _login(client, "admin", "changeme"),
        "alice": _login(client, "ocr_alice", "password123"),
        "bob": _login(client, "ocr_bob", "password123"),
    }


# ----------------------------------------------------------------- validation

@pytest.mark.parametrize("bad", [
    "../secret.md", "..", "a/b.md", "a\\b.md", ".env", ".hidden.md",
    "evil.txt", "noext", "x.md\x00.pdf", "a" * 256 + ".md",
])
def test_validate_ocr_doc_id_rejects_traversal_and_bad_names(bad):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        validate_ocr_doc_id(bad)
    assert exc.value.status_code == 400


def test_validate_ocr_doc_id_accepts_plain_names():
    assert validate_ocr_doc_id("Atomic Habits.pdf") == "Atomic Habits.pdf"
    assert validate_ocr_doc_id("report_2026.md") == "report_2026.md"


# ------------------------------------------------------------------ admin routes

def test_admin_lists_all_owners_and_filters_by_owner(client, seeded):
    body = client.get("/documents/ocr", headers=seeded["admin"]).json()
    assert {d["owner"] for d in body["documents"]} == {"ocr_alice", "ocr_bob"}
    assert body["count"] == 4 and body["truncated"] is False

    only_alice = client.get("/documents/ocr?owner=ocr_alice", headers=seeded["admin"]).json()
    assert {d["owner"] for d in only_alice["documents"]} == {"ocr_alice"}
    assert all("markdown_content" not in d for d in only_alice["documents"])


def test_admin_fetch_and_download_one_document(client, seeded):
    r = client.get("/documents/ocr/alice1.pdf?owner=ocr_alice", headers=seeded["admin"])
    assert r.status_code == 200
    assert r.json()["markdown_content"] == "# Alice\nhello"

    dl = client.get("/documents/ocr/alice1.pdf/markdown?owner=ocr_alice", headers=seeded["admin"])
    assert dl.status_code == 200
    assert dl.headers["content-type"].startswith("text/markdown")
    assert dl.headers["content-disposition"] == 'attachment; filename="alice1.md"'
    assert dl.text == "# Alice\nhello"


def test_admin_fetch_without_owner_is_ambiguous_when_owners_share_doc_id(client, seeded):
    r = client.get("/documents/ocr/shared.pdf", headers=seeded["admin"])
    assert r.status_code == 400
    assert "ocr_alice" in r.json()["detail"] and "ocr_bob" in r.json()["detail"]
    ok = client.get("/documents/ocr/shared.pdf?owner=ocr_bob", headers=seeded["admin"])
    assert ok.status_code == 200 and ok.json()["markdown_content"] == "b"


def test_admin_missing_document_is_404(client, seeded):
    r = client.get("/documents/ocr/nope.pdf", headers=seeded["admin"])
    assert r.status_code == 404


def test_non_admin_cannot_use_admin_routes(client, seeded):
    assert client.get("/documents/ocr", headers=seeded["alice"]).status_code == 403
    assert client.get("/documents/ocr/bob1.pdf?owner=ocr_bob", headers=seeded["alice"]).status_code == 403
    assert client.get("/documents/ocr/bob1.pdf/markdown?owner=ocr_bob", headers=seeded["alice"]).status_code == 403


def test_traversal_style_ids_are_rejected_not_served(client, seeded):
    bad_ids = ["..%2Fsecret.md", "%2Eenv", "evil.txt", "a%27%3B%20DROP.md", "%2Eh.md"]
    for bad in bad_ids:
        checks = (
            (f"/documents/ocr/{bad}", seeded["admin"]),
            (f"/documents/ocr/{bad}/markdown", seeded["admin"]),
            (f"/me/ocr-documents/{bad}", seeded["alice"]),
            (f"/me/ocr-documents/{bad}/markdown", seeded["alice"]),
        )
        for path, headers in checks:
            r = client.get(path, headers=headers)
            assert r.status_code in (400, 404), (path, r.status_code)


# ------------------------------------------------------------------- user routes

def test_user_lists_only_own_documents(client, seeded):
    alice = client.get("/me/ocr-documents", headers=seeded["alice"]).json()
    assert {d["doc_id"] for d in alice["documents"]} == {"alice1.pdf", "shared.pdf"}
    assert {d["owner"] for d in alice["documents"]} == {"ocr_alice"}

    bob = client.get("/me/ocr-documents", headers=seeded["bob"]).json()
    assert {d["owner"] for d in bob["documents"]} == {"ocr_bob"}


def test_user_cannot_read_another_users_document(client, seeded):
    r = client.get("/me/ocr-documents/bob1.pdf", headers=seeded["alice"])
    assert r.status_code == 404
    dl = client.get("/me/ocr-documents/bob1.pdf/markdown", headers=seeded["alice"])
    assert dl.status_code == 404


def test_user_reads_and_downloads_own_document(client, seeded):
    r = client.get("/me/ocr-documents/alice1.pdf", headers=seeded["alice"])
    assert r.status_code == 200
    assert r.json()["markdown_content"] == "# Alice\nhello"
    dl = client.get("/me/ocr-documents/alice1.pdf/markdown", headers=seeded["alice"])
    assert dl.status_code == 200
    assert dl.headers["content-type"].startswith("text/markdown")
    assert dl.text == "# Alice\nhello"


def test_user_routes_require_login(client, seeded):
    assert client.get("/me/ocr-documents").status_code == 401
