"""The privacy notice (GET /privacy) and what "Delete my data" removes (`erase_member`).

The notice is a plain page, public and cacheable, outside the Discord gate (someone deciding whether to sign in must be
able to read it first). It styles itself with /share.css (the shared pages' sheet) and /privacy.css (below), and loads
nothing from elsewhere, like the rest of the site. Every number it quotes (how long a login lasts, how long alert
subscriptions and click counts are kept) is read from the constants the code itself runs on, so the notice cannot drift
from the behaviour without a test failing.

What the server holds about a member, all of it listed in the notice and all of it removed by `erase_member`, except one tombstone:
  member-links.json    their Discord id -> the Real username they linked, when, a summary of its passes, the players
                       behind them, the players they follow, their ping settings and DM state; and the "unlinked at"
                       mark that stops a device from linking them back (advisor/members.py). The erase keeps that
                       mark as a tombstone: the Discord id and the time of the erase, nothing else
  push.json            alert subscriptions made while signed in, under their Discord id (off while no VAPID keys are set)
  visits.json          the anonymous visit id of each device (advisor/visits.py): its active days, first source, class
                       and, once seen signed in, a keyed hash of the member's Discord id; and the member's hash with
                       their active days. The erase drops the member's hash, every device seen signed in as them, and
                       the visit id the page itself sends with the request
  activity.db          what each device and each signed-in member does (advisor/activity.py): the page's events, the
                       visits, logins, lookups and links, under the visit id and, once signed in, the Discord id (the
                       device's history included); and our Discord server read by the bot (messages counted per
                       channel, day and author, never their text; joins, leaves, roles, name and avatar). The erase
                       drops all of it under their Discord id, every device they used signed in with all it did, the
                       visit id the page sends, and the lookups they made; and records nothing more under them until
                       they log in anew (a mark of their id and the time of the erase)
  invites.json         the invite board (advisor/discord_invites.py): per Discord id of a member who made an invite
                       link to our server, the highest number of joins seen through their links, the invite roles
                       given, and whether they are on the staff or out of the server; no name, no invite code. The
                       erase drops the row, has the invite roles taken back, and keeps a dated mark so nothing is kept
                       under them again until they type /invites themselves
Everything else is not about one person: click counts (no id, no address), rate-limit buckets by address (memory only),
the importer's answers by Real username (memory only, IMPORT_CACHE_S) and the market itself.
"""

import hashlib
import html
import logging
import re
from datetime import datetime, timedelta, timezone
from functools import lru_cache

from flask import Flask, Response, abort, request

from advisor import rules
from advisor.discord_gate import SESSION_MAX_AGE_S, STATE_MAX_AGE_S

log = logging.getLogger(__name__)

LAST_UPDATED = "19 November 2026"  # with the invite board's counts
CACHE_S = 3600  # the notice changes with a deploy; an hour of staleness is harmless
_INVITE = re.compile(r"https://(discord\.gg|discord\.com/invite)/[A-Za-z0-9-]{2,32}")


def erase_member(uid: str, links, push, perks, visits=None, device: object = None, activity=None) -> dict:
    """Removes everything the server holds under the member's Discord id and asks the Discord bot to take back the
    roles it gave (see the module's docstring for what is held). Each store is optional (None: not running); a store
    that fails does not stop the others. The roles are asked for last and in the background: the bot's worker sets a
    member with no link to no managed role, and Discord being down or the queue being full never reaches the member.
    With the visit log, the member's hash and every device seen signed in as them go too, and `device`, the visit id
    the page itself sends (a device used before signing in carries nothing that ties it to them).
    Returns {"link": bool, "subscriptions": int, "failed": bool}: `failed` when a store could not write its file
    (what it holds is then still there, and the caller says so). Never raises."""
    removed = {"link": False, "subscriptions": 0, "failed": False}
    if links is not None:
        try:
            removed["link"] = links.erase(uid)
        except Exception:  # noqa: BLE001 - the other stores are still to be emptied
            removed["failed"] = True
            log.exception("delete my data: the linked accounts could not be emptied")
    if push is not None:
        try:
            removed["subscriptions"] = push.store.delete_member(uid)
        except Exception:  # noqa: BLE001
            removed["failed"] = True
            log.exception("delete my data: the alert subscriptions could not be emptied")
    if visits is not None:
        try:
            visits.erase_device(device)
            visits.erase_member(uid)
        except Exception:  # noqa: BLE001
            removed["failed"] = True
            log.exception("delete my data: the visits could not be emptied")
    if activity is not None:
        try:
            activity.erase_member(uid, device=device)
        except Exception:  # noqa: BLE001
            removed["failed"] = True
            log.exception("delete my data: the activity could not be emptied")
    board = getattr(perks, "invites", None)  # the invite board rides on the perks worker (None: not running)
    if board is not None:
        try:
            board.erase(uid)
        except Exception:  # noqa: BLE001
            removed["failed"] = True
            log.exception("delete my data: the invite count could not be emptied")
    if perks is not None:
        try:
            perks.request_sync(uid)
        except Exception:  # noqa: BLE001 - best effort: a role left behind is cosmetic and the next link sets it again
            log.warning("delete my data: the roles could not be queued for removal")
    return removed


def _days(seconds: int) -> str:
    days = round(seconds / 86400)
    return f"{days} day{'s' if days != 1 else ''}"


def _minutes(seconds: int) -> str:
    minutes = max(1, round(seconds / 60))
    return f"{minutes} minute{'s' if minutes != 1 else ''}"


def render_page(invite: str | None = None) -> str:
    """The notice as an HTML page. `invite` is our Discord server's invite link, shown when it is one."""
    esc = html.escape
    where = "the #feedback channel of our Discord server"
    if invite and _INVITE.fullmatch(invite):
        where = f'the #feedback channel of <a href="{esc(invite)}" rel="noopener noreferrer">our Discord server</a>'
    session = _days(SESSION_MAX_AGE_S)
    alerts = _days(rules.PUSH_ROW_TTL_DAYS * 86400)
    clicks = _days(rules.CLICK_KEEP_DAYS * 86400)
    visits = _days(rules.VISIT_KEEP_DAYS * 86400)
    member_activity = _days(rules.MEMBER_ACTIVITY_KEEP_DAYS * 86400)
    anon_activity = _days(rules.ANON_ACTIVITY_KEEP_DAYS * 86400)
    lookups = _minutes(rules.IMPORT_CACHE_S)
    login = _minutes(STATE_MAX_AGE_S)
    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Privacy · OTD Palace</title>
<meta name="description" content="What OTD Palace keeps about you, why, for how long, and how to delete it.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/share.css">
<link rel="stylesheet" href="/privacy.css">
</head>
<body>
<header class="top"><a class="brand" href="/"><img src="/logo.svg" alt="" width="32" height="32"><span>OTD Palace</span></a></header>
<main class="doc">
<h1>Privacy</h1>
<p class="lede">Short version: without signing in, you are an anonymous id. Once you sign in with Discord, your activity on the site and in our Discord server is recorded with your Discord account, to improve the site. We sell nothing, run no ads and no third-party analytics. You can delete it all in one tap.</p>
<p class="meta">Last updated: {LAST_UPDATED}</p>

<h2 id="who">Who we are</h2>
<p>OTD Palace (formerly Market Palace) is a free, independent advisor for people who play Real, the sports-collectibles app. We are not affiliated with, endorsed by or sponsored by Real. The people who run OTD Palace decide what is kept and why, and are the contact for everything on this page.</p>

<h2 id="collect">What we keep, and why</h2>
<p>OTD Palace is free, and you can use it without signing in: then we keep no name and no account, only the anonymous visit id below with what it did, the click counts and the in-memory abuse limits.</p>
<ul class="keep">
<li><b>An anonymous visit id, for everyone.</b> Your browser picks a random id and keeps it in its own storage (not a cookie). The page sends it when it opens and when you change tab, with that tab, whether you are on a phone, tablet or computer, whether the site runs from your home screen, the name of the site that sent you (only its name, like google.com) and a campaign tag from the link, if any. It also reports what you use, as you use it: how long the page is on screen, the features you touch (looking up an account, filters and sorting, the sport picked, a deal opened, sharing, a click to Real, alerts and pings switched on or off, pull to refresh, the menus and sheets you open) and the Real accounts you look up. We keep, per id, when it was active, what it did, how it first came and whether it signed in, so we can see what works and how many come back. We never keep your network address, your browser details or any fingerprint with it. If your browser sends Global Privacy Control or Do Not Track, the page makes no id and sends nothing while you are not signed in.</li>
</ul>
<p>Signing in with Discord (free too: it unlocks every deal, your own plan and deal pings), then linking a Real account, is what makes us keep the following.</p>
<ul class="keep">
<li><b>Your Discord id and display name.</b> To sign you in, check you are in our server, and show your name. We ask Discord for two permissions: to know who you are, and to add you to our server. The access Discord gives us is used once, during the login, and then thrown away: we never store it. We do not keep your email, friends or other servers.</li>
<li><b>Your activity, recorded with your Discord account.</b> Once you sign in, what your devices do on the site (the visit id above and everything it reports, history included: what that device did before you signed in comes with it) is recorded with your Discord id and name, to improve the site: when you come, for how long, from where you first came, which devices, tabs and features you use, the accounts you look up, and when you link or unlink. Global Privacy Control and Do Not Track do not stop this once you are signed in: signing in is your choice, and Delete my data undoes it.</li>
<li><b>Your activity in our Discord server.</b> Our bot reads the channels of our server, whether or not you use the site, and keeps with your Discord id how many messages you post per channel and per day (never what they say), when you join or leave, your roles, your server name and avatar. It also counts the reactions on its own posts.</li>
<li><b>Your invites to our Discord server.</b> If you make an invite link to our server, our bot reads from Discord how many people joined through your links and keeps, with your Discord id, the highest number of joins it has seen, the invite roles it gave you, and whether you are still in the server. The <code>/invites</code> command shows the top inviters to the member who asks. We keep no name and no link with it.</li>
<li><b>The Real username you link.</b> So your passes follow you to any device and the tips skip what you own. We keep a summary (how many passes, by sport and rarity), a yearly estimate and the players behind your passes. The passes themselves are not stored: they are read again from your public Real profile when you open the page.</li>
<li><b>The players you follow, and your settings.</b> For the deal pings you can switch on: whether they are on, whether our bot may message you, and the last deals it told you about so none comes twice.</li>
<li><b>Discord roles.</b> Linking gives you roles in our server (Linked, your sports, your account type), and inviting people can give you an invite role. Other members of the server can see roles.</li>
<li><b>A sign-in cookie.</b> It holds your Discord id, your name, two dates and whether you were in our server when we last checked, signed so it cannot be forged. A second cookie lasts {login}, while you are on Discord's page. Both are needed to sign you in; neither tracks you.</li>
<li><b>Phone alerts, if the site has them on.</b> They are optional. When on, your browser's alert address and your alert settings are kept under your Discord id.</li>
</ul>
<p>We never ask for your email, and never ask for or see your Real password: linking needs only a username.</p>

<h2 id="not">What we do not do</h2>
<ul>
<li>No ads and no third-party analytics. We count visits ourselves, with the anonymous id above: no tracking scripts, and no fonts or scripts loaded from other sites.</li>
<li>We never sell or share what we keep, and we use it only to run and improve OTD Palace.</li>
<li>We count your messages in our server, never what they say, and we never post for you. Our bot adds you to the server, sets your roles and, only if you leave pings on, sends you the deal messages. If you use our slash commands, Discord hands us the command so we can answer it; we keep nothing from it.</li>
</ul>
<p>Two small things exist that are not about you: click counts (which button was pressed, per day, with no id, no address and no cookie) and, in memory only, your network address and your Discord id, used to stop abuse and gone on restart.</p>

<h2 id="long">How long we keep it</h2>
<ul class="keep">
<li><b>Sign-in cookie:</b> {session} after you sign in, on your device. We keep no list of sessions.</li>
<li><b>Invite count:</b> until you delete your data. A dated mark with your Discord id then stops the count from being kept again, until you type <code>/invites</code> yourself.</li>
<li><b>Linked account and settings:</b> until you unlink or delete your data. Unlinking removes the link, summary and players, and keeps a dated mark with your Discord id so your other devices do not link you back. Deleting your data removes everything else and keeps only that mark, your Discord id and the time you erased it, so a device that still holds your old link cannot bring your data back; it goes when you link again on purpose.</li>
<li><b>Phone alert subscriptions:</b> until you turn alerts off, or {alerts} without your device checking in.</li>
<li><b>Click counts:</b> {clicks}.</li>
<li><b>Visit id:</b> on your device until you clear the site's data; on our server, each id with its days until {visits} after its last visit, and the daily totals for {visits}. Our Discord server's member count is kept as one number a day.</li>
<li><b>Your activity on the site and in our Discord, with your Discord account:</b> {member_activity} after it happened. <b>What an anonymous visit id did:</b> {anon_activity}.</li>
<li><b>In memory only:</b> a Real account you look up is held for {lookups}; your network address (abuse limits), and your Discord id (the last check that you are still in our server, and the limit on slash commands) for a few minutes. None of it is written to disk.</li>
<li><b>Server logs:</b> our app writes no names, ids or tokens to its logs. Our hosting provider keeps standard request logs (including network addresses) under its own policy.</li>
</ul>

<h2 id="who-sees">Who sees it</h2>
<p>Only the people who run OTD Palace: anonymous visits as totals, and signed-in members' activity member by member. Three services handle data for us, only for the purpose stated:</p>
<ul>
<li><b>Discord</b> signs you in, adds you to the server, sets your roles and delivers pings. Discord's own privacy policy covers your Discord account.</li>
<li><b>Our market data provider</b> supplies the market, and receives the Real usernames you look up or link so it can read their public profile.</li>
<li><b>Our hosting provider</b> hosts the site.</li>
</ul>
<p>Our server also reads public player photos and injury lists from ESPN. Nothing about you is sent there. When you tap a link to Real or Discord, that site sees your visit under its own rules; we send no referrer.</p>

<h2 id="rights">Your rights</h2>
<p>Wherever you live, you can see what we hold about you, correct it, or have it deleted.</p>
<ul>
<li><b>Delete:</b> sign in, open Your Real account (or, if you are not in our server, the Your data link at the foot of the page), press <b>Delete my data</b>. We remove your link, your followed players, your settings and ping state, any alert subscriptions, the visits of this device and of every device you used signed in, your invite count, and your activity on the site and in our Discord (what those devices did, the accounts you looked up, your message counts, joins, leaves and roles); this device then starts a new visit id. Nothing more is recorded under your Discord id until you sign in again. Not signed in on the site? Ask in #feedback and we erase your Discord activity. We ask our bot to take back your roles, and we sign you out. It is immediate. The only thing left is the dated mark described above (your Discord id and when you erased it).</li>
<li><b>You stay in the Discord server.</b> Deleting does not remove you from it. Leaving is your own action in Discord.</li>
<li><b>Correct:</b> link a different username, or unlink, in the same panel.</li>
<li><b>See it, or any other request:</b> ask in {where}. We will tell you what is held under your Discord id.</li>
<li><b>On your own devices:</b> the site also remembers things in your browser only (the visit id, followed players, opened deals, the passes you hold, saved settings, your last filters, and the last home page loaded with the site's code, to show when there is no network). We never receive it, apart from the link and followed players of a signed-in member. Clear it in your browser's site data. Devices still signed in after a deletion stay signed in until you sign out there or {session} pass.</li>
</ul>

<h2 id="where">Where it is kept</h2>
<p>Hosted with a cloud provider, on a disk attached to the service, and sent over HTTPS.</p>

<h2 id="children">Children</h2>
<p>OTD Palace is for people aged 13 or over, the minimum age for Discord, whose own age rules apply. If you think a child has signed in, tell us and we will delete what we hold.</p>

<h2 id="changes">Changes</h2>
<p>If what we keep changes, we update this page and the date at the top.</p>

<h2 id="contact">Contact</h2>
<p>Ask in {where}. We do not publish an email address.</p>
<p class="back"><a class="btn fill" href="/">Back to the deals</a></p>
</main>
<footer>Not affiliated with Real.</footer>
</body>
</html>
"""


PRIVACY_CSS = """.doc { max-width: 42rem; padding-top: 28px; padding-bottom: 40px; }
.doc h1 { font-size: 1.875rem; margin-bottom: 12px; }
.doc h2 { margin: 32px 0 8px; font-size: 1.25rem; line-height: 1.25; letter-spacing: -0.01em; }
.doc p, .doc li { color: var(--muted); }
.doc p { margin: 0 0 12px; }
.doc b { color: var(--text); }
.doc .lede { color: var(--text); font-size: 1.0625rem; }
.doc .meta { margin: 0 0 8px; color: var(--faint); font-size: 0.875rem; }
.doc ul { margin: 0 0 12px; padding-left: 1.25rem; display: grid; gap: 8px; }
.doc ul.keep { list-style: none; padding: 0; gap: 0; border-top: 1px solid var(--line); }
.doc ul.keep li { padding: 12px 0; border-bottom: 1px solid var(--line); }
.doc a { color: var(--accent); font-weight: 700; text-underline-offset: 3px; overflow-wrap: anywhere; }
.doc a.btn { color: var(--on-accent); text-decoration: none; }
.doc .back { margin-top: 28px; }
.doc h2, .doc h1 { scroll-margin-top: 16px; }
@media (min-width: 720px) {
  .doc { padding-top: 48px; }
  .doc h1 { font-size: 2.25rem; }
}
"""


@lru_cache(maxsize=8)
def _page(invite: str | None) -> tuple[bytes, str]:
    body = render_page(invite).encode()
    return body, hashlib.sha256(body).hexdigest()[:32]


def register(app: Flask) -> None:
    """Adds GET /privacy and /privacy.css: public, outside the gate, cacheable, with an ETag."""

    @app.get("/privacy")
    def privacy_page() -> Response:
        body, tag = _page(rules.COMMUNITY_URL)
        response = Response(body, mimetype="text/html")
        response.set_etag(tag)
        response.headers["Cache-Control"] = f"public, max-age={CACHE_S}"
        return response.make_conditional(request)

    @app.get("/.well-known/security.txt")
    def security_txt() -> Response:
        """RFC 9116: where to tell us about a security problem. The only contact is our Discord server (#feedback):
        no e-mail address is made up. Absent while no invite is set. The expiry moves with the clock, so it is never past."""
        if not rules.COMMUNITY_URL:
            abort(404)
        expires = datetime.now(timezone.utc) + timedelta(days=180)
        body = (f"Contact: {rules.COMMUNITY_URL}\n"
                f"Expires: {expires.strftime('%Y-%m-%dT%H:%M:%SZ')}\n"
                "Preferred-Languages: en\n"
                "# Found a security problem with OTD Palace? Tell the team in our Discord server, in #feedback.\n"
                "# Please do not post anyone's private data there: say what you found and we will ask for details.\n")
        response = Response(body, mimetype="text/plain")
        response.headers["Cache-Control"] = "public, max-age=3600"
        return response

    @app.get("/privacy.css")
    def privacy_css() -> Response:
        response = Response(PRIVACY_CSS, mimetype="text/css")
        response.headers["Cache-Control"] = "public, max-age=3600"
        return response

