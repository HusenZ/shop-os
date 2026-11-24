from __future__ import annotations

import jwt as pyjwt

from app.routers.devices import pick_series, series_code_for

from .helpers import auth, create_org, enrol


def test_health(client):
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"status": "ok"}


def test_create_org_and_login(client, settings):
    created = create_org(client, email="Owner@Shop.test", password="correct horse")
    assert set(created) == {"org_id", "user_id", "access_token"}

    claims = pyjwt.decode(created["access_token"], settings.jwt_secret, algorithms=["HS256"])
    assert claims["sub"] == created["user_id"]
    assert claims["org"] == created["org_id"]
    assert claims["exp"] - claims["iat"] == 7 * 24 * 3600

    res = client.post("/v1/auth/login", json={"email": "owner@shop.test", "password": "correct horse"})
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["org_id"] == created["org_id"]
    assert body["user_id"] == created["user_id"]
    assert client.get("/v1/devices", headers=auth(body["access_token"])).status_code == 200


def test_login_bad_password_and_unknown_email(client):
    create_org(client, email="owner@shop.test", password="correct horse")
    bad = client.post("/v1/auth/login", json={"email": "owner@shop.test", "password": "wrong"})
    assert bad.status_code == 401
    unknown = client.post("/v1/auth/login", json={"email": "nobody@shop.test", "password": "x"})
    assert unknown.status_code == 401


def test_duplicate_email_is_409(client):
    create_org(client, email="owner@shop.test")
    res = client.post(
        "/v1/orgs", json={"org_name": "Other", "email": " OWNER@shop.test ", "password": "another-pass"}
    )
    assert res.status_code == 409
    assert res.json()["detail"] == "email_exists"


def test_owner_endpoints_need_a_valid_jwt(client, settings):
    assert client.get("/v1/devices").status_code == 401
    assert client.get("/v1/devices", headers=auth("not-a-jwt")).status_code == 401
    forged = pyjwt.encode({"sub": "u", "org": "o", "exp": 9999999999}, "a-different-secret-that-is-long-enough-0123456789", algorithm="HS256")
    assert client.get("/v1/devices", headers=auth(forged)).status_code == 401


def test_password_is_stored_as_pbkdf2(client):
    from sqlalchemy import select

    from app.models import User

    create_org(client, email="owner@shop.test", password="correct horse")
    with client.app.state.session_factory() as db:
        stored = db.scalar(select(User.password_hash))
    scheme, iterations, salt, digest = stored.split("$")
    assert scheme == "pbkdf2_sha256" and iterations == "200000"
    assert "correct horse" not in stored


def test_series_code_sequence():
    assert [series_code_for(i) for i in (0, 1, 25, 26, 27, 51, 52, 701, 702)] == [
        "A", "B", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"
    ]
    assert pick_series(set(), None) == "A"
    assert pick_series({"A", "B"}, None) == "C"
    assert pick_series({"A"}, "D") == "D"
    assert pick_series({"A", "D"}, "D") == "B"
    taken = {series_code_for(i) for i in range(26)}
    assert pick_series(taken, None) == "AA"


def test_enrol_devices_series_and_reenrol(client):
    org = create_org(client)
    jwt = org["access_token"]

    a = enrol(client, jwt, "dev-a", "Counter 1")
    b = enrol(client, jwt, "dev-b", "Counter 2")
    assert (a["series_code"], b["series_code"]) == ("A", "B")
    assert a["org_id"] == org["org_id"] and a["device_id"] == "dev-a"
    assert a["device_token"] != b["device_token"]

    d = enrol(client, jwt, "dev-d", "Godown", preferred_series="d")
    assert d["series_code"] == "D"
    taken_pref = enrol(client, jwt, "dev-c", "Tablet", preferred_series="A")
    assert taken_pref["series_code"] == "C"  # A is taken, so the next free code
    e = enrol(client, jwt, "dev-e", "Phone")
    assert e["series_code"] == "E"

    # Re-enrolling keeps the series, issues a fresh token and kills the old one.
    again = enrol(client, jwt, "dev-a", "Counter 1 (new name)", preferred_series="Z")
    assert again["series_code"] == "A"
    assert again["device_token"] != a["device_token"]
    assert client.get("/v1/sync/status", headers=auth(a["device_token"])).status_code == 401
    status = client.get("/v1/sync/status", headers=auth(again["device_token"]))
    assert status.status_code == 200
    assert status.json()["series_code"] == "A"

    listed = client.get("/v1/devices", headers=auth(jwt)).json()
    by_id = {row["device_id"]: row for row in listed}
    assert set(by_id) == {"dev-a", "dev-b", "dev-c", "dev-d", "dev-e"}
    assert by_id["dev-a"]["name"] == "Counter 1 (new name)"
    assert set(by_id["dev-a"]) == {
        "device_id", "name", "series_code", "enrolled_at", "last_seen_at", "revoked_at", "last_hash"
    }
    assert by_id["dev-b"]["revoked_at"] is None and by_id["dev-b"]["last_hash"] is None


def test_device_of_another_org_is_409(client):
    first = create_org(client, email="one@shop.test")
    second = create_org(client, email="two@shop.test")
    enrol(client, first["access_token"], "dev-shared")
    res = client.post(
        "/v1/devices/enrol",
        json={"device_id": "dev-shared", "name": "Stolen?"},
        headers=auth(second["access_token"]),
    )
    assert res.status_code == 409
    # Series codes are per org: the second org starts at A again.
    assert enrol(client, second["access_token"], "dev-other")["series_code"] == "A"


def test_revoke_is_scoped_to_the_org(client):
    first = create_org(client, email="one@shop.test")
    second = create_org(client, email="two@shop.test")
    enrol(client, first["access_token"], "dev-a")
    res = client.post("/v1/devices/dev-a/revoke", headers=auth(second["access_token"]))
    assert res.status_code == 404
    res = client.post("/v1/devices/dev-a/revoke", headers=auth(first["access_token"]))
    assert res.status_code == 200
    assert res.json()["revoked_at"] is not None
