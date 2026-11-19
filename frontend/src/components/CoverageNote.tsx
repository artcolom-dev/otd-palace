import { useApp } from "../AppContext";
import { sportLabel } from "../lib/words";

/** "MLB", "MLB and WNBA", "MLB, WNBA and UFC". */
export const listed = (labels: string[]) =>
  labels.length < 2 ? labels.join("") : `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;

export const PARTIAL_LISTINGS =
  "We follow every player of each sport: the top ones about every half hour, the rest every few days, so a new deal can take a while to show.";

/** True while the live feed says it may be missing some open listings. */
export function useListingsPartial(): boolean {
  return useApp().snap.rules.coverage?.listings_complete === false;
}

/**
 * What the live feed rests on, said where deals are listed: the sports it reads that have no open listing right now
 * (so a missing tab is not a bug), and that its listings may be partial. Nothing on the sample data, which carries
 * no coverage, and nothing while the feed has it all.
 */
export function CoverageNote() {
  const { snap } = useApp();
  const coverage = snap.rules.coverage;
  const partial = useListingsPartial();
  if (!coverage) return null;
  const quiet = coverage.sports.filter((sport) => !snap.sports.includes(sport)).map(sportLabel);
  return (
    <>
      {quiet.length > 0 && <p data-coverage="quiet">No open listings in {listed(quiet)} right now.</p>}
      {partial && <p data-coverage="partial">{PARTIAL_LISTINGS}</p>}
    </>
  );
}
