from __future__ import annotations

import hashlib
import os
from pathlib import Path

from .helpers import auth, create_org, enrol


def _setup(client):
    owner = create_org(client)
    device = enrol(client, owner["access_token"], "dev-a")
    return owner, device


def test_backup_upload_list_download_round_trip(client, settings):
    owner, device = _setup(client)
    blob = os.urandom(300_000) + "शुभ लाभ".encode()
    headers = {
        **auth(device["device_token"]),
        "Content-Type": "application/octet-stream",
        "X-Backup-Name": "shopos-sharma-20261124-1015.shopos",
    }
    res = client.put("/v1/backups", content=blob, headers=headers)
    assert res.status_code == 201, res.text
    created = res.json()
    assert set(created) == {"backup_id", "size", "sha256", "created_at"}
    assert created["size"] == len(blob)
    assert created["sha256"] == hashlib.sha256(blob).hexdigest()

    stored = Path(settings.backup_dir) / owner["org_id"] / f"{created['backup_id']}.bin"
    assert stored.read_bytes() == blob

    second = client.put("/v1/backups", content=b"second backup", headers=auth(device["device_token"]))
    assert second.status_code == 201

    listed = client.get("/v1/backups", headers=auth(device["device_token"]))
    assert listed.status_code == 200
    rows = {row["backup_id"]: row for row in listed.json()}
    assert set(rows) == {created["backup_id"], second.json()["backup_id"]}
    first_row = rows[created["backup_id"]]
    assert first_row["name"] == "shopos-sharma-20261124-1015.shopos"
    assert first_row["sha256"] == created["sha256"] and first_row["device_id"] == "dev-a"

    download = client.get(f"/v1/backups/{created['backup_id']}", headers=auth(device["device_token"]))
    assert download.status_code == 200
    assert download.content == blob
    assert hashlib.sha256(download.content).hexdigest() == created["sha256"]
    assert download.headers["content-type"] == "application/octet-stream"
    assert download.headers["x-backup-sha256"] == created["sha256"]

    # Another enrolled device in the same org can fetch it (restore onto a new phone).
    other = enrol(client, owner["access_token"], "dev-b")
    again = client.get(f"/v1/backups/{created['backup_id']}", headers=auth(other["device_token"]))
    assert again.content == blob


def test_backups_are_scoped_to_the_org(client):
    _, device = _setup(client)
    res = client.put("/v1/backups", content=b"secret", headers=auth(device["device_token"]))
    backup_id = res.json()["backup_id"]

    stranger_owner = create_org(client, email="stranger@shop.test")
    stranger = enrol(client, stranger_owner["access_token"], "dev-x")
    assert client.get("/v1/backups", headers=auth(stranger["device_token"])).json() == []
    res = client.get(f"/v1/backups/{backup_id}", headers=auth(stranger["device_token"]))
    assert res.status_code == 404


def test_backup_size_limit_and_empty_body(client_factory):
    client = client_factory(max_backup_bytes=1024)
    _, device = _setup(client)
    too_big = client.put("/v1/backups", content=b"x" * 1025, headers=auth(device["device_token"]))
    assert too_big.status_code == 413
    ok = client.put("/v1/backups", content=b"x" * 1024, headers=auth(device["device_token"]))
    assert ok.status_code == 201
    empty = client.put("/v1/backups", content=b"", headers=auth(device["device_token"]))
    assert empty.status_code == 400
    assert len(client.get("/v1/backups", headers=auth(device["device_token"])).json()) == 1


def test_backups_need_a_device_token(client):
    owner, _ = _setup(client)
    # The owner JWT is not a device token.
    res = client.put("/v1/backups", content=b"x", headers=auth(owner["access_token"]))
    assert res.status_code == 401
