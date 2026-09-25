"""Keep links between repository documents valid as plans evolve."""

from pathlib import Path
import re
import unittest
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DOCS = ROOT / "docs"
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")


class DocumentationTests(unittest.TestCase):
    def test_local_links_in_docs_resolve(self):
        documents = sorted(DOCS.rglob("*.md"))
        self.assertTrue(documents, "docs should contain at least one Markdown file")

        for document in documents:
            content = document.read_text(encoding="utf-8")
            with self.subTest(document=document.relative_to(ROOT)):
                self.assertTrue(content.startswith("# "), "document needs a title")

            for target in MARKDOWN_LINK.findall(content):
                if target.startswith(("https://", "http://", "#")):
                    continue
                path = unquote(target.split("#", 1)[0])
                with self.subTest(document=document.relative_to(ROOT), link=target):
                    self.assertTrue((document.parent / path).is_file())


if __name__ == "__main__":
    unittest.main()
