"""
Step 1 (Python half): turn one PDF into overlapping text chunks.

Usage:
    python3 extract_and_chunk.py /path/to/file.pdf

Prints a single JSON object to stdout: {"source_file": ..., "chunks": [...]}.
Node will later spawn this script as a subprocess per file and parse that
JSON (see _project_step_by_step_plan.md, "Node<->Python handoff").

This script does NOT call the embedding model yet -- that's the next safe
step, added once we've eyeballed the chunk boundaries on real files.
"""

import json
import sys

from pypdf import PdfReader

# bge-large is a BERT-based embedding model, and BERT-family models hard-cap
# input at 512 tokens -- anything longer is silently truncated by the model,
# not rejected. 350 words gives comfortable headroom under that ceiling even
# for dense, jargon-heavy legal prose (which tends to tokenize a bit longer
# per word than plain English). 50-word overlap (~15%) keeps a sentence that
# lands right on a chunk boundary readable in whichever chunk it ends up in.
CHUNK_SIZE_WORDS = 350
CHUNK_OVERLAP_WORDS = 50


def extract_words_with_pages(pdf_path):
    """
    Read every page of the PDF and return a flat list of (word, page_number)
    tuples, page_number starting at 1. Flattening to a word-level list (instead
    of keeping text as one big per-document string) is what lets us later know
    which page(s) a given chunk came from, without doing brittle character-
    offset math.
    """
    reader = PdfReader(pdf_path)
    words_with_pages = []

    for page_number, page in enumerate(reader.pages, start=1):
        page_text = page.extract_text() or ""
        # .split() with no args collapses all whitespace (including newlines),
        # which is what we want -- PDF text extraction often inserts odd
        # line breaks mid-sentence that we don't want to preserve.
        for word in page_text.split():
            words_with_pages.append((word, page_number))

    return words_with_pages


def build_chunks(words_with_pages):
    """
    Slide a CHUNK_SIZE_WORDS-wide window over the word list, stepping forward
    by (CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS) words each time, so consecutive
    chunks share a run of overlapping words. Each chunk records the page range
    it spans, taken from the first and last word in that chunk's window.
    """
    chunks = []
    step = CHUNK_SIZE_WORDS - CHUNK_OVERLAP_WORDS
    total_words = len(words_with_pages)

    if total_words == 0:
        return chunks

    chunk_index = 0
    start = 0
    while start < total_words:
        end = min(start + CHUNK_SIZE_WORDS, total_words)
        window = words_with_pages[start:end]

        chunk_words = [word for word, _page in window]
        chunk_pages = [page for _word, page in window]

        chunks.append({
            "chunk_index": chunk_index,
            "text": " ".join(chunk_words),
            "word_count": len(chunk_words),
            "page_start": chunk_pages[0],
            "page_end": chunk_pages[-1],
        })

        chunk_index += 1
        start += step

        # Once the window reaches the end of the document, stop -- otherwise
        # a short final overlap-only step would produce a near-duplicate
        # trailing chunk.
        if end == total_words:
            break

    return chunks


def main():
    if len(sys.argv) != 2:
        print("usage: python3 extract_and_chunk.py <path_to_pdf>", file=sys.stderr)
        sys.exit(1)

    pdf_path = sys.argv[1]

    words_with_pages = extract_words_with_pages(pdf_path)
    chunks = build_chunks(words_with_pages)

    result = {
        "source_file": pdf_path,
        "total_words": len(words_with_pages),
        "chunk_count": len(chunks),
        "chunks": chunks,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
