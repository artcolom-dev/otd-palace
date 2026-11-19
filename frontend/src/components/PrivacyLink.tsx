import { PRIVACY_HREF } from "../lib/privacy";

/** A link to the privacy notice, for the legal lines and the gate screen. It is a page of the server: a plain link. */
export function PrivacyLink({ className, children = "Privacy" }: { className?: string; children?: string }) {
  return (
    <a className={className ?? "tlink howlink"} href={PRIVACY_HREF}>
      {children}
    </a>
  );
}
