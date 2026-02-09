"""
Per-contact style analysis using Claude.

Analyzes James's messages TO a specific contact to build a style profile
that enables accurate ghostwriting.
"""

import logging
import uuid
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy import select
from app.models.contact import Contact
from app.models.message import Message
from app.services.llm import generate_response, STYLE_ANALYSIS_PROMPT

logger = logging.getLogger(__name__)

MAX_SAMPLE_MESSAGES = 50  # Sample size for style analysis


async def analyze_contact_style(
    db: AsyncSession,
    user_id: uuid.UUID,
    contact: Contact,
    user_name: str,
) -> str:
    """
    Analyze James's communication style with a specific contact.

    Samples up to MAX_SAMPLE_MESSAGES of James's messages to this contact,
    sends them to Claude for style analysis, and returns a style profile.
    """
    logger.info(f"[STYLE] Analyzing style for contact: {contact.display_name}")

    # Fetch James's messages to this contact (sender_type = "self")
    stmt = (
        select(Message)
        .where(
            Message.contact_id == contact.id,
            Message.sender_type == "self",
        )
        .order_by(Message.sent_at.desc())
        .limit(MAX_SAMPLE_MESSAGES)
    )
    result = await db.execute(stmt)
    messages = result.scalars().all()

    if len(messages) < 3:
        logger.info(
            f"[STYLE] Too few messages ({len(messages)}) for {contact.display_name}, "
            "using default profile"
        )
        return "Insufficient message history for detailed style analysis. Use a natural, conversational tone."

    # Format messages for the prompt
    sample_text = "\n".join(
        [f"- {msg.content}" for msg in reversed(messages)]
    )

    prompt = STYLE_ANALYSIS_PROMPT.format(
        user_name=user_name,
        contact_name=contact.display_name,
        messages_sample=sample_text,
    )

    style_profile = await generate_response(
        system_prompt="You are a communication style analyst. Analyze the provided messages and create a detailed style profile.",
        user_prompt=prompt,
        temperature=0.3,
        max_tokens=500,
        user_id=user_id,
        operation="style_analysis",
    )

    logger.info(
        f"[STYLE] Style profile generated for {contact.display_name} "
        f"(based on {len(messages)} messages)"
    )

    return style_profile
