"""Render the home-screen icons from frontend/public/logo.svg: icon-192.png, icon-512.png, apple-touch-icon.png and
icon-maskable-512.png, and the link preview (og.png, 1200 x 630: what Discord, Slack and the like show under a link).

    uv run python scripts/render_icons.py                          # every icon
    uv run python scripts/render_icons.py icon-maskable-512.png    # only the ones named

The icons are the logo drawn full bleed (a home screen rounds or masks the corners itself), with the glyph scaled
into the middle 80% so a round or squircle mask never cuts it. The maskable icon (the manifest's "maskable" purpose,
which Android crops to its own shape) pads the glyph further, into the middle two thirds, where every mask shape
keeps it whole with room around it. Chromium draws them, through Playwright (a dev dependency); set CHROMIUM_PATH
to use a Chromium other than the one Playwright installed.

og.png's headline is set at 70 px, but the site's brand font file now holds only optical sizes 12 to 24 (the subset of
the internal research notes), which draws it thinner than the published picture. To redraw og.png the same, point
FONTS at a folder holding the full v9 file under the same name (git show 59691db^:frontend/src/fonts/bricolage-latin.woff2)
and the other fonts; the icons use no font.
"""

import os
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from playwright.sync_api import sync_playwright

PUBLIC = Path(__file__).resolve().parent.parent / "frontend" / "public"
GLYPH_SCALE = 0.84  # the glyph's corners then sit inside the mask's safe circle (40% of the size from the centre)
MASKABLE_GLYPH_SCALE = 0.68  # the glyph's corners then sit a third of the size from the centre, well inside that circle
ICONS = {  # name: (size in pixels, glyph scale)
    "icon-192.png": (192, GLYPH_SCALE),
    "icon-512.png": (512, GLYPH_SCALE),
    "apple-touch-icon.png": (180, GLYPH_SCALE),
    "icon-maskable-512.png": (512, MASKABLE_GLYPH_SCALE),
}


def full_bleed(logo: str, scale: float) -> str:
    """The logo as a square: no rounded corners, the glyph scaled by `scale` about the centre of its 64-unit box."""
    body = re.sub(r"<title[^>]*>.*?</title>", "", logo, flags=re.S)
    body = re.sub(r'\srx="[^"]*"', "", body, count=1)
    offset = 32 * (1 - scale)
    return body.replace("<g ", f'<g transform="translate({offset:.2f} {offset:.2f}) scale({scale})" ', 1)


OG_SIZE = (1200, 630)
FONTS = Path(__file__).resolve().parent.parent / "frontend" / "src" / "fonts"


def font(name: str) -> str:
    """A font of the site as a data: address (a page set from a string cannot open file: ones)."""
    import base64

    return "data:font/woff2;base64," + base64.b64encode((FONTS / name).read_bytes()).decode()


def og_page(logo: str) -> str:
    """The link preview: our logo and name, one line on what the site is, and a fan of our own drawn cards in Real's
    rarity colours (advisor/real.py). No deal, no price, no player: it is shown under every link to the site."""
    from advisor.real import RARITY_COLORS, RARITY_NAMES

    mark = re.sub(r"<title[^>]*>.*?</title>", "", logo, flags=re.S).replace("<svg ", '<svg width="56" height="56" ', 1)
    cards = [(1, -8, "6.8"), (5, 0, "9.4"), (4, 8, "8.1")]  # Common, Legendary, Epic: no orange but the logo and the headline
    fan = "".join(
        f'<div class="card" style="--c:{RARITY_COLORS[r]};--rot:{rot}deg;--i:{i}">'
        f'<span class="rn">{RARITY_NAMES[r]}</span><b>{rating}</b><span class="rl">rating</span><i></i><i class="s"></i></div>'
        for i, (r, rot, rating) in enumerate(cards)
    )
    return f"""<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: Bricolage; font-weight: 600 800; src: url("{font('bricolage-latin.woff2')}"); }}
@font-face {{ font-family: Archivo; font-weight: 400 700; src: url("{font('archivo-latin.woff2')}"); }}
* {{ box-sizing: border-box; margin: 0; }}
body {{ width: 1200px; height: 630px; background: #0e0e10; color: #f2f1ee; font-family: Archivo, sans-serif; overflow: hidden;
  position: relative; }}
.panel {{ position: absolute; inset: 28px; border: 1px solid #25252b; border-radius: 28px; background: #131316; }}
.brand {{ position: absolute; left: 84px; top: 76px; display: flex; align-items: center; gap: 18px;
  font: 800 34px/1 Bricolage; letter-spacing: -0.02em; }}
h1 {{ position: absolute; left: 84px; top: 176px; width: 620px; font: 800 70px/1.04 Bricolage; letter-spacing: -0.03em; }}
h1 em {{ font-style: normal; color: #f5893a; }}
.sub {{ position: absolute; left: 84px; top: 446px; width: 560px; font-size: 26px; line-height: 1.4; color: #a4a3ac; }}
.foot {{ position: absolute; left: 84px; bottom: 72px; font-size: 20px; color: #8c8b95; }}
.fan {{ position: absolute; right: 64px; top: 130px; width: 480px; height: 400px; }}
.card {{ position: absolute; left: calc(var(--i) * 126px); top: calc(var(--i) * 4px); width: 228px; height: 322px;
  border: 5px solid var(--c); border-radius: 22px; background: #17171b; transform: rotate(var(--rot)); transform-origin: 50% 100%;
  padding: 20px 22px; box-shadow: 0 18px 40px rgb(0 0 0 / 0.45); }}
.card:nth-child(1) {{ z-index: 1; }} .card:nth-child(2) {{ z-index: 3; top: -8px; }} .card:nth-child(3) {{ z-index: 2; }}
.rn {{ display: block; font-weight: 700; font-size: 19px; color: var(--c); letter-spacing: 0.02em; }}
.card b {{ display: block; margin-top: 18px; font: 800 80px/1 Bricolage; letter-spacing: -0.03em; }}
.card:nth-child(3) {{ text-align: right; }} .card:nth-child(3) i.s {{ margin-left: auto; }}
.rl {{ color: #a4a3ac; font-size: 18px; }}
.card i {{ display: block; height: 10px; margin-top: 22px; border-radius: 5px; background: var(--c); opacity: 0.35; }}
.card i.s {{ width: 62%; margin-top: 12px; }}
</style><div class="panel"></div>
<div class="brand">{mark}<span>OTD Palace</span></div>
<h1>Real card deals, <em>priced from real sales.</em></h1>
<p class="sub">Live deals, players on the move and the passes worth getting.</p>
<p class="foot">An independent guide. Not affiliated with Real.</p>
<div class="fan">{fan}</div>"""


def main() -> int:
    logo = (PUBLIC / "logo.svg").read_text(encoding="utf-8")
    wanted = sys.argv[1:] or [*ICONS, "og.png"]
    unknown = [name for name in wanted if name not in ICONS and name != "og.png"]
    if unknown:
        print(f"unknown icon(s): {', '.join(unknown)}; known: {', '.join([*ICONS, 'og.png'])}", file=sys.stderr)
        return 2
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=os.environ.get("CHROMIUM_PATH") or None)
        for name in wanted:
            if name == "og.png":
                width, height = OG_SIZE
                page = browser.new_page(viewport={"width": width, "height": height})
                page.set_content(og_page(logo))
                page.evaluate("document.fonts.ready")
                page.wait_for_timeout(200)
                page.screenshot(path=str(PUBLIC / name), clip={"x": 0, "y": 0, "width": width, "height": height})
                page.close()
                print(f"wrote {name} ({width}x{height})")
                continue
            size, scale = ICONS[name]
            svg = full_bleed(logo, scale)
            page = browser.new_page(viewport={"width": size, "height": size})
            sized = svg.replace("<svg ", f'<svg width="{size}" height="{size}" ', 1)
            page.set_content(f"<!doctype html><body style='margin:0'>{sized}</body>")
            page.screenshot(path=str(PUBLIC / name), clip={"x": 0, "y": 0, "width": size, "height": size})
            page.close()
            print(f"wrote {name} ({size}x{size})")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
