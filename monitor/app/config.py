from pydantic_settings import BaseSettings
from functools import lru_cache


class MonitorSettings(BaseSettings):
    redis_url: str = "redis://localhost:6379"

    # Telegram creds (fallback if not stored in Redis/DB)
    telegram_api_id: int = 0
    telegram_api_hash: str = ""
    telegram_phone: str = ""
    telegram_session_string: str = ""

    # Poll interval for checking new sessions from the API
    session_poll_interval: int = 10  # seconds

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


@lru_cache
def get_settings() -> MonitorSettings:
    return MonitorSettings()
