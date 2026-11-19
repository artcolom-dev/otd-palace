// "Delete my data": the member asks the server to forget everything it holds under their Discord id (their link, the
// players they follow, their ping settings, any alert subscription, the visits and activity of this browser and of
// every browser they used signed in, the accounts they looked up, their activity in our Discord) and to take their
// Discord roles back. The server
// signs them out in the same answer. The notice itself is a plain server page, /privacy.
import { memberLinkStore } from "./link";
import { noteDiscordRequired } from "./gate";
import { dropActivity } from "./activity";
import { forgetDevice, peekDevice } from "./visit";

/** The notice's address: a page of the server, not of this app, so a link to it is a normal navigation. */
export const PRIVACY_HREF = "/privacy";

/** DELETE /api/me: whether the server did it (204). A 401 means the session is gone already: the page shows the gate. */
export async function deleteMyData(fetchImpl: typeof fetch): Promise<boolean> {
  try {
    // This browser's anonymous visit id goes with the request, so the server drops its visits too (advisor/visits.py).
    const device = peekDevice();
    dropActivity(); // what this page has not sent yet goes too (the server erases what it was sent)
    const r = await fetchImpl("/api/me", {
      method: "DELETE",
      credentials: "same-origin",
      cache: "no-store",
      ...(device ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device }) } : {}),
    });
    if (r.status === 401) noteDiscordRequired();
    if (r.status !== 204) return false;
    memberLinkStore.set(null); // what this page knew of the link is gone with it
    forgetDevice(); // and the next visit starts a new id
    return true;
  } catch {
    return false;
  }
}
