// The admin panel's Discord tab: our server as the bot reads it (GET only): its member count, joins and leaves, the
// messages a day per channel (counts, never the text), the most active people, the reactions on the bot's own posts
// and the roles that changed.
import { type DiscordReport, useAdmin } from "./api";
import { LoadNote } from "./MembersTab";
import { Bars, Columns, DiscordLine, Face, Section, Tiles, ago, n, short, when } from "./parts";

/** What the last round of reading said, in words. */
export function statusWords(status: DiscordReport["status"], now: number): string {
  if (!status) return "The bot has not read the server yet (a first round runs 2 minutes after the server starts, then every 30 minutes).";
  const parts = [`Last read ${ago(status.at, now)}: ${n(status.channels)} channels, ${n(status.messages)} new messages, ${n(status.posts)} bot posts.`];
  if (status.members_list === "refused") {
    parts.push(
      "Discord refuses the bot the member list (the Server Members intent is off in the Developer Portal), so joins come from the welcome messages, leaves and roles from the members who signed in on the site, checked one by one.",
    );
  }
  if (status.error === "limited") parts.push("Discord asked the bot to slow down; the next round picks up where this one stopped.");
  else if (status.error && status.error !== "stopped") parts.push(`The round ended early (${status.error}).`);
  return parts.join(" ");
}

export function DiscordTab({ fetchImpl, refreshKey }: { fetchImpl: typeof fetch; refreshKey: number }) {
  const [load] = useAdmin<DiscordReport>(`/api/admin/discord?r=${refreshKey}`, fetchImpl);
  if (load.kind !== "ok") return <LoadNote load={load} />;
  const d = load.data;
  const joins = d.moves.reduce((a, m) => a + m.joins, 0);
  const leaves = d.moves.reduce((a, m) => a + m.leaves, 0);
  const messages = d.channels.reduce((a, c) => a + c.total, 0);
  const daily = d.days.map((_, i) => d.channels.reduce((a, c) => a + (c.daily[i] ?? 0), 0));
  return (
    <>
      <Tiles
        label="Discord"
        tiles={[
          ["Members now", d.count.length ? n(d.count.at(-1)!.members) : "–"],
          ["Joins", n(joins), `${d.window_days} days`],
          ["Leaves", n(leaves), `${d.window_days} days`],
          ["Messages", n(messages), `${d.window_days} days`],
          ["People known", n(d.known.people), `${n(d.known.present)} seen in`],
          ["Bot posts kept", n(d.post_channels.reduce((a, c) => a + c.posts, 0))],
        ]}
      />
      <p className="adm-note adm-wide adm-status">{statusWords(d.status, d.now)}</p>
      <Section title="Members over time" note="The server's member count, one point a day.">
        <DiscordLine points={d.count} />
      </Section>
      <Section title="Joins and leaves" note="A day each: joins (accent) under leaves (grey). UTC days.">
        <Columns
          label="Joins and leaves a day"
          rows={d.moves.map((m) => ({ key: m.day, tick: short(m.day), parts: [m.joins, m.leaves], say: `${short(m.day)}: ${m.joins} joined, ${m.leaves} left` }))}
        />
      </Section>
      <Section title="Messages a day" note="Every channel together, people only (the bot's posts are apart).">
        <Columns label="Messages a day" rows={d.days.map((day, i) => ({ key: day, tick: short(day), parts: [daily[i] ?? 0], say: `${short(day)}: ${daily[i] ?? 0}` }))} />
      </Section>
      <Section title="Messages by channel" note={`Last ${d.window_days} days; forum posts count under their forum.`}>
        <Bars label="Messages by channel" rows={d.channels.map((c) => ({ name: `#${c.channel}`, value: c.total }))} />
      </Section>
      <Section title="Most active people" note={`Messages in ${d.window_days} days. Site: signed in on the site; linked: has a Real account linked.`}>
        {d.people.length === 0 ? (
          <p className="adm-note">No message from a person yet.</p>
        ) : (
          <ol className="adm-people" aria-label="Most active people">
            {d.people.map((p) => (
              <li key={p.uid}>
                <Face name={p.name} avatar={p.avatar} size={28} />
                <span className="adm-mem-name">{p.name}</span>
                <span className="adm-mem-tags">
                  {p.site && <span className="adm-badge">site</span>}
                  {p.linked && <span className="adm-badge">linked</span>}
                </span>
                <b>{n(p.messages)}</b>
              </li>
            ))}
          </ol>
        )}
      </Section>
      <Section title="Reactions by channel" note="The bot's posts kept, and the reactions they drew on average.">
        <Bars label="Reactions by channel" rows={d.post_channels.map((c) => ({ name: `#${c.channel}`, value: c.reactions, extra: `${c.avg} a post` }))} />
      </Section>
      <Section wide title="The bot's posts" note="The most recent first, with their reactions now.">
        <div className="adm-scroll">
          <table className="adm-table" aria-label="Bot posts">
            <thead>
              <tr>
                <th scope="col">Post</th>
                <th scope="col">Channel</th>
                <th scope="col">Reactions</th>
                <th scope="col">Top</th>
                <th scope="col">Posted</th>
              </tr>
            </thead>
            <tbody>
              {d.posts.map((p) => (
                <tr key={`${p.channel}-${p.ts}-${p.title}`}>
                  <th scope="row" className="adm-wrap">{p.title ?? "(no title)"}</th>
                  <td>#{p.channel}</td>
                  <td>{n(p.reactions)}</td>
                  <td>{p.top ?? "–"}</td>
                  <td>{when(p.ts)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
      <Section title="Roles that changed" note="Seen between two rounds of reading.">
        {d.roles.length === 0 ? (
          <p className="adm-note">No change seen yet.</p>
        ) : (
          <ul className="adm-timeline" aria-label="Role changes">
            {d.roles.map((r, i) => (
              <li key={`${r.ts}-${i}`} className="adm-ev">
                <time dateTime={new Date(r.ts * 1000).toISOString()}>{ago(r.ts, d.now)}</time>
                <span>
                  {r.name} {r.kind === "role+" ? "got" : "lost"} {r.role}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
