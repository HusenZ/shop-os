from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.main import create_app


def make_settings(tmp_path: Path, **overrides) -> Settings:
    data_dir = tmp_path / "data"
    values = {
        "data_dir": data_dir,
        "database_url": f"sqlite:///{data_dir / 'hub.db'}",
        "backup_dir": data_dir / "backups",
        "jwt_secret": "test-secret-for-the-shopos-hub-test-suite-0123456789",
    }
    values.update(overrides)
    return Settings(**values)


@pytest.fixture
def settings(tmp_path: Path) -> Settings:
    return make_settings(tmp_path)


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    """A fresh app on a fresh temporary SQLite database for every test."""
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def client_factory(tmp_path: Path) -> Iterator[Callable[..., TestClient]]:
    """Build a client with custom settings (each call gets its own temp folder)."""
    opened: list[TestClient] = []

    def factory(**overrides) -> TestClient:
        folder = tmp_path / f"app{len(opened)}"
        test_client = TestClient(create_app(make_settings(folder, **overrides)))
        test_client.__enter__()
        opened.append(test_client)
        return test_client

    yield factory
    for test_client in opened:
        test_client.__exit__(None, None, None)
