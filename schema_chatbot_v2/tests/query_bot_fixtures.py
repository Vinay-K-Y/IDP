"""
Shared helpers for the FEAT-003 Query Bot tests: a temp SQLite storage, a small bill graph,
and stubs for every LLM and embedding call. Nothing here reaches AWS, Bedrock, Sarvam or a
network model.
"""
import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

CANNED_ANSWER = "**Patient:** CHANDER KOCHHAR, admitted on 21/02/2025 (Source: Page 2)."

BILL_ROWS = [
    ("BED CHARGES", "30,950.00"),
    ("CARDIOLOGY", "7,600.00"),
    ("DIETETICS", "1,350.00"),
    ("DOCTOR FEES", "17,400.00"),
    ("HOSPITAL SERVICES", "10,120.00"),
    ("IMAGING", "44,800.00"),
    ("LABMEDICINE", "34,720.00"),
    ("MATERIALS MGMT", "1,500.00"),
    ("PHARMACY", "42,379.25"),
    ("PHARMACY Returns", "-1,048.00"),
]


def build_bill_graph(include_returns: bool = True) -> dict:
    """A graph shaped like the summary page of the 189,771.25 bill (page 10 rows) plus a patient name."""
    from src.ai.layer3_extraction.graph_agent.graph_memory import GraphMemory
    from src.ai.layer3_extraction.graph_agent.models import NodeEvidence

    graph = GraphMemory()
    rows = BILL_ROWS if include_returns else [r for r in BILL_ROWS if r[0] != "PHARMACY Returns"]
    for i, (label, amount) in enumerate(rows):
        graph.create_node(
            node_id=f"row_{i}", node_type="Amount", label=label, value=amount, source_page=10,
            evidence=NodeEvidence(page_number=10, text=f"{label} 0.00 {amount}"),
        )
    graph.create_node(
        node_id="total", node_type="Amount", label="Total_Bill_Amount", value="189,771.25", source_page=10,
        evidence=NodeEvidence(page_number=10, text="Total Bill Amount 0.00 189,771.25"),
    )
    graph.create_node(
        node_id="pat_p2", node_type="Patient", label="Patient_Name", value="CHANDER KOCHHAR", source_page=2,
        evidence=NodeEvidence(page_number=2, text="Patient Name : CHANDER KOCHHAR"),
    )
    graph.create_node(
        node_id="pat_p4", node_type="Patient", label="Patient_Name", value="CHANDER KOCHHAR", source_page=4,
        evidence=NodeEvidence(page_number=4, text="CHANDER KOCHHAR"),
    )
    return graph.to_dict()


@pytest.fixture
def qb_storage(tmp_path, monkeypatch):
    """Points the storage module at a temp SQLite file. Production RDS is never used."""
    import src.ai.layer3_extraction.storage as storage_mod

    eng = create_engine(f"sqlite:///{tmp_path / 'query_bot_test.db'}")
    monkeypatch.setattr(storage_mod, "engine", eng)
    monkeypatch.setattr(storage_mod, "SessionLocal", sessionmaker(bind=eng))
    storage_mod.Base.metadata.create_all(eng)
    yield storage_mod
    eng.dispose()


@pytest.fixture
def stub_llm(monkeypatch):
    """Replaces the answer LLM, the grounding LLM and the embedding search on GraphQueryService."""
    from src.ai.layer3_extraction.graph_agent import query_service as qs

    monkeypatch.setattr(qs.GraphQueryService, "_generate_answer", lambda self, *a, **k: CANNED_ANSWER)
    monkeypatch.setattr(qs.GraphQueryService, "_bedrock_grounding_caller", lambda self, system, user: "")
    monkeypatch.setattr(qs.GraphQueryService, "find_vector_seed_nodes", lambda self, graph, question, **k: [])
    return qs


@pytest.fixture
def qb_client(qb_storage, stub_llm, monkeypatch):
    from app.api import pipeline_routes as pr
    from app.main import app
    from app.storage.user_store import Role, get_user_store

    pr.reset_query_graph_cache()
    store = get_user_store()
    for name in ("qb_alice", "qb_bob"):
        try:
            store.create(username=name, password="password123", role=Role.USER)
        except ValueError:
            pass
    client = TestClient(app)
    yield client
    pr.reset_query_graph_cache()


def login(client: TestClient, username: str, password: str) -> dict:
    resp = client.post("/auth/login", data={"username": username, "password": password})
    assert resp.status_code == 200, resp.text
    return {"Authorization": f"Bearer {resp.json()['access_token']}"}


def parse_sse(text: str):
    """Returns [(event, data_dict), ...] from a text/event-stream body."""
    events = []
    for block in text.strip().split("\n\n"):
        name, data = None, None
        for line in block.split("\n"):
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if name is not None:
            events.append((name, data))
    return events
