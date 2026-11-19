import { Icon } from "./Icon";

export function Brand() {
  return (
    <div className="brand">
      <span className="mark" aria-hidden="true">
        <Icon name="palace" />
      </span>
      <span className="bn">OTD Palace</span>
    </div>
  );
}
