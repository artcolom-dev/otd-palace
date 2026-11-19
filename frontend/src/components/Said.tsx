// The line under a form or an action that says what just happened ("Copied.", "Unlinked."): one live region that
// stays in the page (so a screen reader hears each new message), and a message that settles in when it arrives. A
// message that is good news draws its check (styles/motion.css); one that says something did not work does not.
import { Icon } from "./Icon";

const FAILED = /\b(not|nothing|could ?n'?t|can'?t|couldn'?t|try again|failed|select)\b/i;

export function Said({ text, className = "impn" }: { text: string; className?: string }) {
  return (
    <p className={className} role="status" aria-live="polite">
      {text && (
        <span key={text} className="said-in">
          {!FAILED.test(text) && <Icon name="check" className="tick" />}
          {text}
        </span>
      )}
    </p>
  );
}
