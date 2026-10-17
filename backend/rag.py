"""Load, chunk, index and retrieve passages from the Rules of Golf PDF.

Retrieval is a small self-contained BM25 implementation so there are no
native/compiled dependencies beyond pypdf.
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

from pypdf import PdfReader

CHUNK_SIZE = 1000
CHUNK_OVERLAP = 200

# Private-use glyphs and odd spaces that pypdf emits for this document.
_CHAR_FIXES = str.maketrans({"": " ", "": "-", "\xa0": " "})
_APOSTROPHES = str.maketrans("", "", "'’")
_RULE_HEADING = re.compile(r"^Rule\s+\d+\s*[–-].*$", re.MULTILINE)
_TOKEN = re.compile(r"[a-z0-9]+")
_SPACES = re.compile(r"[ \t]+")
_SPACES_AROUND_NEWLINE = re.compile(r" *\n *")
_BLANK_LINES = re.compile(r"\n{2,}")

STOPWORDS = frozenset(
    """a an and are as at be but by can do does for from has have how i if in into is it
    its me my of on or so than that the their them then there these they this to up was
    we what when where which who why will with you your yours am any all about after
    before should would could may might must not no""".split()
)


def tokenize(text: str) -> list[str]:
    tokens = []
    for tok in _TOKEN.findall(text.lower().translate(_APOSTROPHES)):
        if tok in STOPWORDS:
            continue
        # Light stemming so "clubs"/"club", "penalties"/"penalty" match.
        if len(tok) > 4 and tok.endswith("ies"):
            tok = tok[:-3] + "y"
        elif len(tok) > 3 and tok.endswith("s") and not tok.endswith("ss"):
            tok = tok[:-1]
        tokens.append(tok)
    return tokens


@dataclass(frozen=True, slots=True)
class Chunk:
    id: int
    page: int  # 1-based
    text: str


@dataclass(frozen=True, slots=True)
class SearchHit:
    chunk: Chunk
    score: float


def _clean(text: str) -> str:
    text = text.translate(_CHAR_FIXES)
    text = _SPACES.sub(" ", text)
    text = _SPACES_AROUND_NEWLINE.sub("\n", text)
    text = _BLANK_LINES.sub("\n", text)
    return text.strip()


def _split_page(text: str, size: int, overlap: int) -> list[str]:
    """Pack lines into ~size-char windows, carrying ~overlap chars forward."""
    lines = [ln for ln in text.split("\n") if ln.strip()]
    chunks: list[str] = []
    current: list[str] = []
    length = 0
    for line in lines:
        if current and length + len(line) + 1 > size:
            chunks.append("\n".join(current))
            # Keep trailing lines as overlap for the next window.
            carry: list[str] = []
            carried = 0
            for prev in reversed(current):
                if carried + len(prev) > overlap:
                    break
                carry.insert(0, prev)
                carried += len(prev) + 1
            current, length = carry, carried
        current.append(line)
        length += len(line) + 1
    if current:
        chunks.append("\n".join(current))
    return chunks


def load_chunks(pdf_path: Path, size: int = CHUNK_SIZE, overlap: int = CHUNK_OVERLAP) -> tuple[int, list[Chunk]]:
    reader = PdfReader(str(pdf_path))
    chunks: list[Chunk] = []
    last_heading = ""
    for page_no, page in enumerate(reader.pages, start=1):
        text = _clean(page.extract_text() or "")
        if not text:
            continue
        for piece in _split_page(text, size, overlap):
            # Prefix the governing rule heading so retrieval and the model
            # know which rule a mid-rule chunk belongs to.
            if last_heading and not piece.startswith("Rule "):
                body = f"[{last_heading}]\n{piece}"
            else:
                body = piece
            chunks.append(Chunk(id=len(chunks), page=page_no, text=body))
            if headings := _RULE_HEADING.findall(piece):
                last_heading = headings[-1].strip()
    return len(reader.pages), chunks


@dataclass
class BM25Index:
    chunks: list[Chunk]
    k1: float = 1.5
    b: float = 0.75
    # term -> [(chunk index, term frequency)]; a search only visits chunks containing a query term.
    _postings: dict[str, list[tuple[int, int]]] = field(init=False, repr=False)
    _idf: dict[str, float] = field(init=False, repr=False)
    # Per-chunk length normalisation: k1 * (1 - b + b * len / avgdl).
    _norms: list[float] = field(init=False, repr=False)

    def __post_init__(self) -> None:
        tfs = [Counter(tokenize(c.text)) for c in self.chunks]
        lens = [tf.total() for tf in tfs]
        avgdl = sum(lens) / len(lens) if any(lens) else 1.0
        self._norms = [self.k1 * (1 - self.b + self.b * length / avgdl) for length in lens]

        self._postings = defaultdict(list)
        for i, tf in enumerate(tfs):
            for term, freq in tf.items():
                self._postings[term].append((i, freq))
        n = len(self.chunks)
        self._idf = {
            term: math.log(1 + (n - len(docs) + 0.5) / (len(docs) + 0.5))
            for term, docs in self._postings.items()
        }

    def search(self, query: str, k: int = 5) -> list[SearchHit]:
        scores: defaultdict[int, float] = defaultdict(float)
        for term in set(tokenize(query)):
            idf = self._idf.get(term)
            if idf is None:
                continue
            for i, freq in self._postings[term]:
                scores[i] += idf * freq * (self.k1 + 1) / (freq + self._norms[i])
        ranked = sorted(((s, i) for i, s in scores.items()), reverse=True)
        return [SearchHit(self.chunks[i], s) for s, i in ranked[:k]]


class GolfRulesIndex:
    """Facade used by the API: loads the PDF once and answers searches."""

    def __init__(self, pdf_path: Path):
        self.pdf_path = pdf_path
        self.pages, self.chunks = load_chunks(pdf_path)
        self.bm25 = BM25Index(self.chunks)

    def retrieve(self, query: str, k: int = 5) -> list[SearchHit]:
        return self.bm25.search(query, k)


def snippet(text: str, limit: int = 200) -> str:
    # Drop the injected "[Rule ...]" prefix line for display.
    if text.startswith("["):
        text = text.split("\n", 1)[-1]
    text = " ".join(text.split())
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"
