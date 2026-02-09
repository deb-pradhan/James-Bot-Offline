"""Email sending utility.

If SMTP is configured, sends real emails.
Otherwise, logs the reset link to console (development fallback).
"""

import logging
import smtplib
from email.mime.text import MIMEText
from email.mime.multipart import MIMEMultipart
from app.config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()


def _smtp_configured() -> bool:
    return bool(settings.smtp_host and settings.smtp_user and settings.smtp_password)


async def send_password_reset_email(to_email: str, reset_token: str) -> None:
    """Send a password reset email (or log the link if SMTP isn't configured)."""
    reset_url = f"{settings.frontend_url}/reset-password?token={reset_token}"

    if not _smtp_configured():
        logger.warning("SMTP not configured — logging reset link to console")
        logger.info(f"[PASSWORD RESET] {to_email} → {reset_url}")
        print(f"\n{'='*60}")
        print(f"  PASSWORD RESET LINK for {to_email}")
        print(f"  {reset_url}")
        print(f"{'='*60}\n")
        return

    subject = "Reset your James Bot password"
    html = f"""\
    <div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #F0F1F3; margin-bottom: 8px;">Password Reset</h2>
        <p style="color: #A0A4AC; font-size: 14px; line-height: 1.5;">
            You requested a password reset for your James Bot account.
            Click the button below to set a new password. This link expires in {settings.reset_token_expire_minutes} minutes.
        </p>
        <a href="{reset_url}"
           style="display: inline-block; margin: 24px 0; padding: 12px 32px;
                  background: #1563FF; color: #fff; text-decoration: none;
                  border-radius: 999px; font-size: 14px; font-weight: 500;">
            Reset Password
        </a>
        <p style="color: #5C6066; font-size: 12px;">
            If you didn't request this, you can safely ignore this email.
        </p>
    </div>
    """

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = f"{settings.smtp_from_name} <{settings.smtp_from_email or settings.smtp_user}>"
    msg["To"] = to_email
    msg.attach(MIMEText(f"Reset your password: {reset_url}", "plain"))
    msg.attach(MIMEText(html, "html"))

    try:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port) as server:
            server.ehlo()
            server.starttls()
            server.ehlo()
            server.login(settings.smtp_user, settings.smtp_password)
            server.send_message(msg)
        logger.info(f"[EMAIL] Password reset email sent to {to_email}")
    except Exception as e:
        logger.error(f"[EMAIL] Failed to send reset email to {to_email}: {e}")
        # Still log the link so the flow isn't completely broken
        logger.info(f"[PASSWORD RESET FALLBACK] {to_email} → {reset_url}")
        print(f"\n{'='*60}")
        print(f"  PASSWORD RESET LINK for {to_email} (email send failed)")
        print(f"  {reset_url}")
        print(f"{'='*60}\n")
