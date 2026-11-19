"""The account types on the server (advisor/account_types.py) are the site's (frontend/src/content/accountTypes.ts):
same names, brackets, colours and lines, so a Discord role reads like the page that earned it."""

import re
from pathlib import Path

from advisor import account_types as at
from advisor import real

ROOT = Path(__file__).resolve().parents[1]
TS = (ROOT / "frontend/src/content/accountTypes.ts").read_text(encoding="utf-8")


def _ts_types() -> list[dict]:
    body = TS[TS.index("export const ACCOUNT_TYPES"):TS.index("/** The words after")]
    out = []
    for entry in re.findall(r"\{\s*key:.*?\n  \},", body, re.S):
        row = {}
        for key, value in re.findall(r'(\w+): ("(?:[^"\\]|\\.)*"|[\d_]+|null),', entry):
            row[key] = None if value == "null" else value[1:-1] if value.startswith('"') else int(value.replace("_", ""))
        out.append(row)
    return out


def test_the_table_is_the_sites_to_the_letter():
    ts = _ts_types()
    assert len(ts) == len(at.ACCOUNT_TYPES) == 6
    for site, server in zip(ts, at.ACCOUNT_TYPES):
        assert site == {"key": server.key, "name": server.name, "from": server.from_, "to": server.to, "color": server.color,
                        "meaning": server.meaning, "do": server.do, "skip": server.skip, "watch": server.watch}


def test_the_brackets_run_without_a_gap_from_nothing_to_the_top():
    types = at.ACCOUNT_TYPES
    assert types[0].from_ == 0 and types[-1].to is None
    assert [t.to for t in types[:-1]] == [t.from_ for t in types[1:]]
    assert [t.name for t in types] == ["Not earning yet", "Starter", "Steady", "Strong", "Big", "Giant"]


def test_the_colours_climb_reals_rarity_ladder():
    colors = [t.color for t in at.ACCOUNT_TYPES]
    assert colors == sorted(set(colors)) and max(colors) < len(real.RARITY_NAMES)


def test_a_figure_lands_in_its_bracket():
    name = lambda y: at.type_of(y).name  # noqa: E731
    assert [name(y) for y in (0, 0.4, None, "x", True, -3, float("nan"), float("inf"))] == ["Not earning yet"] * 8
    assert [name(y) for y in (1, 2900, 9999)] == ["Starter"] * 3
    assert [name(y) for y in (10_000, 48_000)] == ["Steady"] * 2
    assert [name(y) for y in (100_000, 499_999)] == ["Strong"] * 2
    assert [name(y) for y in (500_000, 1_999_999)] == ["Big"] * 2
    assert [name(y) for y in (2_000_000, 6.2e6, 5e9)] == ["Giant"] * 3
    assert at.next_type(2900).name == "Steady" and at.next_type(3e6) is None


def test_without_a_reported_year_the_number_of_passes_stands_in():
    name = lambda n: at.type_by_passes(n).name  # noqa: E731
    assert [name(n) for n in (0, None, -1)] == ["Not earning yet"] * 3
    assert [name(n) for n in (1, 24, 99)] == ["Starter"] * 3
    assert [name(n) for n in (100, 299)] == ["Steady"] * 2
    assert [name(n) for n in (300, 499)] == ["Strong"] * 2
    assert [name(n) for n in (500, 5000)] == ["Big"] * 2


def test_the_watch_lines_say_how_a_pass_really_stops_paying():
    """the internal research notes, 3b and 4f. The passes Real flags with a cap of 0 ("spent") are all
    Generals (35,583 of 35,583): nothing to sell, nothing that "reached" anything. What does stop a pass is its lifetime
    limit, and the limit counts all the pass has earned, live pay included: no pass at or over its cap claimed (0 of 392
    passes of the 2025 NFL season on an NFL anniversary, against 75 of 1,080 under it), and a lift reopened the 10 that did."""
    by_key = {t.key: t for t in at.ACCOUNT_TYPES}
    for t in at.ACCOUNT_TYPES:
        for line in (t.meaning, t.do, t.skip, t.watch):
            assert "spent pass" not in line.lower() and "sell them" not in line.lower(), (t.name, line)
    for key in ("steady", "big"):
        assert "limit" in by_key[key].watch and "live pay included" in by_key[key].watch, by_key[key].watch
    assert "reopens" in by_key["big"].watch


def test_no_line_says_the_accounts_read_fail_to_collect():
    """the internal research notes, 4a: between two reads of the same accounts 90 % of the Giant ones had
    claimed within hours of Real's daily turnover (70 % of those with no automatic claim), and each claim paid what the
    planner expects. "Most of the pay is never collected" read a tool's ledger as if it were the account."""
    for t in at.ACCOUNT_TYPES:
        for line in (t.meaning, t.do, t.skip, t.watch):
            assert not re.search(r"never collected|make sure you collect", line.lower()), (t.name, line)
    giant = at.ACCOUNT_TYPES[-1]
    assert "3,380" in giant.do  # what the Giant accounts do: lift to the door of Iconic


def test_half_a_rax_rounds_up_as_the_sites_table_does():
    # JavaScript's Math.round(0.5) is 1, Python's round(0.5) is 0: the same figure must give the same type on both.
    from advisor.account_types import type_of

    assert type_of(0.5).key == "starter"
    assert type_of(0.49).key == "none"
    assert type_of(9999.5).key == "steady"
