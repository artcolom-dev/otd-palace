import { type MouseEvent, useCallback, useEffect, useState } from "react";
import { useApp } from "../AppContext";
import type { Deal } from "../data/types";
import { formatRax } from "../lib/format";
import { useOverlay } from "./Overlay";
import { ShareButton } from "./ShareButton";

interface Code {
  url: string;
  d: string;
  viewBox: string;
}

/**
 * The auction as a QR code, so a visitor at a computer can open it in the Real app on their phone. The generator
 * (about 20 KB gzipped) is fetched when the first code is asked for, not with the page: most visitors never open one.
 * The frame has its size from the start, so nothing moves when the code arrives.
 */
export function QrCode({ url }: { url: string }) {
  const [code, setCode] = useState<Code | null>(null);
  const [failed, setFailed] = useState(false);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setFailed(false);
    import("../lib/qr").then(
      ({ qrPath }) => {
        if (live) setCode({ url, ...qrPath(url) });
      },
      () => {
        if (live) setFailed(true); // offline, or a deploy replaced the file: say so and offer another try
      },
    );
    return () => {
      live = false;
    };
  }, [url, tries]);
  return (
    <div className="qrwrap">
      {code?.url === url ? (
        <svg viewBox={code.viewBox} shapeRendering="crispEdges" role="img" aria-label="QR code for this auction">
          <path d={code.d} />
        </svg>
      ) : failed ? (
        <p className="qr-fail" role="status">
          Couldn't draw the code.
          <button type="button" className="lnk box" onClick={() => setTries((n) => n + 1)}>
            Try again
          </button>
        </p>
      ) : (
        // The code's place, shimmering while its drawing code is on its way (the frame has its size already).
        <span className="sk qr-wait" aria-label="Drawing the QR code" role="img" />
      )}
    </div>
  );
}

/**
 * Opens the QR code for a deal, anchored to what was clicked. Showing it is opening the deal: the click is counted
 * from its panel and the deal is marked opened, as a tap on Open would.
 */
export function useOpenQr() {
  const overlay = useOverlay();
  const { openDeal } = useApp();
  return useCallback(
    (deal: Deal, e: MouseEvent<HTMLElement>, panel: "hero" | "deals", pos: number) => {
      const opened = overlay.open({
        title: "Open on your phone",
        anchor: e.currentTarget,
        body: () => (
          <>
            <QrCode url={deal.url} />
            <p className="poptx">
              Scan with your phone camera. Real opens on this auction:{" "}
              <b>
                {deal.player_name} · {formatRax(deal.price)} {deal.kind === "target" ? "to start" : "top bid"}
              </b>
              .
            </p>
            <div className="poptx sharerow">
              <ShareButton deal={deal} />
            </div>
          </>
        ),
      });
      if (opened) openDeal(deal, panel, pos);
    },
    [overlay, openDeal],
  );
}
