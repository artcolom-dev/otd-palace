import { useState } from "react";
import { local } from "../../data/local";
import { bestPlayersToFollow } from "../../lib/profileCard";
import { usePassPlan } from "../../views/passState";
import { Icon } from "../Icon";

const HOW_MANY = 20;

/** After passes are loaded: follow the players behind the ones that pay most, so their deals come to the top. */
export function FollowMyBest() {
  const { plan } = usePassPlan();
  const [done, setDone] = useState<number | null>(null);
  const keys = bestPlayersToFollow(plan, HOW_MANY);
  const fresh = keys.filter((k) => !local.get().follows.includes(k));
  if (keys.length === 0 || (fresh.length === 0 && done === null)) return null;
  const run = () => {
    for (const k of fresh) local.toggleFollow(k);
    setDone(fresh.length);
  };
  return (
    <div className="shm">
      {done === null ? (
        <button type="button" className="lnk box" onClick={run}>
          <Icon name="star" />
          Follow my {fresh.length} best {fresh.length === 1 ? "player" : "players"}
        </button>
      ) : (
        <p className="impn" role="status">
          Following {done} {done === 1 ? "player" : "players"}: their deals come first.
        </p>
      )}
    </div>
  );
}
