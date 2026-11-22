"""
FEAT-003: the Query Bot keeps parsed graphs in a bounded LRU. A repeat question on the same
document does not parse the graph again. A new updated_at invalidates the entry. Owner checks
still run on every request, including cache hits.
"""
import time

from tests.query_bot_fixtures import (  # noqa: F401  (fixtures are used by name)
    build_bill_graph,
    login,
    qb_client,
    qb_storage,
    stub_llm,
)


def _count_graph_parses(monkeypatch):
    from src.ai.layer3_extraction.graph_agent.graph_memory import GraphMemory

    original = GraphMemory.from_dict.__func__
    calls = {"n": 0}

    def counting(cls, data):
        calls["n"] += 1
        return original(cls, data)

    monkeypatch.setattr(GraphMemory, "from_dict", classmethod(counting))
    return calls


def test_second_question_on_same_doc_does_not_reload_graph(qb_client, qb_storage, monkeypatch):
    qb_storage.save_document_graph(doc_id="bill.pdf", graph_dict=build_bill_graph(), job_id="job_a", owner="qb_alice")
    calls = _count_graph_parses(monkeypatch)
    headers = login(qb_client, "qb_alice", "password123")
    body = {"question": "What is the patient name?", "doc_id": "bill.pdf"}

    first = qb_client.post("/api/query-bot/ask", headers=headers, json=body)
    second = qb_client.post("/api/query-bot/ask", headers=headers, json=body)

    assert first.status_code == 200 and second.status_code == 200
    assert calls["n"] == 1
    assert first.json()["timings"]["cache_hit"] is False
    assert second.json()["timings"]["cache_hit"] is True


def test_changed_updated_at_invalidates_cache(qb_client, qb_storage, monkeypatch):
    qb_storage.save_document_graph(doc_id="bill.pdf", graph_dict=build_bill_graph(), job_id="job_a", owner="qb_alice")
    calls = _count_graph_parses(monkeypatch)
    headers = login(qb_client, "qb_alice", "password123")
    body = {"question": "What is the patient name?", "doc_id": "bill.pdf"}
    qb_client.post("/api/query-bot/ask", headers=headers, json=body)
    assert calls["n"] == 1

    time.sleep(0.01)
    qb_storage.save_document_graph(doc_id="bill.pdf", graph_dict=build_bill_graph(), job_id="job_a", owner="qb_alice")
    after = qb_client.post("/api/query-bot/ask", headers=headers, json=body)

    assert after.status_code == 200
    assert calls["n"] == 2
    assert after.json()["timings"]["cache_hit"] is False


def test_cache_hit_still_enforces_owner_check(qb_client, qb_storage, monkeypatch):
    qb_storage.save_document_graph(doc_id="bill.pdf", graph_dict=build_bill_graph(), job_id="job_a", owner="qb_alice")
    alice = login(qb_client, "qb_alice", "password123")
    bob = login(qb_client, "qb_bob", "password123")
    body = {"question": "What is the patient name?", "doc_id": "bill.pdf"}
    assert qb_client.post("/api/query-bot/ask", headers=alice, json=body).status_code == 200

    resp = qb_client.post("/api/query-bot/ask", headers=bob, json=body)

    assert resp.status_code == 403


def test_cache_is_bounded(monkeypatch):
    from app.api import pipeline_routes as pr

    pr.reset_query_graph_cache()
    monkeypatch.setattr(pr, "QUERY_GRAPH_CACHE_MAX", 3)
    for i in range(5):
        pr._query_cache_put(("owner", f"doc{i}.pdf", str(i)), ("graph", "service"))
    assert len(pr._query_graph_cache) == 3
    assert pr._query_cache_get(("owner", "doc0.pdf", "0")) is None
    assert pr._query_cache_get(("owner", "doc4.pdf", "4")) is not None
    pr.reset_query_graph_cache()
