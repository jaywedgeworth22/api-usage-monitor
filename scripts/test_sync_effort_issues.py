from __future__ import annotations

import copy
import importlib.util
import sys
import unittest
from pathlib import Path


SCRIPT_PATH = Path(__file__).with_name("sync-effort-issues.py")
SPEC = importlib.util.spec_from_file_location("sync_effort_issues", SCRIPT_PATH)
assert SPEC and SPEC.loader
sync = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = sync
SPEC.loader.exec_module(sync)


def marker(key: str) -> str:
    return f"body\n<!-- effort-key: {key} -->"


def issue(number: int, key: str, state: str = "open", labels: tuple[str, ...] = ()) -> dict:
    return {
        "number": number,
        "title": f"issue {number}",
        "body": marker(key),
        "state": state,
        "labels": [{"name": label} for label in labels],
    }


def current_issue(item: object, number: int) -> dict:
    bucket = item.bucket
    state = "open" if bucket in sync.OPEN_BUCKETS else "closed"
    row = issue(number, item.key, state, tuple(sync.desired_labels(bucket)))
    row["title"] = item.title
    row["body"] = sync.build_body(item, "o/r", "sha")
    return row


class FakeClient:
    def __init__(self, issues: list[dict] | None = None, fail_on_update: bool = False):
        self.issues = copy.deepcopy(issues or [])
        self.updates: list[tuple[int, dict]] = []
        self.fail_on_update = fail_on_update

    def list_all_issues(self) -> list[dict]:
        return self.issues

    def create_issue(self, title: str, body: str, labels: list[str], assignee: str | None) -> dict:
        created = issue(len(self.issues) + 100, sync.MARKER_RE.search(body).group(1), labels=tuple(labels))
        created["title"] = title
        created["body"] = body
        self.issues.append(created)
        return created

    def update_issue(self, number: int, fields: dict) -> None:
        if self.fail_on_update:
            raise sync.RateLimitBudgetExhausted("test budget exhausted")
        self.updates.append((number, copy.deepcopy(fields)))
        target = next(row for row in self.issues if row["number"] == number)
        target.update({key: value for key, value in fields.items() if key != "labels"})
        if "labels" in fields:
            target["labels"] = [{"name": label} for label in fields["labels"]]


class ParseBoardTests(unittest.TestCase):
    def test_bare_imperatives_are_rows_but_parenthesized_scaffolding_is_not(self) -> None:
        rows = sync.parse_board(
            "## Planned\n"
            "- Record the release receipt\n"
            "- See rollout notes for the follow-up\n"
            "- (record the effort here when claimed)\n"
            "- (see rollout notes after deployment)\n"
        )
        self.assertEqual([row.first_line for row in rows], [
            "Record the release receipt",
            "See rollout notes for the follow-up",
        ])


class OrphanReconciliationTests(unittest.TestCase):
    def test_open_orphan_closes_and_preserves_custom_labels(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(9, "a" * 40, labels=(sync.MIRROR_LABEL, "state:planned", "priority:p1"))
        client = FakeClient([current_issue(current, 1), orphan])
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        update = next(fields for number, fields in client.updates if number == 9)
        self.assertEqual(update["state"], "closed")
        self.assertEqual(set(update["labels"]), {sync.MIRROR_LABEL, sync.ORPHANED_LABEL, "priority:p1"})
        self.assertEqual(stats["orphaned"], 1)

    def test_closed_completed_orphan_is_untouched(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(9, "b" * 40, "closed", (sync.MIRROR_LABEL, "state:completed"))
        client = FakeClient([current_issue(current, 1), orphan])
        sync.reconcile([current], client, "o/r", "sha", None)
        self.assertFalse(any(number == 9 for number, _ in client.updates))

    def test_closed_open_state_orphan_is_relabelled_only(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(9, "c" * 40, "closed", (sync.MIRROR_LABEL, "state:in-progress"))
        client = FakeClient([current_issue(current, 1), orphan])
        sync.reconcile([current], client, "o/r", "sha", None)
        update = next(fields for number, fields in client.updates if number == 9)
        self.assertNotIn("state", update)
        self.assertIn(sync.ORPHANED_LABEL, update["labels"])

    def test_zero_item_board_never_retires_orphans(self) -> None:
        client = FakeClient([issue(9, "d" * 40, labels=(sync.MIRROR_LABEL, "state:planned"))])
        stats = sync.reconcile([], client, "o/r", "sha", None)
        self.assertEqual(client.updates, [])
        self.assertEqual(stats["orphaned"], 0)

    def test_orphans_are_processed_in_issue_number_order(self) -> None:
        first = sync.BoardItem("planned", "Current row one")
        second = sync.BoardItem("planned", "Current row two")
        client = FakeClient([
            current_issue(first, 1),
            current_issue(second, 2),
            issue(20, "e" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
            issue(3, "f" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
        ])
        sync.reconcile([first, second], client, "o/r", "sha", None)
        orphan_numbers = [number for number, fields in client.updates if fields.get("state") == "closed"]
        self.assertEqual(orphan_numbers, [3, 20])

    def test_nonempty_truncated_board_skips_orphan_retirement(self) -> None:
        current = sync.BoardItem("planned", "Only surviving row")
        client = FakeClient([
            current_issue(current, 1),
            issue(2, "a" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
            issue(3, "b" * 40, labels=(sync.MIRROR_LABEL, "state:planned")),
        ])
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        self.assertEqual(client.updates, [])
        self.assertEqual(stats["orphaned"], 0)

    def test_exact_half_coverage_allows_orphan_retirement(self) -> None:
        current = sync.BoardItem("planned", "Surviving row")
        orphan = issue(2, "c" * 40, labels=(sync.MIRROR_LABEL, "state:planned"))
        client = FakeClient([current_issue(current, 1), orphan])
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        self.assertEqual(stats["orphaned"], 1)
        self.assertTrue(any(number == 2 for number, _ in client.updates))

    def test_already_orphaned_closed_issue_has_no_update_churn(self) -> None:
        current = sync.BoardItem("planned", "Current row")
        orphan = issue(
            2,
            "d" * 40,
            "closed",
            (sync.MIRROR_LABEL, sync.ORPHANED_LABEL, "priority:p2"),
        )
        client = FakeClient([current_issue(current, 1), orphan])
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        self.assertEqual(client.updates, [])
        self.assertEqual(stats["orphaned"], 0)

    def test_returned_key_reopens_and_restores_board_state(self) -> None:
        item = sync.BoardItem("in-progress", "Returned row")
        old = issue(4, item.key, "closed", (sync.MIRROR_LABEL, sync.ORPHANED_LABEL))
        client = FakeClient([old])
        stats = sync.reconcile([item], client, "o/r", "sha", None)
        fields = client.updates[0][1]
        self.assertEqual(fields["state"], "open")
        self.assertEqual(set(fields["labels"]), {sync.MIRROR_LABEL, "state:in-progress"})
        self.assertEqual(stats["reopened"], 1)

    def test_rate_limit_during_orphan_pass_returns_partial(self) -> None:
        orphan = issue(9, "f" * 40, labels=(sync.MIRROR_LABEL, "state:planned"))
        current = sync.BoardItem("planned", "Current row")
        existing_current = current_issue(current, 2)
        client = FakeClient([existing_current, orphan], fail_on_update=True)
        stats = sync.reconcile([current], client, "o/r", "sha", None)
        self.assertIn("test budget exhausted", stats["partial"])


if __name__ == "__main__":
    unittest.main()
