"""Aggregate all API routes."""

from fastapi import APIRouter
from app.api.auth import router as auth_router
from app.api.ingest import router as ingest_router
from app.api.contacts import router as contacts_router
from app.api.chat import router as chat_router
from app.api.dashboard import router as dashboard_router
from app.api.suggestions import router as suggestions_router
from app.api.documents import router as documents_router
from app.api.settings import router as settings_router
from app.api.ws import router as ws_router

api_router = APIRouter(prefix="/api")

api_router.include_router(auth_router)
api_router.include_router(ingest_router)
api_router.include_router(contacts_router)
api_router.include_router(chat_router)
api_router.include_router(dashboard_router)
api_router.include_router(suggestions_router)
api_router.include_router(documents_router)
api_router.include_router(settings_router)
api_router.include_router(ws_router)
