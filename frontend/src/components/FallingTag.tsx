import { Icon } from "./Icon";
import { TermButton } from "./InfoTip";

/** The red "falling" tag on a deal whose market dropped today; its usual price may be out of date. */
export function FallingTag({ inert = false }: { inert?: boolean }) {
  if (inert) return <span className="falling">falling</span>;
  return (
    <TermButton term="falling" className="falling">
      <Icon name="fall" />
      falling
    </TermButton>
  );
}
