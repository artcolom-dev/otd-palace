import { useLayoutEffect, useRef } from "react";

/**
 * A ref whose element carries the custom property `name` = `value`, set through the CSSOM (never a style attribute,
 * so the page keeps a strict CSP). A bar's height or a fill's width read it in the style sheet.
 */
export function useCssVar<T extends HTMLElement>(name: string, value: string) {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    ref.current?.style.setProperty(name, value);
  }, [name, value]);
  return ref;
}
