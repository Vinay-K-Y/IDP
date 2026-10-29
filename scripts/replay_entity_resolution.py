#!/usr/bin/env python3
"""
Offline replay of Layer 3 entity resolution on an already-extracted graph snapshot.

The script rebuilds a per-page raw entity stream from a graph snapshot (each node's own
value plus every merged observation) and sorts it by page. Entities are then sent to
GraphMemoryManager.ingest_page_delta() with default thresholds: one PageDelta per page,
containing that page's entities in stable order. The manager resolves them one at a time
in that order, so each entity sees the state left by the entities before it. This matches
how the real pipeline delivers pages. The script reports fragmentation before and after.

No network, no LLM, no AWS calls, and no environment variables are needed. The manager
imports the settings module, which loads .env files on import. To keep those files
unread, this script installs an in-memory settings object that holds the same defaults
as src/config/settings.py for the four graph keys the manager reads. Logging is disabled
so the manager's file logger is not touched.

Usage:
    python scripts/replay_entity_resolution.py <snapshot.json> [--persons-only] [--out replay_report.json]
"""
from __future__ import annotations

import argparse
import asyncio
import collections
import itertools
import json
import logging
import sys
import types
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set

WORKSPACE_ROOT = Path(__file__).resolve().parent.parent
if str(WORKSPACE_ROOT) not in sys.path:
    sys.path.insert(0, str(WORKSPACE_ROOT))

# Install offline settings before the manager is imported. Defaults mirror
# src/config/settings.py (the graph_* fields only).
if "src.config.settings" not in sys.modules:
    _settings_stub = types.ModuleType("src.config.settings")
    _settings_stub.settings = types.SimpleNamespace(
        graph_merge_label_gate=True,
        graph_crosspage_linking=True,
        graph_crosspage_link_max_fanout=3,
        graph_crosspage_link_min_value_len=4,
    )
    sys.modules["src.config.settings"] = _settings_stub

from src.ai.layer3_extraction.graph_agent.memory_manager import (  # noqa: E402
    GraphMemoryManager,
    _person_name_relation,
    _person_name_tokens,
)
from src.ai.layer3_extraction.graph_agent.models import (  # noqa: E402
    GraphNode,
    PageDelta,
    ResolutionStatus,
)

STATUSES = (
    ResolutionStatus.NEW_ENTITY.value,
    ResolutionStatus.CONFIRMED_MATCH.value,
    ResolutionStatus.UNCERTAIN_MATCH.value,
    ResolutionStatus.REJECTED_CONTRADICTION.value,
)
TOP_MERGED = 15
TOP_REASONS = 10


@dataclass
class RawEntity:
    page: int
    type: str
    label: str
    value: str
    origin_node_id: str
    kind: str  # "node_value" or "observation"


def emit(line: str = "") -> None:
    print(line)


def build_raw_stream(nodes: List[Dict[str, Any]], scope: Set[str]) -> List[RawEntity]:
    """One entity per node value (on the node's first page) plus one per observation."""
    raw: List[RawEntity] = []
    for node in nodes:
        ntype = str(node.get("type", ""))
        if ntype.lower() not in scope:
            continue
        label = str(node.get("label") or ntype)
        node_id = str(node.get("id"))
        pages = [int(p) for p in (node.get("source_pages") or [])]
        own_page = min(pages) if pages else 1
        raw.append(RawEntity(own_page, ntype, label, str(node.get("value") or ""), node_id, "node_value"))
        for obs in (node.get("properties") or {}).get("observations") or []:
            raw.append(
                RawEntity(
                    page=int(obs.get("page_number", own_page)),
                    type=ntype,
                    label=str(obs.get("label") or label),
                    value=str(obs.get("value") or ""),
                    origin_node_id=node_id,
                    kind="observation",
                )
            )
    raw.sort(key=lambda r: r.page)  # list.sort is stable
    return raw


def count_by_type(types_: Iterable[str], scope: Set[str]) -> Dict[str, int]:
    counter = collections.Counter(t for t in types_ if t.lower() in scope)
    return dict(sorted(counter.items()))


async def replay(mgr: GraphMemoryManager, raw: List[RawEntity]) -> Dict[str, Any]:
    """Ingest the raw stream page by page through the real path and record every decision."""
    records: List[Dict[str, Any]] = []  # one per ingested entity, in ingest order
    known_ids: Set[str] = set(mgr.graph._nodes)
    original_resolve = mgr.resolve_entity

    def attribute_new_nodes() -> None:
        """A node created by the commit of the previous entity belongs to that entity."""
        nonlocal known_ids
        new_ids = sorted(set(mgr.graph._nodes) - known_ids)
        if new_ids and records:
            records[-1]["created_node_id"] = new_ids[0]
        known_ids |= set(new_ids)

    def capturing_resolve(incoming: GraphNode, page_num: int):
        attribute_new_nodes()
        decision = original_resolve(incoming, page_num=page_num)
        records.append({"incoming_id": incoming.id, "decision": decision, "created_node_id": None})
        return decision

    raw_by_id = {f"replay_{i}": r for i, r in enumerate(raw)}
    skipped_empty = 0

    # Instance attribute shadows the method; ingest_page_delta calls self.resolve_entity,
    # so the real resolver still runs and only its result is recorded.
    mgr.resolve_entity = capturing_resolve  # type: ignore[method-assign]
    try:
        for page, group in itertools.groupby(enumerate(raw), key=lambda pair: pair[1].page):
            entities: List[GraphNode] = []
            for idx, ent in group:
                if not ent.value.strip():
                    skipped_empty += 1
                    continue
                entities.append(
                    GraphNode(
                        id=f"replay_{idx}",
                        type=ent.type,
                        label=ent.label,
                        value=ent.value,
                        properties={"origin_node_id": ent.origin_node_id, "observed_as": ent.kind},
                        source_pages=[ent.page],
                    )
                )
            if not entities:
                continue
            ok = await mgr.ingest_page_delta(PageDelta(page_number=page, entities=entities))
            attribute_new_nodes()
            if not ok:
                raise RuntimeError(f"page {page} was rejected by ingest (checksum conflict)")
    finally:
        mgr.resolve_entity = original_resolve  # type: ignore[method-assign]

    merged_values: Dict[str, List[str]] = collections.defaultdict(list)
    creation_index: Dict[str, int] = {}
    creation_record: Dict[str, Dict[str, Any]] = {}
    decisions: List[Dict[str, Any]] = []
    for rec in records:
        idx = int(rec["incoming_id"].split("_", 1)[1])
        ent = raw_by_id[rec["incoming_id"]]
        decision = rec["decision"]
        created_id = rec["created_node_id"]
        status = decision.status.value

        if status == ResolutionStatus.CONFIRMED_MATCH.value and decision.canonical_id:
            merged_values[decision.canonical_id].append(ent.value)
        elif created_id is not None:
            merged_values[created_id].append(ent.value)
            creation_index[created_id] = idx
            creation_record[created_id] = {
                "status": status,
                "rationale": decision.rationale,
                "contradiction_reasons": list(decision.contradiction_reasons),
            }

        winner = decision.winning_candidate
        decisions.append(
            {
                "index": idx,
                "page": ent.page,
                "type": ent.type,
                "value": ent.value,
                "kind": ent.kind,
                "status": status,
                "resolution_method": decision.resolution_method,
                "winning_candidate_id": winner.candidate_id if winner else None,
                "canonical_id": decision.canonical_id,
                "created_node_id": created_id,
                "candidate_score": decision.candidate_score,
                "second_candidate_score": decision.second_candidate_score,
                "decision_margin": decision.decision_margin,
                "rationale": decision.rationale,
                "contradiction_reasons": list(decision.contradiction_reasons),
            }
        )

    return {
        "decisions": decisions,
        "merged_values": merged_values,
        "creation_index": creation_index,
        "creation_record": creation_record,
        "skipped_empty": skipped_empty,
    }


def top_merged(mgr: GraphMemoryManager, merged_values: Dict[str, List[str]]) -> List[Dict[str, Any]]:
    ranked = sorted(
        mgr.graph._nodes.keys(),
        key=lambda nid: (-len(merged_values.get(nid, [])), nid),
    )[:TOP_MERGED]
    rows = []
    for nid in ranked:
        values = merged_values.get(nid, [])
        rows.append(
            {
                "canonical_id": nid,
                "canonical_value": mgr.graph._nodes[nid].value,
                "merged_source_count": len(values),
                "merged_values": list(dict.fromkeys(values)),
            }
        )
    return rows


def unmerged_same_surname_pairs(
    mgr: GraphMemoryManager,
    creation_index: Dict[str, int],
    creation_record: Dict[str, Dict[str, Any]],
) -> List[Dict[str, Any]]:
    persons = [n for n in mgr.graph._nodes.values() if n.type.lower() == "person"]
    by_surname: Dict[str, List[GraphNode]] = collections.defaultdict(list)
    for node in persons:
        tokens = _person_name_tokens(node.value)
        if tokens:
            by_surname[tokens[-1]].append(node)

    pairs: List[Dict[str, Any]] = []
    for surname in sorted(by_surname):
        group = sorted(by_surname[surname], key=lambda n: n.id)
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                first, second = group[i], group[j]
                # The later-created node plays the incoming role; the earlier one is the candidate.
                if creation_index.get(first.id, -1) > creation_index.get(second.id, -1):
                    later, earlier = first, second
                else:
                    later, earlier = second, first
                _, contra = mgr.check_hard_contradictions(later, earlier)
                score, signals = mgr.score_candidate(later, earlier)
                relation = _person_name_relation(later.value, earlier.value)
                if contra:
                    reason = "hard gate: " + "; ".join(contra)
                elif score < mgr.match_threshold:
                    reason = (
                        f"score {score} below match_threshold {mgr.match_threshold} "
                        f"(signals {signals}, name relation {relation})"
                    )
                else:
                    reason = f"no hard gate; score {score} (signals {signals}, name relation {relation})"
                creation = creation_record.get(later.id, {})
                pairs.append(
                    {
                        "surname": surname,
                        "node_a": {"id": first.id, "value": first.value},
                        "node_b": {"id": second.id, "value": second.value},
                        "pairwise_reason": reason,
                        "later_node_creation_status": creation.get("status"),
                        "later_node_creation_rationale": creation.get("rationale"),
                    }
                )
    return pairs


def main(argv: Optional[List[str]] = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    parser = argparse.ArgumentParser(description="Offline replay of entity resolution on a graph snapshot.")
    parser.add_argument("snapshot", type=Path, help="Graph snapshot JSON with 'nodes' and 'edges'.")
    parser.add_argument("--persons-only", action="store_true", help="Restrict the replay to Person type.")
    parser.add_argument(
        "--out",
        type=Path,
        default=WORKSPACE_ROOT / "replay_report.json",
        help="Path for the JSON report (default: replay_report.json in the workspace root).",
    )
    args = parser.parse_args(argv)

    # Silence the manager's loggers: per-entity INFO lines would flood the summary, and the
    # file handler would write to logs/pipeline.log during an offline measurement.
    logging.disable(logging.CRITICAL)

    snapshot = json.loads(args.snapshot.read_text(encoding="utf-8"))
    nodes = snapshot.get("nodes", [])
    edges = snapshot.get("edges", [])
    scope: Set[str] = {"person"} if args.persons_only else {"person", "organization"}

    raw = build_raw_stream(nodes, scope)
    before_types = count_by_type((str(n.get("type", "")) for n in nodes), scope)
    before_possibly = sum(1 for e in edges if e.get("relationship") == "POSSIBLY_SAME_AS")

    mgr = GraphMemoryManager()
    result = asyncio.run(replay(mgr, raw))

    after_types = count_by_type((n.type for n in mgr.graph._nodes.values()), scope)
    after_uncertain = sum(1 for n in mgr.graph._nodes.values() if n.status == "UNCERTAIN")
    after_possibly = sum(1 for e in mgr.graph._edges.values() if e.relationship == "POSSIBLY_SAME_AS")

    decisions = result["decisions"]
    histogram = {s: 0 for s in STATUSES}
    for d in decisions:
        histogram[d["status"]] = histogram.get(d["status"], 0) + 1

    reason_counter: collections.Counter = collections.Counter()
    category_counter: collections.Counter = collections.Counter()
    for d in decisions:
        if d["status"] == ResolutionStatus.REJECTED_CONTRADICTION.value:
            for r in d["contradiction_reasons"]:
                reason_counter[r] += 1
                category_counter[r.split(":", 1)[0]] += 1
    top_reasons = [{"reason": r, "count": c} for r, c in reason_counter.most_common(TOP_REASONS)]

    merged_rows = top_merged(mgr, result["merged_values"])
    pair_rows = unmerged_same_surname_pairs(mgr, result["creation_index"], result["creation_record"])

    report = {
        "input": str(args.snapshot),
        "persons_only": args.persons_only,
        "scope_types": sorted(scope),
        "thresholds": {"match_threshold": mgr.match_threshold, "ambiguity_margin": mgr.ambiguity_margin},
        "raw_entities_total": len(raw),
        "raw_entities_skipped_empty": result["skipped_empty"],
        "node_counts": {
            "before": before_types,
            "after": after_types,
            "after_uncertain_nodes": after_uncertain,
        },
        "decision_status_histogram": histogram,
        "rejected_contradiction_reasons": {
            "top_10": top_reasons,
            "by_category": dict(category_counter.most_common()),
        },
        "possibly_same_as_edges": {"before": before_possibly, "created": after_possibly},
        "top_merged_canonical": merged_rows,
        "unmerged_same_surname_person_pairs": pair_rows,
        "decisions": decisions,
    }
    args.out.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")

    emit(f"Snapshot: {args.snapshot}  scope={sorted(scope)}  persons_only={args.persons_only}")
    emit(f"Raw entities: {len(raw)} (skipped empty: {result['skipped_empty']})")
    emit("")
    emit("a. Node counts (before -> after):")
    for t in sorted(set(before_types) | set(after_types)):
        emit(f"   {t}: {before_types.get(t, 0)} -> {after_types.get(t, 0)}")
    emit(f"   UNCERTAIN nodes after replay: {after_uncertain}")
    emit("")
    emit("b. Decision status histogram:")
    for s in STATUSES:
        emit(f"   {s}: {histogram[s]}")
    emit(f"   Top {TOP_REASONS} REJECTED_CONTRADICTION reasons:")
    for row in top_reasons:
        emit(f"     {row['count']:>4}  {row['reason']}")
    if not top_reasons:
        emit("     (none)")
    emit(f"   Rejected reasons by category: {dict(category_counter.most_common())}")
    emit("")
    emit(f"c. POSSIBLY_SAME_AS edges: before={before_possibly}, created by replay={after_possibly}")
    emit("")
    emit(f"d. Top {TOP_MERGED} most-merged canonical entities:")
    for row in merged_rows:
        emit(
            f"   [{row['merged_source_count']}] {row['canonical_value']!r} ({row['canonical_id']}) "
            f"merged values: {row['merged_values']}"
        )
    emit("")
    emit(f"e. Canonical Person pairs sharing a surname but not merged: {len(pair_rows)}")
    for p in pair_rows:
        emit(
            f"   surname={p['surname']!r}: {p['node_a']['value']!r} ({p['node_a']['id']}) vs "
            f"{p['node_b']['value']!r} ({p['node_b']['id']})"
        )
        emit(f"       pairwise: {p['pairwise_reason']}")
        emit(
            f"       later node created as {p['later_node_creation_status']}: "
            f"{p['later_node_creation_rationale']}"
        )
    emit("")
    emit(f"Report written to: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
