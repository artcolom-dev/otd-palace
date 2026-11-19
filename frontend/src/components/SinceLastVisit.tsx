// "Since your last visit": what changed for the players followed, worked out on this device from the time it last
// left the site.
import { useMemo } from "react";
import { useApp } from "../AppContext";
import { sinceLastVisit, sinceText } from "../data/returns";
import { Icon } from "./Icon";
import { PlayerAvatar } from "./PlayerAvatar";

/**
 * Above the hero: what changed for the followed players since the last visit, led by the face of the player who
 * moved (else the star of the players followed). Dismissed for this visit.
 */
export function SinceLastVisit() {
  const { snap, prefs, follows, now, previousVisit, sinceDismissed, dismissSince, setPrefs, navigate } = useApp();
  const news = useMemo(
    () => sinceLastVisit(snap, prefs, follows, now, previousVisit),
    [snap, prefs, follows, now, previousVisit],
  );
  if (!news || sinceDismissed) return null;
  return (
    <div className="since" role="note" aria-label="Since your last visit">
      {news.move ? (
        <PlayerAvatar sport={news.move.sport} playerId={news.move.player_id} name={news.move.player_name} size={28} />
      ) : (
        <Icon name="star" />
      )}
      <p>
        <b>Since your last visit:</b> {sinceText(news)}
      </p>
      {news.deals > 0 && (
        <button
          type="button"
          className="lnk"
          onClick={() => {
            setPrefs({ sport: "mine" });
            navigate("deals");
          }}
        >
          Show them
        </button>
      )}
      <button type="button" className="icb x" aria-label="Dismiss" onClick={dismissSince}>
        <Icon name="x" />
      </button>
    </div>
  );
}
