"""
Anthropic Claude API wrapper for all LLM operations:
- Response generation (ghostwriting)
- Chat history querying
- Style analysis
- Summarization
"""

import logging
import uuid
from anthropic import AsyncAnthropic
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

_client: AsyncAnthropic | None = None


def get_client() -> AsyncAnthropic:
    global _client
    if _client is None:
        if not settings.anthropic_api_key:
            raise ValueError("ANTHROPIC_API_KEY not configured")
        _client = AsyncAnthropic(api_key=settings.anthropic_api_key)
    return _client


async def generate_response(
    system_prompt: str,
    user_prompt: str,
    max_tokens: int = 1024,
    temperature: float = 0.7,
    *,
    user_id: uuid.UUID | None = None,
    operation: str | None = None,
) -> str:
    """Generic Claude call with system + user prompt.

    If user_id and operation are provided, records token usage and cost
    to the api_usage table.
    """
    client = get_client()

    logger.info(
        f"[LLM] Generating response, model={settings.anthropic_model}, "
        f"max_tokens={max_tokens}, temp={temperature}"
    )

    message = await client.messages.create(
        model=settings.anthropic_model,
        max_tokens=max_tokens,
        temperature=temperature,
        system=system_prompt,
        messages=[{"role": "user", "content": user_prompt}],
    )

    response_text = message.content[0].text
    tokens_in = message.usage.input_tokens
    tokens_out = message.usage.output_tokens

    logger.info(
        f"[LLM] Response generated: {tokens_in} input tokens, "
        f"{tokens_out} output tokens"
    )

    # Record cost if caller provided tracking context
    if user_id and operation:
        from app.services.cost_tracker import record_llm_usage

        await record_llm_usage(
            user_id=user_id,
            model=settings.anthropic_model,
            operation=operation,
            input_tokens=tokens_in,
            output_tokens=tokens_out,
        )

    return response_text


# ── Prompt Templates ──────────────────────────────────────────────

GHOSTWRITE_SYSTEM = """You are ghostwriting as {user_name} in a Telegram conversation with {contact_name}.
Your task is to write a response that perfectly mimics {user_name}'s communication style with this specific person.

## {user_name}'s Communication Style with {contact_name}:
{style_profile}

## Relevant Past Conversations:
{retrieved_context}

## Relevant Knowledge/Documents:
{document_context}

## Rules:
1. Match the exact tone, formality, vocabulary, emoji usage, and sentence structure from the style profile
2. Keep response length similar to {user_name}'s typical message length with this person
3. Reference past conversations naturally when relevant — don't force it
4. Never reveal you are an AI — you ARE {user_name}
5. If you need info you don't have, write a natural response {user_name} might send (ask for clarification, say you'll check, etc.)
6. Match the language/dialect {user_name} uses with this person"""

GHOSTWRITE_USER = """## Recent Conversation (newest last):
{recent_messages}

## Task:
Write {user_name}'s next message in this conversation. Respond naturally as {user_name} would.
Output ONLY the message text — no quotes, no labels, nothing else."""


QUERY_SYSTEM = """You are a helpful assistant with access to {user_name}'s Telegram chat history and uploaded documents.
Answer questions based on the provided context. Be specific — cite contact names and approximate dates.
If information isn't in the provided context, say so clearly."""

QUERY_USER = """## Relevant Chat Context:
{retrieved_context}

## Relevant Documents:
{document_context}

## Question:
{question}

Provide a detailed answer based on the context above. Cite which contacts and timeframes the information comes from."""


STYLE_ANALYSIS_PROMPT = """Analyze the following Telegram messages FROM {user_name} TO {contact_name} and create a detailed communication style profile.

Messages from {user_name} to {contact_name}:
{messages_sample}

Create a concise style profile covering:
1. **Tone**: casual/formal/mixed, friendly/professional/playful
2. **Message Length**: short/medium/long, typical patterns
3. **Vocabulary**: Notable words, phrases, slang, jargon
4. **Emoji Usage**: Frequency and common emojis
5. **Greeting/Closing Style**: How they start and end conversations
6. **Response Patterns**: Quick replies vs long thoughtful responses
7. **Language**: Primary language, code-switching patterns
8. **Unique Quirks**: Abbreviations, capitalization habits, distinctive patterns

Be specific and provide brief examples from the messages. Keep it under 300 words."""


SUMMARIZE_SYSTEM = """You are summarizing Telegram conversations for {user_name}.
Be concise, highlight key points, action items, and important topics discussed.
Group by contact when multiple conversations are included."""

SUMMARIZE_USER = """## Conversations to Summarize:
{conversations}

Provide a clear, organized summary. Highlight:
- Key topics discussed
- Action items or pending decisions
- Important information shared
- Anything that needs follow-up"""
