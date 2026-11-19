import { useApp } from "../AppContext";
import { sportLabel } from "../lib/words";
import { listed } from "./CoverageNote";

/**
 * Two quiet lines under the deals about ESPN's injury notes, so neither a hidden deal nor a missing tag is a silent
 * choice: how many deals this visitor's level left out because the player is hurt (`hidden`, counted as the list counts
 * its own rows; New hides them, the others show them with a tag), and which sports the notes cover ("no tag" is not "healthy"). Nothing while the server sent no
 * list: the sample data, or ESPN out of reach.
 */
export function InjuryNotes({ hidden }: { hidden: number }) {
  const { snap } = useApp();
  const sports = snap.rules.injury_sports ?? [];
  if (sports.length === 0) return null;
  return (
    <>
      {hidden > 0 && (
        <p className="hurtnote" data-testid="hurt-note">
          {hidden === 1 ? "1 deal is hidden because its player is hurt." : `${hidden} deals are hidden because their players are hurt.`}{" "}
          Regular shows {hidden === 1 ? "it" : "them"} with a tag.
        </p>
      )}
      <p className="injcov" data-testid="injury-coverage">
        Injury notes come from ESPN and cover {listed(sports.map(sportLabel))} only. No tag does not mean healthy.
      </p>
    </>
  );
}
