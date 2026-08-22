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
import re
import sys

from pypdf import PdfReader

# Correctly extracted text never contains C0 control characters. Tab, newline
# and carriage return are the only legitimate ones and .split() has already
# collapsed those away by the time a chunk is built, so anything left in this
# range is proof the extraction is wrong -- not merely ugly.
#
# This exists because of a real, expensive failure. 20 of the 76 source PDFs
# embed subsetted fonts (tagged like "BUULZJ+LiberationSans") whose glyph IDs
# are offset from Unicode and which ship no /ToUnicode map. With no mapping to
# apply, a PDF library can only report the raw glyph codes, so the text comes
# out uniformly shifted: "0D[ZHOO GHIDPHG 9LUJLQLD" is "Maxwell defamed
# Virginia" shifted by +29, and the space (0x20) lands on 0x03. This is not a
# library defect -- pypdf and PyMuPDF produce byte-identical output here,
# because the information genuinely is not in the file.
#
# The damage was done by how quietly it failed. 74 chunks were affected; only
# 3 broke extraction loudly. The other 71 were handed to the LLM, which could
# not read them and confabulated instead -- 280 entity mentions including
# "Donald Trump", "Courtney Love" and "Elie Wiesel" as defendants, none of them
# present in the documents, plus mojibake stored verbatim as an entity name.
# In a legal knowledge graph a fabricated party is far worse than a missing
# one, and after dedup it is indistinguishable from a real one.
#
# Hence: reject, don't repair. Repair means guessing the offset per font run,
# which is reconstruction dressed up as extraction. Zero tolerance rather than
# a percentage threshold because the measured distribution is continuous from
# 0.03% to 31% with no natural gap -- any cutoff would be an arbitrary number
# needing perpetual tuning, where "clean text has none of these" is an
# invariant that never needs revisiting.
CONTROL_CHARS = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f]")

# The court's CM/ECF system stamps every page with a header like
#   Case 1:15-cv-07433-LAP Document 1327-27 Filed 01/05/24 Page 1 of 6
# pypdf emits text in PDF content-stream order rather than reading order, so
# these land *inside* sentences. Measured on the corpus: present in 83% of
# chunks, 4,507 occurrences, and spliced mid-prose in 19% of chunks -- one
# deposition answer read "...a woman by the name of Lynn STEVEN W OLSON
# 5/26/2016 37 Case 1:15-cv-07433-LAP Document 1325-", burying "Lynn Miller".
#
# The damage is broader than unreadable sentences. This furniture is what the
# extractor keeps mistaking for content: Bates stamps typed as people, case
# captions typed as courts, the whole "reference" enum value and
# REFERENCE_SIGNAL_PATTERN downstream exist to clean up after it. It also
# pollutes every +/-15-word context snippet and therefore every embedding.
#
# Safe to strip because it is a fixed template, not a judgment call: masking
# the digits across the corpus yields only 33 distinct shapes, all the same
# form. This pattern matches 4,486 of 4,507 (99.5%). A citation in running
# prose never carries "Document N Filed DATE Page N of M".
#
# Deliberately NOT stripping Bates stamps, though they are also furniture: a
# probe for them matched "CV-07433" 59 times, which is part of the docket
# number, not a stamp. They are single tokens rather than sentence-length
# interruptions, so they cost little in place, and filterNoiseEntities already
# discards them as entities. Removing them needs a discriminator this good,
# and that one is not.
#
# Captured rather than discarded: the count travels back in the JSON, and the
# page provenance it encodes is already stored independently as page_start /
# page_end and per-chunk docket_numbers.
CMECF_HEADER = re.compile(
    r"Case\s+\d+:\d+-[a-z]{2}-\d+-[A-Z]{2,4}\s+"
    r"Document\s+\d+(?:-\d+)?\s+"
    r"Filed\s+\d{1,2}/\d{1,2}/\d{2,4}\s+"
    r"Page\s+\d+\s+of\s+\d+"
)

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
    headers_stripped = 0

    for page_number, page in enumerate(reader.pages, start=1):
        page_text = page.extract_text() or ""
        # Strip before .split() so a header spliced mid-sentence rejoins the
        # words it interrupted, rather than leaving a gap where it sat.
        page_text, n = CMECF_HEADER.subn(" ", page_text)
        headers_stripped += n
        # .split() with no args collapses all whitespace (including newlines),
        # which is what we want -- PDF text extraction often inserts odd
        # line breaks mid-sentence that we don't want to preserve.
        for word in page_text.split():
            words_with_pages.append((word, page_number))

    return words_with_pages, headers_stripped


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

    words_with_pages, headers_stripped = extract_words_with_pages(pdf_path)
    all_chunks = build_chunks(words_with_pages)

    # Partition rather than filter. A dropped chunk has to stay *countable* --
    # the original bug was corruption passing through unnoticed, and silently
    # discarding it would reproduce that same failure wearing a different hat.
    # rejected_chunks travels back to Node in the JSON so the caller can log
    # it; stderr is not an option here, since pythonExtractor.js only surfaces
    # stderr on a non-zero exit and a partly-unreadable PDF is not an error.
    chunks = []
    rejected = []
    for chunk in all_chunks:
        bad = CONTROL_CHARS.findall(chunk["text"])
        if bad:
            rejected.append({
                "chunk_index": chunk["chunk_index"],
                "page_start": chunk["page_start"],
                "page_end": chunk["page_end"],
                "control_char_count": len(bad),
                "reason": "control characters in extracted text (unmapped font encoding)",
            })
        else:
            chunks.append(chunk)

    result = {
        "source_file": pdf_path,
        "total_words": len(words_with_pages),
        "chunk_count": len(chunks),
        "headers_stripped": headers_stripped,
        "rejected_chunk_count": len(rejected),
        "rejected_chunks": rejected,
        "chunks": chunks,
    }

    print(json.dumps(result))


if __name__ == "__main__":
    main()
