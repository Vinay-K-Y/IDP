"""
FEAT-003: Query Bot streaming endpoint, stage order, tenant isolation, page-deduplicated
sources and the programmatic total check, end to end through the FastAPI app.
"""
import pytest

from tests.query_bot_fixtures import (  # noqa: F401  (fixtures are used by name)
    CANNED_ANSWER,
    build_bill_graph,
    login,
    parse_sse,
    qb_client,
    qb_storage,
    stub_llm,
)


def _save_bill(qb_storage, owner="qb_alice", doc_id="bill.pdf", job_id="job_a", include_returns=True):
    qb_storage.save_document_graph(
        doc_id=doc_id,
        graph_dict=build_bill_graph(include_returns=include_returns),
        job_id=job_id,
        owner=owner,
    )


def test_stream_emits_stages_in_order_then_sources_answer_done(qb_client, qb_storage):
    _save_bill(qb_storage)
    headers = login(qb_client, "qb_alice", "password123")

    resp = qb_client.post(
        "/api/query-bot/ask/stream",
        headers=headers,
        json={"question": "What is the patient name?", "doc_id": "bill.pdf"},
    )

    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(resp.text)
    names = [name for name, _ in events]
    assert names == ["stage", "stage", "stage", "sources", "answer", "done"]
    stages = [data["stage"] for name, data in events if name == "stage"]
    assert stages == ["searching_graph", "reading_pages", "answering"]
    answer = next(data for name, data in events if name == "answer")
    assert answer["answer"] == CANNED_ANSWER
    assert answer["mode"] == "graph"
    done = next(data for name, data in events if name == "done")
    assert done["timings"]["total_ms"] >= 0
    assert "llm_answer_ms" in done["timings"]


def test_stream_denies_another_owner_with_403(qb_client, qb_storage):
    _save_bill(qb_storage, owner="qb_alice")
    bob = login(qb_client, "qb_bob", "password123")

    resp = qb_client.post(
        "/api/query-bot/ask/stream",
        headers=bob,
        json={"question": "What is the patient name?", "doc_id": "bill.pdf"},
    )

    assert resp.status_code == 403


def test_stream_requires_authentication(qb_client, qb_storage):
    _save_bill(qb_storage)
    resp = qb_client.post("/api/query-bot/ask/stream", json={"question": "x", "doc_id": "bill.pdf"})
    assert resp.status_code == 401


def test_ask_returns_sources_one_per_page_sorted(qb_client, qb_storage):
    _save_bill(qb_storage)
    headers = login(qb_client, "qb_alice", "password123")

    resp = qb_client.post(
        "/api/query-bot/ask",
        headers=headers,
        json={"question": "What is the patient name?", "doc_id": "bill.pdf"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["mode"] == "graph"
    pages = [s["page"] for s in body["sources"]]
    assert pages == sorted(set(pages)), "sources must be one per page and sorted by page"
    assert 2 in pages and 4 in pages


def test_ask_total_check_matches_bill_total(qb_client, qb_storage):
    _save_bill(qb_storage)
    headers = login(qb_client, "qb_alice", "password123")

    resp = qb_client.post(
        "/api/query-bot/ask",
        headers=headers,
        json={"question": "Give me the itemised bill breakdown with the total", "doc_id": "bill.pdf"},
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["itemised"] is True
    assert body["total_check"]["matched"] is True
    assert body["total_check"]["sum"] == "189771.25"
    assert body["total_check"]["stated"] == "189771.25"
    assert "Check: the category amounts sum to the stated total of 189771.25." in body["answer"]


def test_ask_total_check_flags_missing_category(qb_client, qb_storage):
    _save_bill(qb_storage, include_returns=False)
    headers = login(qb_client, "qb_alice", "password123")

    resp = qb_client.post(
        "/api/query-bot/ask",
        headers=headers,
        json={"question": "Give me the itemised bill breakdown with the total", "doc_id": "bill.pdf"},
    )

    body = resp.json()
    assert body["total_check"]["matched"] is False
    assert body["total_check"]["missing_amount"] == "-1048.00"
    assert "190,819.25" in body["answer"]
    assert "not fully detailed" in body["answer"]
