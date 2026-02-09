from pydantic_settings import BaseSettings
from functools import lru_cache


class Settings(BaseSettings):
    # App
    app_name: str = "James Bot"
    debug: bool = False

    # Database (Railway provides DATABASE_URL)
    database_url: str = "postgresql://postgres:postgres@localhost:5432/james_bot"

    # Redis
    redis_url: str = "redis://localhost:6379"

    # Auth
    jwt_secret: str = "change-me-in-production"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 60 * 24 * 7  # 7 days

    # Anthropic
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-sonnet-4-20250514"

    # Available LLM models for user selection
    @property
    def available_models(self) -> list[dict]:
        return [
            {
                "id": "claude-3-5-haiku-20241022",
                "name": "Claude 3.5 Haiku",
                "description": "Fastest, lowest cost. Good for simple replies.",
                "tier": "fast",
                "input_cost_per_m": 0.80,
                "output_cost_per_m": 4.00,
            },
            {
                "id": "claude-sonnet-4-20250514",
                "name": "Claude Sonnet 4",
                "description": "Balanced speed & quality. Recommended default.",
                "tier": "balanced",
                "input_cost_per_m": 3.00,
                "output_cost_per_m": 15.00,
            },
            {
                "id": "claude-4-opus-20250514",
                "name": "Claude 4 Opus",
                "description": "Most capable. Best for nuanced ghostwriting.",
                "tier": "premium",
                "input_cost_per_m": 15.00,
                "output_cost_per_m": 75.00,
            },
        ]

    # Embeddings (OpenAI primary, Voyage AI fallback)
    openai_api_key: str = ""
    openai_embedding_model: str = "text-embedding-3-small"
    voyageai_api_key: str = ""
    voyageai_embedding_model: str = "voyage-3-lite"
    embedding_dimension: int = 512

    # Telegram (for in-app auth flow)
    telegram_api_id: int = 0
    telegram_api_hash: str = ""
    telegram_phone: str = ""

    # Password Reset / Email
    frontend_url: str = "http://localhost:3000"
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: str = ""
    smtp_from_email: str = ""
    smtp_from_name: str = "James Bot"
    reset_token_expire_minutes: int = 15

    # CORS
    cors_origins: str = "http://localhost:3000"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}

    @property
    def async_database_url(self) -> str:
        """Convert standard postgres URL to asyncpg URL."""
        url = self.database_url
        if url.startswith("postgresql://"):
            url = url.replace("postgresql://", "postgresql+asyncpg://", 1)
        elif url.startswith("postgres://"):
            url = url.replace("postgres://", "postgresql+asyncpg://", 1)
        return url

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]


@lru_cache
def get_settings() -> Settings:
    return Settings()
