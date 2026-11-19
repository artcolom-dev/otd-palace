// The admin panel's Sources tab: from the first touch (a campaign tag, a referring site, or direct) to a sign-in, a
// linked Real account and still coming back at D7, by the devices first seen in the last 90 days.
import { type SourcesReport, useAdmin } from "./api";
import { LoadNote } from "./MembersTab";
import { Bars, Section, n, pct } from "./parts";

export function SourcesTab({ fetchImpl, refreshKey }: { fetchImpl: typeof fetch; refreshKey: number }) {
  const [load] = useAdmin<SourcesReport>(`/api/admin/sources?r=${refreshKey}`, fetchImpl);
  if (load.kind !== "ok") return <LoadNote load={load} />;
  const { sources, window_days: windowDays } = load.data;
  return (
    <>
      <Section wide title="First touch to staying" note={`Devices first seen in the last ${windowDays} days, by how they first came. D7: came back 7 days after their first visit or later, over the devices whose day 7 has come.`}>
        {sources.length === 0 ? (
          <p className="adm-note">No device yet.</p>
        ) : (
          <div className="adm-scroll">
            <table className="adm-table" aria-label="Sources">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th scope="col">Devices</th>
                  <th scope="col">Signed in</th>
                  <th scope="col">Linked</th>
                  <th scope="col">D7</th>
                  <th scope="col">Members</th>
                </tr>
              </thead>
              <tbody>
                {sources.map((s) => (
                  <tr key={s.key}>
                    <th scope="row">{s.key}</th>
                    <td>{n(s.devices)}</td>
                    <td>
                      {n(s.signed_in)} <span className="adm-faint">{pct(s.signed_in, s.devices)}</span>
                    </td>
                    <td>
                      {n(s.linked)} <span className="adm-faint">{pct(s.linked, s.devices)}</span>
                    </td>
                    <td>{pct(s.d7, s.d7_ready)}</td>
                    <td>{n(s.members)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="adm-note">Share links as otdpalace.com/?ref=name to see a channel of its own here.</p>
      </Section>
      <Section title="Sign-ins by source" note="The share of each source's devices that signed in.">
        <Bars label="Sign-ins by source" rows={sources.map((s) => ({ name: s.key, value: s.signed_in, extra: pct(s.signed_in, s.devices) }))} />
      </Section>
      <Section title="Linked by source" note="The share of each source's devices whose member linked a Real account.">
        <Bars label="Linked by source" rows={sources.map((s) => ({ name: s.key, value: s.linked, extra: pct(s.linked, s.devices) }))} />
      </Section>
    </>
  );
}
