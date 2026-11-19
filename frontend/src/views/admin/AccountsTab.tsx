// The admin panel's Accounts tab: the Real accounts looked up on the site (by members and by anonymous devices), how
// often, with each account's size, so the big accounts and the power users stand out.
import { useMemo, useState } from "react";
import { type AccountRow, type AccountsReport, useAdmin } from "./api";
import { LoadNote } from "./MembersTab";
import { Bars, Columns, Section, Tiles, ago, n, short } from "./parts";

type SortKey = "lookups" | "passes" | "year" | "last";
const SORTS: [SortKey, string][] = [
  ["lookups", "Most looked up"],
  ["year", "Biggest yearly figure"],
  ["passes", "Most passes"],
  ["last", "Most recent"],
];
const BIG = new Set(["Big", "Giant"]);

export function sortAccounts(rows: readonly AccountRow[], sort: SortKey, bigOnly: boolean): AccountRow[] {
  return rows
    .filter((r) => !bigOnly || (r.type !== null && BIG.has(r.type)))
    .slice()
    .sort((a, b) => (b[sort] ?? -1) - (a[sort] ?? -1) || a.username.localeCompare(b.username));
}

export function AccountsTab({ fetchImpl, refreshKey }: { fetchImpl: typeof fetch; refreshKey: number }) {
  const [load] = useAdmin<AccountsReport>(`/api/admin/accounts?r=${refreshKey}`, fetchImpl);
  const [sort, setSort] = useState<SortKey>("lookups");
  const [bigOnly, setBigOnly] = useState(false);
  const rows = useMemo(() => (load.kind === "ok" ? sortAccounts(load.data.accounts, sort, bigOnly) : []), [load, sort, bigOnly]);
  if (load.kind !== "ok") return <LoadNote load={load} />;
  const { totals, daily, power, now } = load.data;
  return (
    <>
      <Tiles
        label="Lookups"
        tiles={[
          ["Lookups, 30 days", n(totals.lookups)],
          ["By members", n(totals.by_members)],
          ["Accounts, 30 days", n(totals.accounts)],
          ["Accounts kept", n(load.data.accounts.length)],
        ]}
      />
      <Section title="Lookups a day" note="Accounts read through the site, by UTC day.">
        <Columns
          label="Lookups a day"
          rows={daily.map((d) => ({ key: d.day, tick: short(d.day), parts: [d.lookups], say: `${short(d.day)}: ${d.lookups}` }))}
        />
      </Section>
      <Section title="Who looks up the most" note="Members, by lookups kept.">
        {power.length ? (
          <Bars label="Power users" rows={power.map((p) => ({ name: p.name, value: p.lookups, extra: `${n(p.accounts)} accounts` }))} />
        ) : (
          <p className="adm-note">No member lookup yet.</p>
        )}
      </Section>
      <Section wide title="Accounts looked up" note="Size: passes from the last lookup; yearly figure as the page worked it out (or as its owner's link says).">
        <div className="adm-filters" role="group" aria-label="Sort accounts">
          <select className="adm-input" aria-label="Sort accounts by" value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            {SORTS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
          <label className="adm-check">
            <input type="checkbox" checked={bigOnly} onChange={(e) => setBigOnly(e.target.checked)} /> Big and Giant only
          </label>
        </div>
        <div className="adm-scroll">
          <table className="adm-table" aria-label="Accounts looked up">
            <thead>
              <tr>
                <th scope="col">Account</th>
                <th scope="col">Lookups</th>
                <th scope="col">Members</th>
                <th scope="col">Anon</th>
                <th scope="col">Passes</th>
                <th scope="col">A year</th>
                <th scope="col">Type</th>
                <th scope="col">Linked by</th>
                <th scope="col">Last</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((a) => (
                <tr key={a.username}>
                  <th scope="row">
                    @{a.username}
                    {a.status && a.status !== "ok" ? <span className="adm-faint"> ({a.status.replace("_", " ")})</span> : null}
                  </th>
                  <td>{n(a.lookups)}</td>
                  <td>{n(a.members)}</td>
                  <td>{n(a.anon)}</td>
                  <td>{a.passes === null ? "–" : n(a.passes)}</td>
                  <td>{a.year === null ? "–" : n(a.year)}</td>
                  <td>{a.type ?? "–"}</td>
                  <td>{a.linked_by ?? "–"}</td>
                  <td>{ago(a.last, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </>
  );
}
