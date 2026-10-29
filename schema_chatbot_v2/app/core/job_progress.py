"""
Page-level OCR progress for pipeline jobs.

The tracker is the only writer of a job's progress. Every mutation runs under
one lock and then replaces job["progress"] with a new dict. Readers therefore
see either the old snapshot or the new one, never a partly written one.

Timing uses a monotonic clock. Paused time is excluded from elapsed time and
from the OCR and graph timers, so pauses do not distort the per-page rate used
for the ETA.

Two timers are kept apart:
- OCR time runs from begin_ocr() to finish_ocr(), which is called as soon as
  process_document() returns. Saving the output and the RDS write are not OCR.
- Graph time runs from begin_graph() to finish_graph(), which wraps the Layer 3
  call for graph_memory strategies.

Each timer is driven by its own flag, not by the phase label. A kill request
changes the label to 'killed' while the current document still runs, and the
timer keeps counting until the document's step really ends.

Elapsed time and ETA are computed when read (see JobProgressTracker.live), not
when a page finishes, so the timer keeps moving during a long page.

Progress is per page. One page is one blocking OCR call, so no finer progress
is reported.
"""
from __future__ import annotations

import math
import threading
import time
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional, Sequence

PHASES = ("queued", "rendering", "ocr", "saving", "graph_building", "extracting", "finished", "killed")

# Phases in which the page-count ETA is meaningful.
ETA_PHASES = ("rendering", "ocr", "extracting")

# The ETA is shown only after this many pages and this much OCR time. Before
# that, a rate estimate is too noisy to show.
ETA_MIN_PAGES_DONE = 2
ETA_MIN_OCR_SECONDS = 3.0

Clock = Callable[[], float]
NowIso = Callable[[], str]


def _now_iso() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds")


class JobProgressTracker:
    def __init__(self, clock: Clock = time.monotonic, now_iso: NowIso = _now_iso) -> None:
        self._lock = threading.Lock()
        self._clock = clock
        self._now_iso = now_iso
        self._job: Optional[Dict[str, Any]] = None
        self._doc_pages: List[int] = []  # planned page count per document
        self._doc_index = -1
        self._tick: Optional[float] = None  # clock value at last fold; None when stopped
        self._active_s = 0.0  # running time, pauses excluded
        self._ocr_s = 0.0  # OCR time across all documents, pauses excluded
        self._graph_s = 0.0  # graph-build time across all documents, pauses excluded
        self._doc_ocr_s = 0.0  # OCR time of the current document
        self._doc_graph_s = 0.0  # graph-build time of the current document
        self._ocr_active = False  # OCR timer is running
        self._graph_active = False  # graph timer is running
        self._paused_total_s = 0.0
        self._pause_requested = False  # pause asked for; the worker may still be busy
        self._idle = False  # worker is parked between documents because of the pause
        self._kill_requested = False  # kill asked for; the current document may still be running
        self._state: Dict[str, Any] = {
            "phase": "queued",
            "pages_total": 0,
            "pages_done": 0,
            "pages_skipped": 0,
            "current_doc": None,
            "current_doc_pages_total": 0,
            "current_doc_pages_done": 0,
            "docs_total": 0,
            "docs_done": 0,
            "started_at": None,
            "updated_at": None,
            "paused_since": None,
            "paused_total_s": 0.0,
            "ocr_s": 0.0,
            "ocr_started_at": None,
            "ocr_finished_at": None,
            "graph_started_at": None,
            "graph_finished_at": None,
        }

    # ------------------------------------------------------------------ wiring

    def attach(self, job: Dict[str, Any]) -> None:
        """Bind this tracker to a job dict and publish the current snapshot."""
        with self._lock:
            self._job = job
            self._publish_locked()

    def is_attached_to(self, job: Dict[str, Any]) -> bool:
        return self._job is job

    # ------------------------------------------------------------ worker side

    def start_job(self, pages_per_doc: Sequence[int]) -> None:
        """Set the job totals. pages_per_doc is the page count of each target, from PDF metadata."""
        with self._lock:
            now = self._clock()
            self._doc_pages = [max(0, int(n)) for n in pages_per_doc]
            self._state["docs_total"] = len(self._doc_pages)
            self._state["pages_total"] = sum(self._doc_pages)
            self._state["started_at"] = self._now_iso()
            self._tick = now
            self._touch_locked()
            self._publish_locked()

    def start_doc(self, name: str) -> None:
        with self._lock:
            self._fold_locked(self._clock())
            self._doc_index += 1
            self._doc_ocr_s = 0.0
            self._doc_graph_s = 0.0
            planned = self._doc_pages[self._doc_index] if self._doc_index < len(self._doc_pages) else 0
            self._state.update(
                phase=self._phase_unless_killed("rendering"),
                current_doc=name,
                current_doc_pages_total=planned,
                current_doc_pages_done=0,
                ocr_started_at=None,
                ocr_finished_at=None,
                graph_started_at=None,
                graph_finished_at=None,
            )
            self._touch_locked()
            self._publish_locked()

    def begin_ocr(self, pages_in_doc: int) -> None:
        """Called once the PDF is rendered. Replaces the planned count with the real one and starts the OCR timer."""
        with self._lock:
            self._fold_locked(self._clock())
            actual = max(0, int(pages_in_doc))
            planned = self._state["current_doc_pages_total"]
            self._state["pages_total"] += actual - planned
            self._state["current_doc_pages_total"] = actual
            self._state["current_doc_pages_done"] = 0
            self._state["phase"] = self._phase_unless_killed("ocr")
            self._ocr_active = True
            self._state["ocr_started_at"] = self._now_iso()
            self._touch_locked()
            self._publish_locked()

    def page_done(self, page_number: Optional[int] = None) -> None:
        """Count one finished page. Safe to call from several worker threads."""
        with self._lock:
            self._fold_locked(self._clock())
            s = self._state
            if s["current_doc_pages_done"] < s["current_doc_pages_total"]:
                s["current_doc_pages_done"] += 1
                s["pages_done"] += 1
            self._touch_locked()
            self._publish_locked()

    def finish_ocr(self) -> None:
        """OCR for the current document returned. Stops the OCR timer; saving the output is not OCR time."""
        with self._lock:
            self._fold_locked(self._clock())
            self._stop_ocr_locked()
            self._state["phase"] = self._phase_unless_killed("saving")
            self._touch_locked()
            self._publish_locked()

    def begin_graph(self) -> None:
        """Layer 3 graph build starts for the current document. Starts the graph timer."""
        with self._lock:
            self._fold_locked(self._clock())
            self._graph_active = True
            self._state["graph_started_at"] = self._now_iso()
            self._state["phase"] = self._phase_unless_killed("graph_building")
            self._touch_locked()
            self._publish_locked()

    def finish_graph(self) -> None:
        """Layer 3 graph build ended, successfully or not. Stops the graph timer."""
        with self._lock:
            self._fold_locked(self._clock())
            self._stop_graph_locked()
            self._state["phase"] = self._phase_unless_killed("saving")
            self._touch_locked()
            self._publish_locked()

    def begin_extract(self) -> None:
        """Layer 3 field extraction for a page_scan strategy. It has no graph timer."""
        with self._lock:
            self._fold_locked(self._clock())
            self._state["phase"] = self._phase_unless_killed("extracting")
            self._touch_locked()
            self._publish_locked()

    def doc_timing(self) -> Dict[str, Any]:
        """Timing of the current document, for its entry in successes or failures."""
        with self._lock:
            self._fold_locked(self._clock())
            s = self._state
            return {
                "ocr_elapsed_s": round(self._doc_ocr_s, 1),
                "graph_elapsed_s": round(self._doc_graph_s, 1),
                "ocr_started_at": s["ocr_started_at"],
                "ocr_finished_at": s["ocr_finished_at"],
                "graph_started_at": s["graph_started_at"],
                "graph_finished_at": s["graph_finished_at"],
            }

    def finish_doc(self) -> None:
        """Called when a document ends, whether it succeeded or failed.

        Pages that were planned but never OCR'd are removed from pages_total and
        counted as skipped, so the percentage reflects the work actually done.
        Any timer still running (for example after an exception) is stopped here.
        """
        with self._lock:
            self._fold_locked(self._clock())
            self._stop_ocr_locked()
            self._stop_graph_locked()
            s = self._state
            remaining = max(0, s["current_doc_pages_total"] - s["current_doc_pages_done"])
            if remaining:
                s["pages_total"] -= remaining
                s["pages_skipped"] += remaining
                s["current_doc_pages_total"] -= remaining
            s["docs_done"] += 1
            # The document is over, whether OCR succeeded or failed. Leave the
            # per-document phase so the status does not still say 'OCR running'
            # while the next document is being prepared.
            s["phase"] = self._phase_unless_killed("queued")
            self._touch_locked()
            self._publish_locked()

    def finish(self, phase: str) -> None:
        """Set the terminal phase ('finished' or 'killed') and stop the clock."""
        if phase not in ("finished", "killed"):
            raise ValueError(f"invalid terminal phase: {phase}")
        with self._lock:
            self._fold_locked(self._clock())
            self._stop_ocr_locked()
            self._stop_graph_locked()
            if phase == "killed":
                # Documents that never started will not be OCR'd. Move their pages to skipped.
                unstarted = sum(self._doc_pages[self._doc_index + 1 :])
                if unstarted:
                    self._state["pages_total"] -= unstarted
                    self._state["pages_skipped"] += unstarted
            self._state["phase"] = phase
            self._pause_requested = False
            self._idle = False
            self._state["paused_since"] = None
            self._tick = None
            self._touch_locked()
            self._publish_locked()

    # ----------------------------------------------------- pause / resume / kill

    def pause(self) -> None:
        """Pause was requested. The worker only pauses between documents.

        Until the worker parks (mark_waiting), the job is 'pausing': the current
        document keeps running and the clock keeps ticking.
        """
        with self._lock:
            self._pause_requested = True
            self._touch_locked()
            self._publish_locked()

    def mark_waiting(self) -> None:
        """Called by the worker when it parks between documents because of a pause."""
        with self._lock:
            if not self._pause_requested or self._idle:
                return
            self._fold_locked(self._clock())
            self._idle = True
            self._state["paused_since"] = self._now_iso()
            self._touch_locked()
            self._publish_locked()

    def resume(self) -> None:
        with self._lock:
            if not self._pause_requested:
                return
            self._fold_locked(self._clock())
            self._pause_requested = False
            self._idle = False
            self._state["paused_since"] = None
            self._touch_locked()
            self._publish_locked()

    def kill_requested(self) -> None:
        """Kill was requested. The current document keeps running until it ends.

        The clock keeps running until finish('killed') is called by the worker.
        """
        with self._lock:
            self._fold_locked(self._clock())
            self._kill_requested = True
            self._pause_requested = False
            self._idle = False
            self._state["paused_since"] = None
            self._state["phase"] = "killed"
            self._touch_locked()
            self._publish_locked()

    def _phase_unless_killed(self, phase: str) -> str:
        """A kill request keeps the phase at 'killed' while the current document finishes."""
        return "killed" if self._kill_requested else phase

    # ------------------------------------------------------------------ readers

    def live(self, now: Optional[float] = None) -> Dict[str, Any]:
        """Return a copy of the state with elapsed times and eta_s computed at read time."""
        with self._lock:
            t = self._clock() if now is None else now
            s = dict(self._state)
            running_clock = self._tick is not None
            partial = max(0.0, t - self._tick) if running_clock else 0.0
            clock_live = running_clock and not self._idle

            active = self._active_s + (partial if clock_live else 0.0)
            ocr = self._ocr_s + (partial if clock_live and self._ocr_active else 0.0)
            graph = self._graph_s + (partial if clock_live and self._graph_active else 0.0)
            paused_total = self._paused_total_s + (partial if running_clock and self._idle else 0.0)

            pages_total = s["pages_total"]
            pages_done = s["pages_done"]
            eta: Optional[float] = None
            if (
                clock_live
                and s["started_at"] is not None
                and s["phase"] in ETA_PHASES
                and pages_total > 0
            ):
                if pages_done >= pages_total:
                    eta = 0.0
                elif pages_done >= ETA_MIN_PAGES_DONE and ocr >= ETA_MIN_OCR_SECONDS:
                    per_page = ocr / pages_done
                    eta = (pages_total - pages_done) * per_page
                    if not math.isfinite(eta) or eta < 0:
                        eta = None

            # Stopping: kill was requested, but the worker has not exited yet.
            s["stopping"] = bool(self._kill_requested and running_clock)
            s["elapsed_s"] = round(active, 1) if s["started_at"] is not None else None
            s["eta_s"] = round(eta) if eta is not None else None
            s["ocr_s"] = round(ocr, 1)
            s["ocr_elapsed_s"] = round(ocr, 1)
            s["graph_elapsed_s"] = round(graph, 1)
            s["paused_total_s"] = round(paused_total, 1)
            s["server_now"] = self._now_iso()
            return s

    # ------------------------------------------------------------------ helpers

    def _fold_locked(self, now: float) -> None:
        """Add the time since the last fold to the counters (caller holds the lock)."""
        if self._tick is None:
            return
        dt = max(0.0, now - self._tick)
        self._tick = now
        if self._idle:
            self._paused_total_s += dt
            return
        self._active_s += dt
        if self._ocr_active:
            self._ocr_s += dt
            self._doc_ocr_s += dt
        if self._graph_active:
            self._graph_s += dt
            self._doc_graph_s += dt

    def _stop_ocr_locked(self) -> None:
        if self._ocr_active:
            self._ocr_active = False
            self._state["ocr_finished_at"] = self._now_iso()

    def _stop_graph_locked(self) -> None:
        if self._graph_active:
            self._graph_active = False
            self._state["graph_finished_at"] = self._now_iso()

    def _touch_locked(self) -> None:
        self._state["updated_at"] = self._now_iso()

    def _publish_locked(self) -> None:
        """Write a new progress dict onto the job. Never mutate the old dict in place."""
        if self._job is None:
            return
        snapshot = dict(self._state)
        snapshot["ocr_s"] = round(self._ocr_s, 1)
        snapshot["ocr_elapsed_s"] = round(self._ocr_s, 1)
        snapshot["graph_elapsed_s"] = round(self._graph_s, 1)
        snapshot["paused_total_s"] = round(self._paused_total_s, 1)
        self._job["progress"] = snapshot


def progress_view(job: Dict[str, Any], tracker: Optional[JobProgressTracker]) -> Optional[Dict[str, Any]]:
    """Live progress for an API response, or None when the job has no tracker (legacy jobs)."""
    if tracker is None or not tracker.is_attached_to(job):
        return None
    return tracker.live()


def compact_progress(view: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    """The subset of progress that list rows need."""
    if view is None:
        return None
    return {
        "phase": view["phase"],
        "pages_done": view["pages_done"],
        "pages_total": view["pages_total"],
        "pages_skipped": view["pages_skipped"],
        "docs_done": view["docs_done"],
        "docs_total": view["docs_total"],
        "elapsed_s": view["elapsed_s"],
        "eta_s": view["eta_s"],
        "paused_since": view["paused_since"],
        "stopping": view["stopping"],
        "ocr_elapsed_s": view["ocr_elapsed_s"],
        "graph_elapsed_s": view["graph_elapsed_s"],
        "ocr_started_at": view["ocr_started_at"],
        "ocr_finished_at": view["ocr_finished_at"],
        "graph_started_at": view["graph_started_at"],
        "graph_finished_at": view["graph_finished_at"],
        "server_now": view["server_now"],
    }
