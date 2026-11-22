"""
Active graph build: the query bot uses the newest non-empty build of a document unless an admin
chooses another one. Empty (0-node) builds are never used. Storage rules and the admin endpoints
are tested here, end to end through the FastAPI app. No LLM or AWS call is made.
"""
import pytest
from tests.query_bot_fixtures import (  # noqa: F401  (fixtures are used by name)
    build_bill_graph,
    login,
    parse_sse,
    qb_client,
    qb_storage,
    stub_llm,
)

EMPTY_GRAPH = {"nodes": [], "edges": []}


@pytest.fixture
def admin_headers(qb_client):
    from app.storage.user_store import Role, get_user_store
    try:
        get_user_store().create(username="qb_admin", password="password123", role=Role.ADMIN)
    except ValueError:
        pass
    return login(qb_client, "qb_admin", "password123")


def _save(qb_storage, job_id, graph=None, owner="qb_alice", doc_id="bill.pdf"):
    qb_storage.save_document_graph(
        doc_id=doc_id,
        graph_dict=graph if graph is not None else build_bill_graph(),
        job_id=job_id,
        owner=owner,
    )


def _seed_default(qb_storage):
    """Oldest non-empty, then newer non-empty, then the newest build which is empty."""
    _save(qb_storage, "job_old")
    _save(qb_storage, "job_new")
    _save(qb_storage, "job_empty", graph=EMPTY_GRAPH)


def _user_job_id(qb_client, headers, doc_id="bill.pdf"):
    resp = qb_client.get("/api/query-bot/documents", headers=headers)
    assert resp.status_code == 200
    doc = next(d for d in resp.json()["documents"] if d["doc_id"] == doc_id)
    return doc["job_id"]


def _admin_group(qb_client, headers, doc_id="bill.pdf", owner="qb_alice"):
    resp = qb_client.get("/admin/query-bot/documents", headers=headers)
    assert resp.status_code == 200, resp.text
    return next(d for d in resp.json()["documents"] if d["doc_id"] == doc_id and d["owner"] == owner)


# ----------------------------------------------------------------- storage rules

def test_select_skips_newest_empty_build(qb_storage):
    _save(qb_storage, "job_old")
    _save(qb_storage, "job_empty", graph=EMPTY_GRAPH)
    rows = qb_storage.SessionLocal().query(qb_storage.DocumentGraphRecord).all()
    session = qb_storage.SessionLocal()
    row, only_empty = qb_storage.select_active_graph_row(session, rows, "bill.pdf")
    assert row.job_id == "job_old"
    assert only_empty is False


def test_select_default_is_newest_non_empty(qb_storage):
    _save(qb_storage, "job_old")
    _save(qb_storage, "job_new")
    session = qb_storage.SessionLocal()
    rows = session.query(qb_storage.DocumentGraphRecord).all()
    row, _ = qb_storage.select_active_graph_row(session, rows, "bill.pdf")
    assert row.job_id == "job_new"


def test_select_admin_choice_overrides_default(qb_storage):
    _save(qb_storage, "job_old")
    _save(qb_storage, "job_new")
    session = qb_storage.SessionLocal()
    qb_storage.set_active_choice(session, "bill.pdf", "qb_alice", "job_old", "qb_admin")
    rows = session.query(qb_storage.DocumentGraphRecord).all()
    row, _ = qb_storage.select_active_graph_row(session, rows, "bill.pdf")
    assert row.job_id == "job_old"


def test_select_only_empty_builds(qb_storage):
    _save(qb_storage, "job_empty", graph=EMPTY_GRAPH)
    session = qb_storage.SessionLocal()
    rows = session.query(qb_storage.DocumentGraphRecord).all()
    assert qb_storage.select_active_graph_row(session, rows, "bill.pdf") == (None, True)


def test_set_active_choice_updates_single_row(qb_storage):
    session = qb_storage.SessionLocal()
    qb_storage.set_active_choice(session, "bill.pdf", "qb_alice", "job_a", "qb_admin")
    qb_storage.set_active_choice(session, "bill.pdf", "qb_alice", "job_b", "qb_admin")
    rows = session.query(qb_storage.DocumentActiveGraphRecord).all()
    assert len(rows) == 1
    assert rows[0].job_id == "job_b"


def test_save_empty_graph_logs_warning_and_still_saves(qb_storage, monkeypatch):
    events = []

    class _Log:
        def warning(self, event, **kwargs):
            events.append(event)

        def __getattr__(self, name):
            return lambda *a, **k: None

    monkeypatch.setattr(qb_storage, "logger", _Log())
    rec_id = qb_storage.save_document_graph(doc_id="bill.pdf", graph_dict=EMPTY_GRAPH, job_id="job_empty", owner="qb_alice")
    assert rec_id is not None
    assert events == ["storage.graph_saved_empty"]


# ----------------------------------------------------------------- query bot and admin endpoints

def test_default_build_for_user_and_admin_skips_empty(qb_client, qb_storage, admin_headers):
    _seed_default(qb_storage)
    alice = login(qb_client, "qb_alice", "password123")
    assert _user_job_id(qb_client, alice) == "job_new"
    group = _admin_group(qb_client, admin_headers)
    assert group["in_use_job_id"] == "job_new"
    assert group["active_job_id"] is None
    assert group["empty_build_count"] == 1
    empty = next(b for b in group["builds"] if b["job_id"] == "job_empty")
    assert empty["is_empty"] is True
    assert empty["selectable"] is False


def test_empty_only_document_is_listed_as_graph_empty(qb_client, qb_storage):
    _save(qb_storage, "job_empty", graph=EMPTY_GRAPH, doc_id="empty.pdf")
    alice = login(qb_client, "qb_alice", "password123")
    resp = qb_client.get("/api/query-bot/documents", headers=alice)
    assert resp.status_code == 200
    doc = next(d for d in resp.json()["documents"] if d["doc_id"] == "empty.pdf")
    assert doc["graph_empty"] is True
    assert doc["job_id"] is None
    assert doc["graph"] is None


def test_admin_set_active_changes_list_and_answer(qb_client, qb_storage, admin_headers):
    _seed_default(qb_storage)
    resp = qb_client.put(
        "/admin/query-bot/active-build",
        headers=admin_headers,
        json={"doc_id": "bill.pdf", "owner": "qb_alice", "job_id": "job_old"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["active_job_id"] == "job_old"
    assert resp.json()["in_use_job_id"] == "job_old"

    alice = login(qb_client, "qb_alice", "password123")
    assert _user_job_id(qb_client, alice) == "job_old"
    ask = qb_client.post("/api/query-bot/ask", headers=alice, json={"question": "What is the patient name?", "doc_id": "bill.pdf"})
    assert ask.status_code == 200
    assert ask.json()["mode"] == "graph"
    assert ask.json()["graph_job_id"] == "job_old"


def test_admin_job_id_without_owner_stays_in_build_owner(qb_client, qb_storage, admin_headers):
    _save(qb_storage, "job_alice", owner="qb_alice")
    _save(qb_storage, "job_bob", owner="qb_bob")
    resp = qb_client.post(
        "/api/query-bot/ask",
        headers=admin_headers,
        json={"question": "What is the patient name?", "doc_id": "bill.pdf", "job_id": "job_alice"},
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["graph_job_id"] == "job_alice"


def test_set_active_rejects_empty_foreign_and_unknown_builds(qb_client, qb_storage, admin_headers):
    _seed_default(qb_storage)
    _save(qb_storage, "job_other", doc_id="other.pdf")

    def put(job_id, doc_id="bill.pdf"):
        return qb_client.put(
            "/admin/query-bot/active-build",
            headers=admin_headers,
            json={"doc_id": doc_id, "owner": "qb_alice", "job_id": job_id},
        )

    assert put("job_empty").status_code == 400
    assert put("job_other").status_code == 404
    assert put("job_unknown").status_code == 404


def test_clear_returns_document_to_default(qb_client, qb_storage, admin_headers):
    _seed_default(qb_storage)
    qb_client.put(
        "/admin/query-bot/active-build",
        headers=admin_headers,
        json={"doc_id": "bill.pdf", "owner": "qb_alice", "job_id": "job_old"},
    )
    resp = qb_client.delete("/admin/query-bot/active-build", headers=admin_headers, params={"doc_id": "bill.pdf", "owner": "qb_alice"})
    assert resp.status_code == 200
    assert resp.json()["active_job_id"] is None
    assert resp.json()["in_use_job_id"] == "job_new"
    alice = login(qb_client, "qb_alice", "password123")
    assert _user_job_id(qb_client, alice) == "job_new"


def test_active_build_endpoints_are_admin_only(qb_client, qb_storage, admin_headers):
    _seed_default(qb_storage)
    alice = login(qb_client, "qb_alice", "password123")
    body = {"doc_id": "bill.pdf", "owner": "qb_alice", "job_id": "job_old"}
    params = {"doc_id": "bill.pdf", "owner": "qb_alice"}

    assert qb_client.get("/admin/query-bot/documents", headers=alice).status_code == 403
    assert qb_client.put("/admin/query-bot/active-build", headers=alice, json=body).status_code == 403
    assert qb_client.delete("/admin/query-bot/active-build", headers=alice, params=params).status_code == 403

    assert qb_client.get("/admin/query-bot/documents").status_code == 401
    assert qb_client.put("/admin/query-bot/active-build", json=body).status_code == 401
    assert qb_client.delete("/admin/query-bot/active-build", params=params).status_code == 401


def test_only_empty_builds_answer_without_graph_or_llm(qb_client, qb_storage, admin_headers, monkeypatch):
    from src.ai.layer3_extraction.graph_agent import query_service as qs
    from app.api.pipeline_routes import EMPTY_GRAPH_MSG_ADMIN, EMPTY_GRAPH_MSG_USER

    _save(qb_storage, "job_empty", graph=EMPTY_GRAPH, doc_id="empty.pdf")

    def _no_query(self, *a, **k):
        raise AssertionError("GraphQueryService.query must not run for an empty-only document")

    monkeypatch.setattr(qs.GraphQueryService, "query", _no_query)
    alice = login(qb_client, "qb_alice", "password123")
    body = {"question": "Who is the patient?", "doc_id": "empty.pdf"}

    user_resp = qb_client.post("/api/query-bot/ask", headers=alice, json=body)
    assert user_resp.status_code == 200
    assert user_resp.json()["mode"] == "graph_empty"
    assert user_resp.json()["answer"] == EMPTY_GRAPH_MSG_USER

    admin_resp = qb_client.post("/api/query-bot/ask", headers=admin_headers, json={**body, "owner": "qb_alice"})
    assert admin_resp.status_code == 200
    assert admin_resp.json()["answer"] == EMPTY_GRAPH_MSG_ADMIN


def test_stream_empty_only_emits_graph_empty_answer(qb_client, qb_storage, monkeypatch):
    from src.ai.layer3_extraction.graph_agent import query_service as qs
    from app.api.pipeline_routes import EMPTY_GRAPH_MSG_USER

    _save(qb_storage, "job_empty", graph=EMPTY_GRAPH, doc_id="empty.pdf")
    def _no_query(self, *a, **k):
        raise AssertionError("GraphQueryService.query must not run for an empty-only document")

    monkeypatch.setattr(qs.GraphQueryService, "query", _no_query)
    alice = login(qb_client, "qb_alice", "password123")
    resp = qb_client.post("/api/query-bot/ask/stream", headers=alice, json={"question": "Who?", "doc_id": "empty.pdf"})
    assert resp.status_code == 200
    events = parse_sse(resp.text)
    answer = next(data for name, data in events if name == "answer")
    assert answer["mode"] == "graph_empty"
    assert answer["answer"] == EMPTY_GRAPH_MSG_USER
