"""ShopOS sync hub: app factory."""

from __future__ import annotations

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from . import models  # noqa: F401  (registers the tables on Base.metadata)
from .config import DEV_JWT_SECRET, Settings, get_settings
from .db import Base, make_engine, make_session_factory
from .routers import auth, backups, devices, reports, sync
from .schemas import Health

logger = logging.getLogger("shopos.hub")


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or get_settings()
    engine = make_engine(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        if settings.jwt_secret == DEV_JWT_SECRET:
            logger.warning("SHOPOS_JWT_SECRET is not set; using the development secret.")
        settings.data_dir.mkdir(parents=True, exist_ok=True)
        if settings.sqlite_path is not None:
            settings.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        settings.backup_dir.mkdir(parents=True, exist_ok=True)
        Base.metadata.create_all(engine)
        try:
            yield
        finally:
            engine.dispose()

    app = FastAPI(
        title="ShopOS sync hub",
        version="0.1.0",
        description=(
            "Relays, verifies and durably stores the hash-chained op logs of ShopOS devices, "
            "and builds small projections for consolidated reports."
        ),
        lifespan=lifespan,
    )
    app.state.settings = settings
    app.state.engine = engine
    app.state.session_factory = make_session_factory(engine)
    # Serialises seq assignment, series codes and sign-ups within this process.
    app.state.write_lock = threading.RLock()

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["Content-Disposition", "X-Backup-Sha256", "X-Backup-Id"],
    )

    @app.get("/health", response_model=Health, tags=["health"])
    def health() -> Health:
        return Health(status="ok")

    app.include_router(auth.router)
    app.include_router(devices.router)
    app.include_router(sync.router)
    app.include_router(backups.router)
    app.include_router(reports.router)
    return app


app = create_app()
