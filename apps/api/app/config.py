"""Hub settings, read from ``SHOPOS_*`` environment variables (or a local ``.env``)."""

from __future__ import annotations

from pathlib import Path
from typing import Annotated

from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

API_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_DATA_DIR = API_ROOT / "data"

DEV_JWT_SECRET = "shopos-dev-secret-change-me-in-production-0123456789"

DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SHOPOS_", env_file=".env", extra="ignore")

    # Folder for the default SQLite file and the backup blobs.
    data_dir: Path = DEFAULT_DATA_DIR
    # SQLAlchemy URL. Empty means sqlite:///<data_dir>/hub.db.
    database_url: str = ""
    # Backup blobs go to <backup_dir>/<org_id>/. Empty means <data_dir>/backups.
    backup_dir: Path | None = None

    jwt_secret: str = DEV_JWT_SECRET
    jwt_algorithm: str = "HS256"
    jwt_ttl_days: int = 7

    # JSON list or comma-separated string in the environment.
    cors_origins: Annotated[list[str], NoDecode] = DEFAULT_CORS_ORIGINS

    pull_default_limit: int = 500
    pull_max_limit: int = 2000
    max_backup_bytes: int = 50 * 1024 * 1024

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            text = value.strip()
            if text.startswith("["):
                import json

                return json.loads(text)
            return [part.strip() for part in text.split(",") if part.strip()]
        return value

    @model_validator(mode="after")
    def _derive_paths(self) -> "Settings":
        if not self.database_url:
            self.database_url = f"sqlite:///{self.data_dir / 'hub.db'}"
        if self.backup_dir is None:
            self.backup_dir = self.data_dir / "backups"
        return self

    @property
    def sqlite_path(self) -> Path | None:
        """File path of the SQLite database, or None for non-file URLs."""
        prefix = "sqlite:///"
        if self.database_url.startswith(prefix):
            raw = self.database_url[len(prefix) :].split("?", 1)[0]
            if raw and raw != ":memory:":
                return Path(raw)
        return None


def get_settings() -> Settings:
    return Settings()
