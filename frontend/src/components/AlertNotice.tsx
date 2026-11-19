// The page a notification opened (?open=<listing_id>): when the deal's row is on screen it lights up and nothing needs
// saying; otherwise this says plainly what became of it. "Gone" only when it really is: its auction ended. A deal that
// left the list for another reason (a countdown started, outbid, its price moved) may still be open in Real, and one
// the page has no record of may be anything.
import { useApp } from "../AppContext";
import { goneReasonText, visibleDeals } from "../data/deals";
import { formatRax } from "../lib/format";
import { injuryWords, isBenched } from "../lib/injury";
import { toOpenUrl } from "../lib/openLink";
import { rarityClass } from "../lib/words";
import { Icon } from "./Icon";
import { PlayerAvatar } from "./PlayerAvatar";
import { Twins } from "./Twins";

const userAgent = () => (typeof navigator === "undefined" ? "" : navigator.userAgent);

export function AlertNotice() {
  const { snap, prefs, follows, now, alertListing, dismissAlert, openDeal } = useApp();
  if (alertListing === null) return null;
  const shown = visibleDeals(snap, prefs, follows, now);
  if (shown.some((d) => d.listing_id === alertListing)) return null; // its row is on screen, lit up

  const live = snap.deals.find((d) => d.listing_id === alertListing && Date.parse(d.ends_at) > now) ?? null;
  const was = snap.gone.find((d) => d.listing_id === alertListing) ?? null;
  // A deal that was fine when the alert was sent and whose player ESPN lists as hurt since: this level no longer shows it.
  const hurt = live !== null && snap.levels[prefs.level]?.hide_hurt && isBenched(live.injury) ? injuryWords(live.injury) : null;

  return (
    <section className="alert-note" role="status" aria-label="From your alert">
      <span className="al-mark" aria-hidden="true">
        <Icon name="bell" />
      </span>
      <div className="an-txt">
        {live ? (
          <>
            {hurt ? (
              <>
                <b>This player is hurt now.</b>
                <p>
                  ESPN lists {live.player_name}: {hurt.line}. Your level does not show hurt players' deals; Regular shows them with a tag.
                </p>
              </>
            ) : (
              <b>This deal is outside your level or budget.</b>
            )}
            <p className="an-who">
              <PlayerAvatar sport={live.sport} playerId={live.player_id} name={live.player_name} rarity={rarityClass(live.rarity)} size={28} />
              <span>
                {live.player_name}, {formatRax(live.price)} Rax.
              </span>
            </p>
            <div className="an-act">
              <a
                className="lnk box"
                href={toOpenUrl(live.url, userAgent())}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => openDeal(live, "deals", 0)}
              >
                Open in Real
                <Icon name="ext" />
              </a>
            </div>
          </>
        ) : (
          <>
            {was && was.reason !== "ended" ? (
              <>
                <b>This is no longer a deal</b>
                <p>{goneReasonText(was.reason)}.</p>
                <div className="an-act">
                  <a
                    className="lnk box"
                    href={toOpenUrl(was.url, userAgent())}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={() => openDeal(was, "deals", 0)}
                  >
                    Open in Real
                    <Icon name="ext" />
                  </a>
                </div>
              </>
            ) : was ? (
              <>
                <b>This deal is gone</b>
                <p>Its auction ended.</p>
              </>
            ) : (
              <>
                <b>We no longer list this deal</b>
                <p>It may have sold, ended or stopped being a deal.</p>
              </>
            )}
            <Twins subject={was} />
          </>
        )}
      </div>
      <button type="button" className="icb" aria-label="Dismiss" onClick={dismissAlert}>
        <Icon name="x" />
      </button>
    </section>
  );
}
