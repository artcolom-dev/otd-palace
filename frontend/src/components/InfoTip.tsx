import { type MouseEvent, type ReactNode, useCallback } from "react";
import { useApp } from "../AppContext";
import { GLOSSARY, type TermKey, explain, shortOf } from "../content/glossary";
import { TERM_HOW } from "../content/how";
import { cls } from "../lib/cls";
import { useOpenHow } from "./HowSheet";
import { Icon } from "./Icon";
import { useOverlay } from "./Overlay";

export interface ExplainVars {
  n?: number;
  fmv?: boolean;
}

/**
 * Opens a term's plain explanation from the element that was clicked: a popover on desktop, a sheet on a phone. A term
 * that has a fuller answer in "How Real works" says so with a link to it, which gives the focus back to the same ⓘ.
 */
export function useExplain() {
  const overlay = useOverlay();
  const openHow = useOpenHow();
  return useCallback(
    (term: TermKey, e: MouseEvent<HTMLElement>, vars: ExplainVars = {}) => {
      e.preventDefault();
      e.stopPropagation();
      const anchor = e.currentTarget;
      const how = TERM_HOW[term];
      overlay.open({
        title: GLOSSARY[term].title,
        anchor,
        body: () => (
          <>
            <p className="poptx">{explain(term, vars)}</p>
            {how && (
              <button type="button" className="tlink how-more" onClick={() => openHow(how, anchor)}>
                How Real works
                <Icon name="arrow" />
              </button>
            )}
          </>
        ),
      });
    },
    [overlay, openHow],
  );
}

/** The ⓘ beside a word. */
/** A term's title inside a sentence: lower case, except Real's own names ("On This Day", "Real Pro", "OTD Palace"). */
export function termWords(title: string): string {
  const names = /\b(On This Day|Real Pro|Real|Quick List|Quick Sell|OTD Palace|Rax)\b/g;
  const kept: string[] = [];
  const marked = title.replace(names, (m) => `\u0000${kept.push(m) - 1}\u0000`);
  return marked.toLowerCase().replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)]!);
}

export function InfoTip({ term, vars, className }: { term: TermKey; vars?: ExplainVars; className?: string }) {
  const explainTerm = useExplain();
  return (
    <button
      type="button"
      className={cls("ib", className)}
      aria-label={`Explain ${termWords(GLOSSARY[term].title)}`}
      title={shortOf(term)}
      onClick={(e) => explainTerm(term, e, vars)}
    >
      <Icon name="info" />
    </button>
  );
}

/**
 * One of Real's words inside a sentence, with its ⓘ right after it: tapped (or clicked), its plain explanation opens, a
 * popover on a desktop and a sheet on a phone; hovered, its one line shows. The button is a real button with a spoken
 * name ("Explain rarity"), so a keyboard and a screen reader reach it. At the Pro level, which reads these words every
 * day, it is the word alone. The word itself stays plain text, so the sentence reads the same with or without the ⓘ.
 */
export function Term({ term, children }: { term: TermKey; children?: ReactNode }) {
  const { prefs } = useApp();
  const word = children ?? termWords(GLOSSARY[term].title);
  if (prefs.level === "pro") return <>{word}</>;
  return (
    <span className="rterm">
      {word}
      <InfoTip term={term} />
    </span>
  );
}

/** The ⓘ alone, after a word the sentence already says (a title, a heading): none at the Pro level, as with Term. */
export function TermTip({ term }: { term: TermKey }) {
  const { prefs } = useApp();
  return prefs.level === "pro" ? null : <InfoTip term={term} />;
}

/** A word that explains itself when tapped: a chip or a tag drawn as a button. */
export function TermButton({
  term,
  className,
  children,
  vars,
  tone,
  label,
}: {
  term: TermKey;
  className: string;
  children: ReactNode;
  vars?: ExplainVars;
  tone?: string;
  label?: string; // what a screen reader says when it is more than the words on the tag
}) {
  const explainTerm = useExplain();
  return (
    <button type="button" className={className} data-tone={tone} aria-label={label} onClick={(e) => explainTerm(term, e, vars)}>
      {children}
    </button>
  );
}
