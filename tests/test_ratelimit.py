from advisor.ratelimit import TokenBuckets


def test_each_key_gets_its_capacity_then_waits_for_the_refill():
    t = [0.0]
    buckets = TokenBuckets(capacity=3, per_s=0.5, max_keys=10, clock=lambda: t[0])
    assert [buckets.take("a") for _ in range(4)] == [True, True, True, False]
    assert buckets.take("b") is True  # another key has its own bucket
    t[0] = 1.0
    assert buckets.take("a") is False  # half a token back is not one
    t[0] = 2.0
    assert [buckets.take("a"), buckets.take("a")] == [True, False]
    t[0] = 1000.0
    assert [buckets.take("a") for _ in range(4)] == [True, True, True, False]  # refilled up to the capacity only


def test_the_table_never_holds_more_than_max_keys():
    t = [0.0]
    buckets = TokenBuckets(capacity=2, per_s=1 / 30, max_keys=3, clock=lambda: t[0])
    for n in range(100):
        assert buckets.take(f"10.0.0.{n}") is True
        assert len(buckets) <= 3
    # The busiest key stays known while newcomers push the oldest out.
    buckets.take("10.0.0.99")
    assert buckets.take("10.0.0.99") is False
    for n in range(2):
        buckets.take(f"192.0.2.{n}")
    assert buckets.take("10.0.0.99") is False
    assert len(buckets) == 3
