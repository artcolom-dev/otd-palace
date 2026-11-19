// "Link your Real account" at the top of My passes: the field, or once linked the link's state (Refresh, Unlink),
// with the small "Look up someone else". The live feed and the sample data's sample accounts only.
import { useApp } from "../../AppContext";
import { useLocal } from "../../data/local";
import { canLink } from "../../lib/link";
import { LinkBox } from "../AccountLookup";

// The reading of an account lives in lib/accountPasses; these stay importable from here.
export { fetchPasses, importWords } from "../../lib/accountPasses";

export function ImportPasses() {
  const { snap } = useApp();
  const { link } = useLocal();
  if (!canLink(snap)) return null;
  return (
    <div className="imp">
      <p className="imp-h">{link ? "Your Real account" : "Link your Real account"}</p>
      <LinkBox />
    </div>
  );
}
