import { useEffect, useState } from "react";
import { local, useLocal } from "../data/local";
import { parseBudget } from "../data/prefs";
import { formatRax } from "../lib/format";

const show = (rax: number | null) => (rax === null ? "" : formatRax(rax));

/**
 * The balance the visitor typed, as text in a field and as a number: every card that asks for it shares the one the
 * device remembers, so typing it in one place fills the others. Text that is not a number keeps its place in its own
 * field (and forgets the balance) until it is fixed.
 */
export function useBalance(): { text: string; balance: number | null; onChange: (value: string) => void } {
  const { balance } = useLocal();
  const [text, setText] = useState(() => show(balance));
  // Another card changed it: this field follows, unless it already says that number.
  useEffect(() => {
    setText((current) => (parseBudget(current) === balance ? current : show(balance)));
  }, [balance]);
  const onChange = (value: string) => {
    setText(value);
    local.setBalance(parseBudget(value));
  };
  return { text, balance: parseBudget(text), onChange };
}
