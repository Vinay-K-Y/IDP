"""
Query Bot token streaming. Bedrock converse_stream text deltas reach the SSE stream as "token" events
before the final "answer" event. Reasoning deltas are not forwarded. Bedrock is replaced by a local fake,
so no AWS call is made.
"""
import pytest
from fastapi.testclient import TestClient

from tests.query_bot_fixtures import build_bill_graph, login, parse_sse, qb_storage  # noqa: F401


class _FakeBedrock:
    def __init__(self, deltas):
        self.deltas = deltas
        self.stream_calls = 0
        self.converse_calls = 0

    def converse_stream(self, **kwargs):
        self.stream_calls += 1
        events = [{"messageStart": {"role": "assistant"}}]
        for kind, piece in self.deltas:
            if kind == "text":
                delta = {"text": piece}
            else:
                delta = {"reasoningContent": {"reasoningText": {"text": piece}}}
            events.append({"contentBlockDelta": {"contentBlockIndex": 0, "delta": delta}})
        events.append({"contentBlockStop": {"contentBlockIndex": 0}})
        events.append({"messageStop": {"stopReason": "end_turn"}})
        return {"stream": events}

    def converse(self, **kwargs):
        self.converse_calls += 1
        raise AssertionError("streaming must not fall back to converse")


class _Session:
    def __init__(self, client):
        self._client = client

    def client(self, *args, **kwargs):
        return self._client


def test_bedrock_text_forwards_text_deltas_and_skips_reasoning():
    from src.ai.layer3_extraction.graph_agent.query_service import GraphQueryService

    fake = _FakeBedrock([("reasoning", "let me think"), ("text", "Patient: "), ("text", "CHANDER KOCHHAR")])
    seen = []

    text = GraphQueryService._bedrock_text(fake, {"modelId": "m"}, seen.append)

    assert text == "Patient: CHANDER KOCHHAR"
    assert seen == ["Patient: ", "CHANDER KOCHHAR"]
    assert fake.converse_calls == 0


@pytest.fixture
def stream_client(qb_storage, monkeypatch):
    import boto3

    from app.api import pipeline_routes as pr
    from app.main import app
    from app.storage.user_store import Role, get_user_store
    from src.ai.layer3_extraction.graph_agent import query_service as qs

    fake = _FakeBedrock([("text", "**Patient:** "), ("text", "CHANDER KOCHHAR (Source: Page 2).")])
    monkeypatch.setattr(boto3, "client", lambda *a, **k: fake)
    monkeypatch.setattr(boto3, "Session", lambda *a, **k: _Session(fake))
    monkeypatch.setattr(qs.GraphQueryService, "find_vector_seed_nodes", lambda self, graph, question, **k: [])
    monkeypatch.setattr(qs.GraphQueryService, "_bedrock_grounding_caller", lambda self, system, user: "")

    pr.reset_query_graph_cache()
    store = get_user_store()
    try:
        store.create(username="qb_stream_alice", password="password123", role=Role.USER)
    except ValueError:
        pass
    yield TestClient(app), fake
    pr.reset_query_graph_cache()


def test_stream_sends_token_events_before_the_final_answer(stream_client, qb_storage):
    client, fake = stream_client
    qb_storage.save_document_graph(
        doc_id="bill.pdf", graph_dict=build_bill_graph(), job_id="job_stream", owner="qb_stream_alice",
    )
    headers = login(client, "qb_stream_alice", "password123")

    resp = client.post(
        "/api/query-bot/ask/stream",
        headers=headers,
        json={"question": "What is the patient name?", "doc_id": "bill.pdf"},
    )

    assert resp.status_code == 200
    events = parse_sse(resp.text)
    names = [name for name, _ in events]
    stages = [name for name in names if name == "stage"]
    assert len(stages) == 3
    assert [n for n in names if n in ("token", "answer")] == ["token", "token", "answer"]
    assert names.index("token") > names.index("stage")
    tokens = [data["text"] for name, data in events if name == "token"]
    assert tokens == ["**Patient:** ", "CHANDER KOCHHAR (Source: Page 2)."]
    answer = next(data for name, data in events if name == "answer")
    assert "CHANDER KOCHHAR" in answer["answer"]
    assert fake.stream_calls == 1
    assert fake.converse_calls == 0
