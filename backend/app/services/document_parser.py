"""
Document parsing service.

Supports: PDF, DOCX, TXT, MD, and URLs.
Returns extracted text content ready for chunking + embedding.
"""

import logging
import io
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


async def parse_document(
    filename: str,
    content: bytes | None = None,
    url: str | None = None,
) -> str:
    """
    Parse a document and return its text content.

    Args:
        filename: Original filename (used to detect type)
        content: File bytes (for uploaded files)
        url: URL to scrape (for web content)

    Returns:
        Extracted text content
    """
    if url:
        return await parse_url(url)

    if content is None:
        raise ValueError("Either content bytes or URL must be provided")

    ext = Path(filename).suffix.lower()
    logger.info(f"[DOCPARSE] Parsing {filename} (type: {ext}, size: {len(content)} bytes)")

    if ext == ".pdf":
        return parse_pdf(content)
    elif ext == ".docx":
        return parse_docx(content)
    elif ext in (".txt", ".md", ".markdown"):
        return content.decode("utf-8", errors="replace")
    else:
        raise ValueError(f"Unsupported file type: {ext}. Supported: pdf, docx, txt, md")


def parse_pdf(content: bytes) -> str:
    """Extract text from PDF using PyPDF2."""
    from PyPDF2 import PdfReader

    reader = PdfReader(io.BytesIO(content))
    pages = []
    for i, page in enumerate(reader.pages):
        text = page.extract_text()
        if text:
            pages.append(text)

    result = "\n\n".join(pages)
    logger.info(f"[DOCPARSE] PDF: extracted {len(pages)} pages, {len(result)} chars")
    return result


def parse_docx(content: bytes) -> str:
    """Extract text from DOCX using python-docx."""
    from docx import Document

    doc = Document(io.BytesIO(content))
    paragraphs = [p.text for p in doc.paragraphs if p.text.strip()]
    result = "\n\n".join(paragraphs)
    logger.info(
        f"[DOCPARSE] DOCX: extracted {len(paragraphs)} paragraphs, {len(result)} chars"
    )
    return result


async def parse_url(url: str) -> str:
    """Extract main content from a URL using trafilatura."""
    import httpx
    import trafilatura

    logger.info(f"[DOCPARSE] Fetching URL: {url}")

    async with httpx.AsyncClient(timeout=30.0, follow_redirects=True) as client:
        response = await client.get(url)
        response.raise_for_status()

    html = response.text
    extracted = trafilatura.extract(html)

    if not extracted:
        # Fallback: try with BeautifulSoup
        from bs4 import BeautifulSoup

        soup = BeautifulSoup(html, "html.parser")
        for tag in soup(["script", "style", "nav", "footer", "header"]):
            tag.decompose()
        extracted = soup.get_text(separator="\n", strip=True)

    logger.info(f"[DOCPARSE] URL: extracted {len(extracted or '')} chars")
    return extracted or ""


def chunk_document_text(
    text: str,
    chunk_size: int = 500,
    overlap: int = 50,
) -> list[str]:
    """
    Split document text into overlapping chunks for embedding.

    Args:
        text: Full document text
        chunk_size: Target words per chunk
        overlap: Words of overlap between chunks

    Returns:
        List of text chunks
    """
    words = text.split()

    if len(words) <= chunk_size:
        return [text]

    chunks = []
    start = 0
    while start < len(words):
        end = start + chunk_size
        chunk = " ".join(words[start:end])
        chunks.append(chunk)
        start += chunk_size - overlap

    logger.info(
        f"[DOCPARSE] Chunked document into {len(chunks)} chunks "
        f"(avg {sum(len(c.split()) for c in chunks) // len(chunks)} words each)"
    )
    return chunks
