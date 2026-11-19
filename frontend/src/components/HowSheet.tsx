// "How Real works": its short answers (what Real is, then the ones for players), in a drawer (desktop) or a tall sheet (phone). From the footer, from the ⓘ
// of a word that has a fuller answer here, and from the address (#how, #how/fees). It has a search box; Esc closes it
// and, being modal, it holds the focus while it is open.
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useApp } from "../AppContext";
import { HOW, type HowId, type HowItem, howFromHash, howHash, howSearch } from "../content/how";
import { Icon } from "./Icon";
import { type OverlayContentProps, useOverlay } from "./Overlay";
import { tabPath } from "../lib/tabHint";

function Answers({ items, focus }: { items: HowItem[]; focus: HowId | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // The answer the address or the ⓘ asked for is brought into view once, as the sheet opens.
  useEffect(() => {
    if (focus) ref.current?.querySelector<HTMLElement>(`[data-how="${focus}"]`)?.scrollIntoView?.({ block: "center" });
  }, [focus]);
  return (
    <div ref={ref} className="how-list">
      {items.map((item) => (
        <section key={item.id} id={`how-${item.id}`} data-how={item.id} className="how-item" aria-labelledby={`how-h-${item.id}`}>
          <h3 id={`how-h-${item.id}`}>{item.title}</h3>
          <p>{item.text}</p>
          {item.link && (
            <a className="tlink how-go" href={item.link.href} target="_blank" rel="noopener noreferrer">
              {item.link.label}
              <Icon name="ext" />
            </a>
          )}
        </section>
      ))}
    </div>
  );
}

export function HowSheet({ ctx, id }: { ctx: OverlayContentProps; id: HowId | null }) {
  const { tab } = useApp();
  const [query, setQuery] = useState("");
  const field = useId();
  const tabRef = useRef(tab);
  tabRef.current = tab;
  const items = howSearch(query);

  // The address says where the visitor is while the sheet is open, and goes back to the tab when it closes.
  useEffect(() => {
    history.replaceState(null, "", howHash(id));
    return () => history.replaceState(null, "", `${tabPath(tabRef.current)}${location.search}`);
  }, [id]);

  const search = (
    <div className="how-search">
      <label htmlFor={field} className="sr">
        Search how Real works
      </label>
      <span className="how-box">
        <Icon name="search" />
        <input
          id={field}
          type="search"
          autoComplete="off"
          spellCheck={false}
          placeholder="Search, like fees"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </span>
      <p className="sr" role="status">
        {items.length === 0 ? "No answer matches." : `${items.length} of ${HOW.length} answers shown.`}
      </p>
    </div>
  );
  const list =
    items.length > 0 ? (
      <Answers items={items} focus={query === "" ? id : null} />
    ) : (
      <p className="how-none">Nothing matches. Try “fees”, “countdown” or “passes”.</p>
    );
  const note = <p className="how-note">Real's own rules, in short. Not affiliated with Real.</p>;

  if (ctx.phone) {
    return (
      <div className="hws">
        <span id={ctx.titleId} className="sr">
          How Real works
        </span>
        <div className="dwhd">
          <div className="dwtitle">
            <h2>How Real works</h2>
            <p className="meta">{HOW.length} short answers</p>
          </div>
        </div>
        <div className="dwbody">
          {search}
          {list}
          {note}
        </div>
      </div>
    );
  }
  return (
    <div className="hws">
      <div className="dwhd">
        <div className="dwtitle">
          <h2 id={ctx.titleId}>How Real works</h2>
          <p className="meta">{HOW.length} short answers</p>
        </div>
      </div>
      <div className="dwbody">
        {search}
        {list}
        {note}
      </div>
    </div>
  );
}

/** Opens the sheet (at an answer, when one is named) from `anchor`: focus returns there when it closes. */
export function useOpenHow() {
  const overlay = useOverlay();
  const { layout } = useApp();
  return useCallback(
    (id: HowId | null, anchor: HTMLElement | null) =>
      overlay.open({
        title: "How Real works",
        anchor,
        layer: "panel",
        body: (ctx) => <HowSheet key={id ?? "top"} ctx={{ ...ctx, phone: layout.phone }} id={id} />,
      }),
    [overlay, layout.phone],
  );
}

/** The footer's link. */
export function HowLink({ className }: { className?: string }) {
  const open = useOpenHow();
  return (
    <button type="button" className={className ?? "tlink howlink"} aria-haspopup="dialog" onClick={(e) => open(null, e.currentTarget)}>
      How Real works
    </button>
  );
}

/** Opens the sheet for an address that asks for it (#how, #how/fees), at load and whenever the address changes. */
export function HowFromAddress() {
  const open = useOpenHow();
  const openRef = useRef(open);
  openRef.current = open;
  useEffect(() => {
    const check = () => {
      const want = howFromHash(location.hash);
      if (want) openRef.current(want.id, null);
    };
    check();
    window.addEventListener("hashchange", check);
    return () => window.removeEventListener("hashchange", check);
  }, []);
  return null;
}
