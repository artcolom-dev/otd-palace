from hashids import Hashids

from advisor.links import card_url, listing_url


def test_card_link_matches_the_one_real_renders():
    assert card_url(255548062) == "https://www.realapp.com/D5h7FRFWPOKGR"


def test_listing_link_uses_route_type_30():
    path = listing_url(17164605).rsplit("/", 1)[1]
    assert Hashids(salt="routing", min_length=11).decode(path) == (30, 0, 0, 17164605)
