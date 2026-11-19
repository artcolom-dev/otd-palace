import { useEffect, useState } from "react";
import { useApp } from "../AppContext";
import { playerKey } from "../data/deals";
import { local } from "../data/local";
import { cls } from "../lib/cls";
import { Icon } from "./Icon";

const POP_MS = 420;

/** The ★ that follows a player on this device; it pops when tapped. Following is for members of our Discord (it feeds
 * their pings and alerts): the free site shows none. */
export function FollowStar({
  player,
  large = false,
}: {
  player: { sport: string; player_id: number; player_name: string };
  large?: boolean;
}) {
  const { follows, toggleFollow, snap, notify } = useApp();
  const on = follows.has(playerKey(player));
  const [pop, setPop] = useState(0);

  useEffect(() => {
    if (!pop) return;
    const t = setTimeout(() => setPop(0), POP_MS);
    return () => clearTimeout(t);
  }, [pop]);

  if (snap.locked) return null;
  return (
    <button
      type="button"
      className={cls("star", large && "lg", pop > 0 && "pop")}
      aria-pressed={on}
      aria-label={`${on ? "Unfollow" : "Follow"} ${player.player_name}`}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        const key = playerKey(player);
        const following = toggleFollow(key);
        setPop((n) => n + 1);
        // Said where the star moves a row away from the finger (the lists); not inside a sheet, which covers the bar.
        if (!e.currentTarget.closest("dialog")) {
          notify({
            text: following ? `Following ${player.player_name}: their deals now come first` : `Stopped following ${player.player_name}`,
            undo: () => {
              if (local.get().follows.includes(key) === following) toggleFollow(key); // as it was, even after a re-tap
            },
          });
        }
      }}
    >
      <Icon key={pop} name="star" />
    </button>
  );
}
