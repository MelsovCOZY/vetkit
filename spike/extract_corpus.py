#!/usr/bin/env python3
"""Extract whole-document text from the haystack-hypothesis corpus.

Reads ~/Projects/haystack-hypothesis/corpus/*.pdf|*.docx (override the
haystack-hypothesis checkout with HAYSTACK_HYPOTHESIS_DIR) using pypdf and
python-docx from that project's own venv, and writes {docId: text} to
spike/data/corpus-text.json. No PDF/DOCX dependency enters this repo.

Run from the vetkit worktree root via:
  uv run --frozen --project ~/Projects/haystack-hypothesis python spike/extract_corpus.py
"""

import json
import os
from pathlib import Path

from docx import Document
from pypdf import PdfReader


def extract_pdf_text(path: Path) -> str:
    reader = PdfReader(str(path))
    return "\n".join(page.extract_text() or "" for page in reader.pages).strip()


def extract_docx_text(path: Path) -> str:
    doc = Document(str(path))
    return "\n".join(p.text for p in doc.paragraphs).strip()


def main() -> None:
    haystack_dir = Path(
        os.environ.get("HAYSTACK_HYPOTHESIS_DIR", str(Path.home() / "Projects" / "haystack-hypothesis"))
    )
    corpus_dir = haystack_dir / "corpus"
    out_path = Path("spike/data/corpus-text.json")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    result: dict[str, str] = {}
    for path in sorted(corpus_dir.iterdir()):
        if path.suffix == ".pdf":
            result[path.name] = extract_pdf_text(path)
        elif path.suffix == ".docx":
            result[path.name] = extract_docx_text(path)

    out_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"extract_corpus.py: wrote {len(result)} docs to {out_path}")


if __name__ == "__main__":
    main()
