"""
Page-level OCR progress: tracker unit tests, endpoint field checks (admin and
user), and an offline runner test. The runner test uses real generated PDFs for
page counts and a fake OCR driver. Nothing here runs real OCR or touches AWS.
"""
import itertools
import threading
import time
from pathlib import Path
from unittest.mock import MagicMock

import pymupdf
import pytest
from fastapi.testclient import TestClient

from app.api import pipeline_routes
from app.api.pipeline_routes import (
    JobControl,
    _job_controls,
    _pipeline_jobs,
    _run_pipeline_job,
)
from app.core.job_progress import JobProgressTracker, compact_progress
from app.main import app
from app.storage.user_store import Role, get_user_store
from src.ai.schemas.page import PageOutput


class FakeClock:
    def __init__(self) -> None:
        self.t = 0.0

    def __call__(self) -> float:
        return self.t

    def advance(self, seconds: float) -> None:
        self.t += seconds


def _tracker(clock: FakeClock, job: dict | None = None):
    ticks = itertools.count()
    tracker = JobProgressTracker(clock=clock, now_iso=lambda: f"t{next(ticks):06d}")
    job = job if job is not None else {"job_id": "unit"}
    tracker.attach(job)
    return tracker, job


@pytest.fixture(autouse=True)
def cleanup_jobs():
    _pipeline_jobs.clear()
    _job_controls.clear()
    yield
    _pipeline_jobs.clear()
    _job_controls.clear()


# ----------------------------------------------------------------- tracker units


def test_phase_sequence_and_updated_at_advances():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    assert job["progress"]["phase"] == "queued"

    seen_updated = []
    tracker.start_job([2])
    seen_updated.append(job["progress"]["updated_at"])
    tracker.start_doc("a.pdf")
    assert job["progress"]["phase"] == "rendering"
    seen_updated.append(job["progress"]["updated_at"])
    tracker.begin_ocr(2)
    assert job["progress"]["phase"] == "ocr"
    seen_updated.append(job["progress"]["updated_at"])
    tracker.page_done(1)
    tracker.page_done(2)
    tracker.begin_extract()
    assert job["progress"]["phase"] == "extracting"
    tracker.finish_doc()
    tracker.finish("finished")
    assert job["progress"]["phase"] == "finished"

    assert seen_updated == sorted(seen_updated)
    assert len(set(seen_updated)) == len(seen_updated)
    assert job["progress"]["updated_at"] > seen_updated[-1]


def test_concurrent_page_done_never_loses_or_overshoots_counts():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([5000])
    tracker.start_doc("big.pdf")
    tracker.begin_ocr(5000)

    overshoot = []
    stop = threading.Event()

    def reader():
        # Readers see the job dict while writers update it. No read may show done above total.
        while not stop.is_set():
            p = job["progress"]
            if p["pages_done"] > p["pages_total"]:
                overshoot.append(dict(p))

    def writer():
        for _ in range(200):
            tracker.page_done()

    watcher = threading.Thread(target=reader)
    watcher.start()
    workers = [threading.Thread(target=writer) for _ in range(25)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    stop.set()
    watcher.join()

    assert job["progress"]["pages_done"] == 5000
    assert job["progress"]["current_doc_pages_done"] == 5000
    assert overshoot == []


def test_eta_is_hidden_before_first_page_and_shown_after_it():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([40])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(40)

    clock.advance(5.0)
    assert tracker.live()["eta_s"] is None  # no page finished yet

    clock.advance(0.0)
    tracker.page_done()  # first page at 5 s: 1 page per 5 s, 39 left
    assert tracker.live()["eta_s"] == 195

    clock.advance(0.4)
    tracker.page_done()  # 2 pages at 5.4 s: window rate 2 / 5.4, 38 left
    assert tracker.live()["eta_s"] == 103  # 38 * 5.4 / 2 = 102.6, rounded

    # 10 pages in 20 s, 30 left: 2 s per page, so 60 s left.
    clock2 = FakeClock()
    t2, _ = _tracker(clock2)
    t2.start_job([40])
    t2.start_doc("a.pdf")
    t2.begin_ocr(40)
    for _ in range(10):
        clock2.advance(2.0)
        t2.page_done()
    assert t2.live()["eta_s"] == 60


def test_eta_is_a_moving_average_over_recent_pages():
    clock = FakeClock()
    tracker, _ = _tracker(clock)
    tracker.start_job([40])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(40)
    for _ in range(10):  # ten fast pages at 1 s each
        clock.advance(1.0)
        tracker.page_done()
    for _ in range(10):  # then ten slow pages at 4 s each
        clock.advance(4.0)
        tracker.page_done()
    # The cumulative average is 50 s / 20 pages = 2.5 s per page, which would give 50 s.
    # The last 10 pages average 4 s per page, so 20 pages left take 80 s.
    assert tracker.live()["eta_s"] == 80


def test_pages_completed_is_monotonic_under_concurrency_and_in_flight_returns_to_zero():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    total = 3000
    tracker.start_job([total])
    tracker.start_doc("big.pdf")
    tracker.begin_ocr(total)

    seen_done = []
    seen_flight = []
    stop = threading.Event()

    def reader():
        while not stop.is_set():
            p = job["progress"]
            seen_done.append(p["pages_done"])
            seen_flight.append(p["pages_in_flight"])

    def worker(first):
        # Each worker runs its pages one after another, like one slot of the page pool.
        for page in range(first, first + total // 25):
            tracker.record_stage(page, "ocr_start")
            tracker.page_done(page)

    watcher = threading.Thread(target=reader)
    watcher.start()
    workers = [threading.Thread(target=worker, args=(1 + i * (total // 25),)) for i in range(25)]
    for w in workers:
        w.start()
    for w in workers:
        w.join()
    stop.set()
    watcher.join()

    assert seen_done == sorted(seen_done)
    assert max(seen_done) <= total
    assert 0 <= min(seen_flight) and max(seen_flight) <= 25
    final = job["progress"]
    assert final["pages_done"] == total
    assert final["pages_in_flight"] == 0


def test_out_of_order_completions_are_counted_and_in_flight_tracks_open_pages():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([4])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(4)
    for page in (1, 2, 3, 4):
        tracker.record_stage(page, "ocr_start")
    assert job["progress"]["pages_in_flight"] == 4

    seq_before = job["progress"]["events_seq"]
    clock.advance(10.0)
    tracker.page_done(4)
    tracker.page_done(2)
    tracker.page_done(3)
    p = job["progress"]
    assert p["pages_done"] == 3
    assert p["pages_in_flight"] == 1
    assert p["events_seq"] > seq_before
    assert [e["page"] for e in p["recent_events"] if e["stage"] == "ocr_done"] == [4, 2, 3]
    seqs = [e["seq"] for e in p["recent_events"]]
    assert seqs == sorted(seqs)

    tracker.page_done(1)
    assert job["progress"]["pages_in_flight"] == 0
    assert job["progress"]["pages_done"] == 4


def test_stage_events_are_recorded_in_order_and_invalid_stage_is_rejected():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([1])
    tracker.record_stage(None, "probe_start")
    tracker.record_stage(None, "probe_done")
    tracker.record_stage(1, "inspect_done")
    tracker.record_stage(1, "route_done")
    tracker.record_stage(1, "ocr_start")
    assert job["progress"]["stage"] == "ocr_start"
    assert [e["stage"] for e in job["progress"]["recent_events"]] == [
        "probe_start", "probe_done", "inspect_done", "route_done", "ocr_start",
    ]
    with pytest.raises(ValueError):
        tracker.record_stage(1, "not_a_stage")


def test_document_failure_clears_in_flight_pages_and_skips_the_rest():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([3])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(3)
    tracker.record_stage(1, "ocr_start")
    tracker.record_stage(2, "ocr_start")
    tracker.page_done(1)
    # Page 2 raised, so page_done is never called for it.
    tracker.finish_doc()
    p = job["progress"]
    assert p["pages_in_flight"] == 0
    assert p["pages_done"] == 1
    assert p["pages_skipped"] == 2


def test_elapsed_ticks_between_reads_and_stops_at_finish():
    clock = FakeClock()
    tracker, _ = _tracker(clock)
    tracker.start_job([1])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(1)
    clock.advance(1.0)
    assert tracker.live()["elapsed_s"] == 1.0
    clock.advance(3.0)
    assert tracker.live()["elapsed_s"] == 4.0

    tracker.page_done()
    tracker.finish_doc()
    tracker.finish("finished")
    stopped = tracker.live()["elapsed_s"]
    clock.advance(100.0)
    assert tracker.live()["elapsed_s"] == stopped
    assert tracker.live()["eta_s"] is None


def test_finish_doc_after_partial_document_moves_pages_to_skipped():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([4, 3])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(4)
    tracker.page_done()
    tracker.page_done()
    tracker.finish_doc()

    p = job["progress"]
    assert p["pages_done"] == 2
    assert p["pages_skipped"] == 2
    assert p["pages_total"] == 5
    assert p["docs_done"] == 1

    # A document that fails before OCR starts loses all of its planned pages.
    tracker.start_doc("b.pdf")
    tracker.finish_doc()
    p = job["progress"]
    assert p["pages_skipped"] == 5
    assert p["pages_total"] == 2
    assert p["docs_done"] == 2
    assert p["pages_done"] + p["pages_skipped"] == 7


def test_live_read_does_not_modify_stored_progress():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([3])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(3)
    stored = job["progress"]
    before = dict(stored)

    clock.advance(7.0)
    view = tracker.live()

    assert job["progress"] is stored
    assert dict(job["progress"]) == before
    assert "elapsed_s" not in job["progress"]
    assert view["elapsed_s"] == 7.0


def test_kill_requested_then_finish_marks_killed_and_stops_clock():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([10])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(10)
    clock.advance(2.0)
    tracker.kill_requested()
    assert job["progress"]["phase"] == "killed"

    # 2 s running, then kill at t=2, then 1 s more until the worker reports
    # the job stopped at t=3.
    clock.advance(1.0)
    tracker.finish("killed")
    assert tracker.live()["elapsed_s"] == 3.0
    clock.advance(50.0)
    assert tracker.live()["elapsed_s"] == 3.0
    assert job["progress"]["phase"] == "killed"


def test_compact_progress_keeps_list_keys_only():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([2])
    compact = compact_progress(tracker.live())
    assert set(compact) == {
        "phase", "pages_done", "pages_total", "pages_skipped", "pages_in_flight",
        "events_seq", "stage",
        "docs_done", "docs_total", "elapsed_s", "eta_s",
        "stopping",
        "ocr_elapsed_s", "graph_elapsed_s", "ocr_started_at", "ocr_finished_at",
        "graph_started_at", "graph_finished_at", "server_now",
    }
    assert compact_progress(None) is None


    assert compact["stopping"] is False


def test_kill_during_document_reports_stopping_and_keeps_phase():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([3])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(3)
    tracker.page_done(1)
    tracker.kill_requested()
    assert compact_progress(tracker.live())["stopping"] is True
    # The running document still completes pages, and the phase stays 'killed'.
    tracker.page_done(2)
    assert job["progress"]["phase"] == "killed"
    tracker.finish_doc()
    assert job["progress"]["pages_done"] == 2
    tracker.finish("killed")
    view = tracker.live()
    assert view["stopping"] is False
    assert view["phase"] == "killed"
    # The last planned page was never OCR'd, so it is skipped.
    assert view["pages_total"] == 2 and view["pages_done"] == 2 and view["pages_skipped"] == 1


def test_kill_requested_keeps_phase_when_ocr_or_extract_start_later():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([2])
    tracker.start_doc("a.pdf")
    tracker.kill_requested()
    tracker.begin_ocr(2)
    assert job["progress"]["phase"] == "killed"
    tracker.begin_extract()
    assert job["progress"]["phase"] == "killed"


def test_kill_between_documents_moves_unstarted_pages_to_skipped():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([2, 5, 3])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(2)
    tracker.page_done(1)
    tracker.page_done(2)
    tracker.finish_doc()
    tracker.kill_requested()
    tracker.finish("killed")
    view = tracker.live()
    assert view["pages_done"] == 2
    assert view["pages_skipped"] == 8
    assert view["pages_total"] == 2
    assert view["docs_done"] == 1
    assert view["stopping"] is False


# --------------------------------------------------------------- endpoint checks


OLD_ADMIN_LIST_KEYS = {"job_id", "schema_id", "schema_file", "strategy", "status", "created_at", "total", "completed"}
OLD_DETAIL_KEYS = {
    "job_id", "status", "created_at", "schema_id", "schema_file", "strategy",
    "targets", "successes", "failures", "started_at", "finished_at",
    "wall_time_s", "owner", "current_document",
}
OLD_USER_LIST_KEYS = {
    "job_id", "status", "currently_processing", "documents", "succeeded",
    "failed", "remaining", "total", "created_at",
}
PROGRESS_KEYS = {
    "phase", "pages_total", "pages_done", "pages_skipped", "pages_in_flight",
    "pages_completed", "events_seq", "stage", "recent_events", "current_doc",
    "current_doc_pages_total", "current_doc_pages_done", "docs_total",
    "docs_done", "started_at", "updated_at",
    "ocr_s", "elapsed_s", "eta_s",
}


def _make_job(job_id: str, owner: str, status: str = "running") -> dict:
    job = {
        "job_id": job_id,
        "status": status,
        "created_at": "2026-10-28T10:00:00+05:30",
        "schema_id": "schema_x",
        "schema_file": "schema_x.json",
        "strategy": "graph_memory_concurrent",
        "targets": ["a.pdf", "b.pdf"],
        "successes": [],
        "failures": [],
        "started_at": None,
        "finished_at": None,
        "wall_time_s": None,
        "owner": owner,
        "current_document": None,
    }
    _pipeline_jobs[job_id] = job
    ctrl = JobControl()
    _job_controls[job_id] = ctrl
    ctrl.progress.attach(job)
    ctrl.progress.start_job([3, 2])
    ctrl.progress.start_doc("a.pdf")
    ctrl.progress.begin_ocr(3)
    ctrl.progress.page_done()
    return job


@pytest.fixture
def client():
    return TestClient(app)


@pytest.fixture
def admin_headers(client):
    r = client.post("/auth/login", data={"username": "admin", "password": "changeme"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


@pytest.fixture
def user_headers(client):
    store = get_user_store()
    try:
        store.create(username="progress_user_1", password="password123", role=Role.USER)
    except ValueError:
        pass
    r = client.post("/auth/login", data={"username": "progress_user_1", "password": "password123"})
    return {"Authorization": f"Bearer {r.json()['access_token']}"}


def test_admin_list_and_detail_include_progress_and_keep_old_keys(client, admin_headers):
    _make_job("job_admin_1", owner="admin")

    listing = client.get("/pipeline/status", headers=admin_headers).json()["jobs"]["job_admin_1"]
    assert OLD_ADMIN_LIST_KEYS <= set(listing)
    assert listing["total"] == 2
    assert listing["progress"]["pages_done"] == 1
    assert listing["progress"]["pages_total"] == 5
    assert "elapsed_s" in listing["progress"]

    detail = client.get("/pipeline/jobs/job_admin_1", headers=admin_headers).json()
    assert OLD_DETAIL_KEYS <= set(detail)
    assert PROGRESS_KEYS <= set(detail["progress"])
    assert detail["progress"]["pages_done"] == 1
    assert isinstance(detail["progress"]["elapsed_s"], float)


def test_user_list_and_detail_include_progress_and_keep_old_keys(client, user_headers):
    _make_job("job_user_1", owner="progress_user_1")

    listing = client.get("/me/pipeline/status", headers=user_headers).json()["jobs"]
    row = next(j for j in listing if j["job_id"] == "job_user_1")
    assert OLD_USER_LIST_KEYS <= set(row)
    assert row["progress"]["pages_done"] == 1
    assert row["progress"]["pages_total"] == 5

    detail = client.get("/me/pipeline/jobs/job_user_1", headers=user_headers).json()
    assert OLD_DETAIL_KEYS <= set(detail)
    assert PROGRESS_KEYS <= set(detail["progress"])


def test_legacy_job_without_tracker_returns_null_progress(client, admin_headers, user_headers):
    _pipeline_jobs["job_legacy"] = {
        "job_id": "job_legacy",
        "status": "completed",
        "created_at": "2026-08-01T10:00:00+00:00",
        "schema_id": "s",
        "schema_file": "s.json",
        "strategy": "graph_memory_concurrent",
        "targets": ["a.pdf"],
        "successes": [{"pdf": "a.pdf"}],
        "failures": [],
        "started_at": "2026-08-01T10:00:01+00:00",
        "finished_at": "2026-08-01T10:05:00+00:00",
        "wall_time_s": 299.0,
        "owner": "progress_user_1",
        "current_document": None,
    }

    admin_list = client.get("/pipeline/status", headers=admin_headers)
    assert admin_list.status_code == 200
    assert admin_list.json()["jobs"]["job_legacy"]["progress"] is None
    assert OLD_ADMIN_LIST_KEYS <= set(admin_list.json()["jobs"]["job_legacy"])

    admin_detail = client.get("/pipeline/jobs/job_legacy", headers=admin_headers)
    assert admin_detail.status_code == 200
    assert admin_detail.json()["progress"] is None
    assert OLD_DETAIL_KEYS <= set(admin_detail.json())

    user_detail = client.get("/me/pipeline/jobs/job_legacy", headers=user_headers)
    assert user_detail.status_code == 200
    assert user_detail.json()["progress"] is None


# ------------------------------------------------------------ runner (offline)


def _make_pdf(path: Path, pages: int) -> Path:
    doc = pymupdf.open()
    for _ in range(pages):
        doc.new_page()
    doc.save(str(path))
    doc.close()
    return path


def test_runner_reports_page_progress_across_two_documents(tmp_path, monkeypatch):
    good = _make_pdf(tmp_path / "good.pdf", 3)
    bad = _make_pdf(tmp_path / "bad.pdf", 4)
    targets = [good, bad]

    out_dir = tmp_path / "out"
    out_dir.mkdir()
    monkeypatch.setattr(pipeline_routes, "resolve_owner_output_dir", lambda owner: out_dir)
    monkeypatch.setattr(pipeline_routes, "_build_pages_for_pdf",
                        lambda pdf, pdf_bytes=None: [
                            {"page": None, "page_number": i, "context": {}, "image_bytes": b""}
                            for i in range(1, len(pymupdf.open(pdf)) + 1)
                        ])
    monkeypatch.setattr(pipeline_routes, "save_page_irs", lambda **kwargs: None)
    import src.adapters.llm.factory as llm_factory
    import src.ai.layer3_extraction.storage as storage
    import src.utils.job_pdf_report as job_pdf_report
    monkeypatch.setattr(llm_factory, "get_llm_client", lambda: MagicMock())
    monkeypatch.setattr(storage, "get_markdown_record", lambda *a, **k: None)
    monkeypatch.setattr(storage, "save_markdown_record", lambda **k: None)
    monkeypatch.setattr(storage, "save_job_pdf", lambda **k: None)
    monkeypatch.setattr(job_pdf_report, "generate_job_pdf", lambda job: b"")

    snapshots = []
    job_id = "job_runner_1"
    job = {
        "job_id": job_id,
        "status": "queued",
        "created_at": "2026-10-28T10:00:00+05:30",
        "schema_id": "schema_r",
        "schema_file": "schema_r.json",
        "strategy": "graph_memory_concurrent",
        "targets": [p.name for p in targets],
        "successes": [],
        "failures": [],
        "started_at": None,
        "finished_at": None,
        "wall_time_s": None,
        "owner": "runner_owner",
        "current_document": None,
    }
    _pipeline_jobs[job_id] = job
    ctrl = JobControl()
    _job_controls[job_id] = ctrl
    ctrl.progress.attach(job)

    def fake_process_document(pages, llm_client, document_name="", on_page_complete=None, **kwargs):
        outputs = []
        for page in pages:
            if document_name == "bad.pdf" and page["page_number"] == 3:
                raise RuntimeError("simulated OCR crash on page 3")
            time.sleep(0.005)
            outputs.append((
                PageOutput(page_number=page["page_number"], markdown=f"{document_name} p{page['page_number']}",
                           engines_used=["paddleocr_printed"], confidence=0.9,
                           escalated=False, escalation_attempts=0, low_confidence=False),
                None,
            ))
            on_page_complete(page["page_number"])
            snapshots.append(dict(job["progress"]))
        return outputs

    monkeypatch.setattr(pipeline_routes, "process_document", fake_process_document)

    schema_record = {"schema_id": "schema_r", "schema": {"fields": []}, "document_type": "Test"}
    _run_pipeline_job(job_id, targets, Path("schema_r.json"), schema_record, "graph_memory_concurrent", "runner_owner")

    final = job["progress"]
    assert job["status"] == "completed"
    assert final["phase"] == "finished"
    assert final["docs_total"] == 2
    assert final["docs_done"] == 2
    # 3 pages in good.pdf, all done. 4 in bad.pdf: 2 done before the crash, 2 skipped.
    assert final["pages_done"] == 5
    assert final["pages_skipped"] == 2
    assert final["pages_done"] + final["pages_skipped"] == 7
    assert final["pages_total"] == 5
    assert final["current_doc"] == "bad.pdf"
    assert final["current_doc_pages_done"] == 2
    assert [j["pdf"] for j in job["successes"]] == ["good.pdf"]
    assert [j["pdf"] for j in job["failures"]] == ["bad.pdf"]

    done_series = [s["pages_done"] for s in snapshots]
    assert done_series == sorted(done_series)
    assert done_series[-1] == 5
    good_end = next(s for s in snapshots if s["current_doc"] == "good.pdf" and s["pages_done"] == 3)
    assert good_end["current_doc_pages_done"] == 3
    assert good_end["current_doc_pages_total"] == 3


# ------------------------------------------------------ OCR and graph timers

def test_ocr_timer_stops_at_finish_ocr_and_graph_timer_starts_later():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([4])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(4)
    clock.advance(10.0)
    tracker.finish_ocr()
    assert job["progress"]["phase"] == "saving"
    clock.advance(5.0)  # saving the output runs on no timer
    tracker.begin_graph()
    clock.advance(7.0)
    live = tracker.live()
    assert live["phase"] == "graph_building"
    assert live["ocr_elapsed_s"] == 10.0
    assert live["graph_elapsed_s"] == 7.0
    tracker.finish_graph()
    clock.advance(100.0)
    live = tracker.live()
    assert live["ocr_elapsed_s"] == 10.0
    assert live["graph_elapsed_s"] == 7.0
    assert live["ocr_finished_at"] is not None
    assert live["graph_finished_at"] is not None


def test_kill_during_graph_build_keeps_graph_timer_until_step_ends():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([2])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(2)
    clock.advance(3.0)
    tracker.finish_ocr()
    tracker.begin_graph()
    clock.advance(2.0)
    tracker.kill_requested()
    assert job["progress"]["phase"] == "killed"
    clock.advance(4.0)  # the graph build is still running
    assert tracker.live()["graph_elapsed_s"] == 6.0
    tracker.finish_graph()
    clock.advance(50.0)
    live = tracker.live()
    assert live["graph_elapsed_s"] == 6.0
    assert live["ocr_elapsed_s"] == 3.0
    assert job["progress"]["phase"] == "killed"


def test_failed_ocr_leaves_ocr_phase_when_document_ends():
    clock = FakeClock()
    tracker, _ = _tracker(clock)
    tracker.start_job([2, 2])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(2)
    clock.advance(1.0)
    tracker.finish_doc()  # OCR failed before finish_ocr was called
    view = tracker.live()
    assert view["phase"] == "queued"
    assert view["ocr_finished_at"] is not None
    assert view["ocr_elapsed_s"] == 1.0

    tracker.start_doc("b.pdf")
    clock.advance(0.5)
    view = tracker.live()
    assert view["phase"] == "rendering"
    assert view["ocr_started_at"] is None  # next document's OCR has not started yet


def test_finish_doc_closes_open_timers_after_an_exception():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([2])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(2)
    clock.advance(2.0)
    tracker.finish_ocr()
    tracker.begin_graph()
    clock.advance(3.0)
    tracker.finish_doc()  # the graph step raised, so finish_graph was never called
    clock.advance(100.0)
    live = tracker.live()
    assert live["ocr_elapsed_s"] == 2.0
    assert live["graph_elapsed_s"] == 3.0
    assert job["progress"]["graph_finished_at"] is not None


def test_two_documents_sum_totals_and_reset_per_document_timing():
    clock = FakeClock()
    tracker, job = _tracker(clock)
    tracker.start_job([1, 1])
    tracker.start_doc("a.pdf")
    tracker.begin_ocr(1)
    clock.advance(2.0)
    tracker.finish_ocr()
    tracker.begin_graph()
    clock.advance(4.0)
    tracker.finish_graph()
    timing_a = tracker.doc_timing()
    tracker.finish_doc()
    assert timing_a["ocr_elapsed_s"] == 2.0
    assert timing_a["graph_elapsed_s"] == 4.0

    tracker.start_doc("b.pdf")
    assert job["progress"]["ocr_started_at"] is None
    assert job["progress"]["graph_started_at"] is None
    tracker.begin_ocr(1)
    clock.advance(3.0)
    tracker.finish_ocr()
    timing_b = tracker.doc_timing()
    tracker.finish_doc()
    assert timing_b["ocr_elapsed_s"] == 3.0
    assert timing_b["graph_elapsed_s"] == 0.0
    assert timing_b["graph_started_at"] is None

    live = tracker.live()
    assert live["ocr_elapsed_s"] == 5.0
    assert live["graph_elapsed_s"] == 4.0


def _run_timed_job(monkeypatch, tmp_path, strategy, ocr_s, extract_s):
    """Run _run_pipeline_job on one 1-page PDF with fake OCR and fake Layer 3 timings."""
    import src.adapters.llm.extraction_factory as extraction_factory
    import src.adapters.llm.factory as llm_factory
    import src.ai.layer3_extraction.extractor as extractor
    import src.ai.layer3_extraction.schema_validation as schema_validation
    import src.ai.layer3_extraction.storage as storage
    import src.utils.job_pdf_report as job_pdf_report

    pdf = _make_pdf(tmp_path / "timed.pdf", 1)
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    monkeypatch.setattr(pipeline_routes, "resolve_owner_output_dir", lambda owner: out_dir)
    monkeypatch.setattr(pipeline_routes, "_build_pages_for_pdf",
                        lambda p, pdf_bytes=None: [{"page": None, "page_number": 1, "context": {}, "image_bytes": b""}])
    monkeypatch.setattr(pipeline_routes, "save_page_irs", lambda **kwargs: None)
    monkeypatch.setattr(llm_factory, "get_llm_client", lambda: MagicMock())
    monkeypatch.setattr(extraction_factory, "get_extraction_client", lambda: MagicMock())
    monkeypatch.setattr(storage, "get_markdown_record", lambda *a, **k: None)
    monkeypatch.setattr(storage, "save_markdown_record", lambda **k: 7)
    monkeypatch.setattr(storage, "init_db", lambda: None)
    monkeypatch.setattr(storage, "save_extraction_run", lambda **k: 1)
    monkeypatch.setattr(storage, "save_document_graph", lambda **k: 1)
    monkeypatch.setattr(storage, "save_job_pdf", lambda **k: None)
    monkeypatch.setattr(job_pdf_report, "generate_job_pdf", lambda job: b"")

    def fake_process_document(pages, llm_client, document_name="", on_page_complete=None, **kwargs):
        time.sleep(ocr_s)
        on_page_complete(1)
        return [(PageOutput(page_number=1, markdown="text", engines_used=["paddleocr_printed"], confidence=0.9,
                            escalated=False, escalation_attempts=0, low_confidence=False), None)]

    def fake_extract_document(*args, **kwargs):
        time.sleep(extract_s)
        return {}

    monkeypatch.setattr(pipeline_routes, "process_document", fake_process_document)
    monkeypatch.setattr(extractor, "extract_document", fake_extract_document)
    monkeypatch.setattr(schema_validation, "extract_with_retry",
                        lambda fn, schema: (fn(), MagicMock(model_dump=lambda: {"f1": "v"}))[1])

    job_id = f"job_timed_{strategy}"
    job = {
        "job_id": job_id, "status": "queued", "created_at": "2026-10-28T10:00:00+05:30",
        "schema_id": "schema_t", "schema_file": "schema_t.json", "strategy": strategy,
        "targets": [pdf.name], "successes": [], "failures": [], "started_at": None,
        "finished_at": None, "wall_time_s": None, "owner": "timer_owner", "current_document": None,
    }
    _pipeline_jobs[job_id] = job
    ctrl = JobControl()
    ticks = itertools.count()
    ctrl.progress = JobProgressTracker(now_iso=lambda: f"t{next(ticks):06d}")
    _job_controls[job_id] = ctrl
    ctrl.progress.attach(job)
    schema_record = {"schema_id": "schema_t", "schema": {"fields": [{"name": "f1", "description": "d"}]}}
    _run_pipeline_job(job_id, [pdf], Path("schema_t.json"), schema_record, strategy, "timer_owner")
    return job


def test_runner_times_ocr_and_graph_build_separately(tmp_path, monkeypatch):
    job = _run_timed_job(monkeypatch, tmp_path, "graph_memory_concurrent", ocr_s=0.3, extract_s=0.5)
    assert job["status"] == "completed"
    entry = job["successes"][0]
    assert abs(entry["ocr_elapsed_s"] - 0.3) < 0.15
    assert abs(entry["graph_elapsed_s"] - 0.5) < 0.15
    assert entry["ocr_finished_at"] < entry["graph_started_at"]
    assert entry["graph_finished_at"] >= entry["graph_started_at"]
    assert entry["md_db_saved"] is True and entry["md_db_record_id"] == 7
    final = job["progress"]
    assert abs(final["ocr_elapsed_s"] - entry["ocr_elapsed_s"]) < 0.01
    assert abs(final["graph_elapsed_s"] - entry["graph_elapsed_s"]) < 0.01


def test_runner_page_scan_has_no_graph_timer(tmp_path, monkeypatch):
    job = _run_timed_job(monkeypatch, tmp_path, "page_scan", ocr_s=0.1, extract_s=0.2)
    entry = job["successes"][0]
    assert entry["graph_elapsed_s"] == 0.0
    assert entry["graph_started_at"] is None
    assert job["progress"]["graph_elapsed_s"] == 0.0
