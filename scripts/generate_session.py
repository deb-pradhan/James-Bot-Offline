"""
Generate a Telethon StringSession for use in deployment.

Run this locally once:
    pip install telethon
    python scripts/generate_session.py

It will prompt for your API ID, API hash, phone number, and OTP.
The resulting session string can be set as TELEGRAM_SESSION_STRING env var.
"""

from telethon.sync import TelegramClient
from telethon.sessions import StringSession

print("=== Telegram Session Generator ===")
print("Get your API credentials from https://my.telegram.org\n")

api_id = int(input("API ID: "))
api_hash = input("API Hash: ")

with TelegramClient(StringSession(), api_id, api_hash) as client:
    session_string = client.session.save()
    print(f"\n✅ Session string (save this as TELEGRAM_SESSION_STRING):\n")
    print(session_string)
    print(f"\nDone! You can now use this in your .env file.")
