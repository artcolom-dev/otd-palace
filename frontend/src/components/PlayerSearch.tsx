import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../AppContext";
import { matchesQuery, visibleDeals } from "../data/deals";
import { plural, sportLabel } from "../lib/words";
import { Icon } from "./Icon";
import { PlayerAvatar } from "./PlayerAvatar";
import { useOverlay } from "./Overlay";
import { SellButton } from "./SellHelper";

/** Desktop: the search field in the top bar; "/" jumps to it, Escape clears it. It filters the deals by player. */
export function SearchBox() {
  const { query, setQuery, navigate } = useApp();
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (e.key === "/" && !typing) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  return (
    <label className="search">
      <Icon name="search" />
      <input
        ref={input}
        type="search"
        value={query}
        placeholder="Search a player"
        aria-label="Search a player" name="player-search"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && query) setQuery("");
          if (e.key === "Enter" && query) navigate("deals");
        }}
      />
      <kbd aria-hidden="true">/</kbd>
    </label>
  );
}

function Results({ close }: { close: () => void }) {
  const { snap, prefs, follows, now, setQuery } = useApp();
  const [q, setQ] = useState("");
  const players = useMemo(() => {
    const seen = new Map<string, { name: string; sport: string; playerId: number; n: number }>();
    const mine = visibleDeals(snap, { ...prefs, sport: "all", rarity: null }, follows, now);
    for (const deal of snap.deals) {
      if (seen.has(deal.player_name) || !matchesQuery(deal, q)) continue;
      seen.set(deal.player_name, {
        name: deal.player_name,
        sport: deal.sport,
        playerId: deal.player_id,
        n: mine.filter((d) => d.player_name === deal.player_name).length,
      });
    }
    return [...seen.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name)).slice(0, 8);
  }, [snap, prefs, follows, now, q]);

  return (
    <>
      <label className="sfield">
        <Icon name="search" />
        <input
          data-autofocus=""
          type="search"
          value={q}
          placeholder="Player name"
          aria-label="Player name" name="player-name"
          autoComplete="off"
          spellCheck={false}
          enterKeyHint="search"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            // The keyboard's Search key takes the top result, as a tap on it would.
            const top = players[0];
            if (e.key !== "Enter" || !q.trim() || !top) return;
            e.preventDefault();
            setQuery(top.name);
            close();
          }}
        />
      </label>
      <div className="sres">
        {players.length === 0 ? (
          <p className="tx">No player called “{q}” in today's deals.</p>
        ) : (
          players.map((p) => (
            <button
              key={p.name}
              type="button"
              className="res"
              onClick={() => {
                setQuery(p.name);
                close();
              }}
            >
              <PlayerAvatar sport={p.sport} playerId={p.playerId} name={p.name} />
              <span>
                <b>{p.name}</b>
                <small>{sportLabel(p.sport)}</small>
              </span>
              <span className="rc">{p.n ? `${plural(p.n, "deal", "deals")} for you` : "no deals for you"}</span>
            </button>
          ))
        )}
      </div>
      <div className="sellrow">
        <SellButton />
      </div>
    </>
  );
}

/** Phone: the search icon in the top bar opens player search as a sheet. */
export function SearchButton() {
  const overlay = useOverlay();
  return (
    <button
      type="button"
      className="icb"
      aria-label="Search a player"
      onClick={(e) =>
        overlay.open({ title: "Find a player", anchor: e.currentTarget, body: ({ close }) => <Results close={close} /> })
      }
    >
      <Icon name="search" />
    </button>
  );
}
