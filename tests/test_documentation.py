"""Keep links between repository documents valid as plans evolve."""

from pathlib import Path
import re
import unittest
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = [ROOT / "PRODUCT_DESIGN.md", ROOT / "README.md", *(ROOT / "docs").rglob("*.md")]
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")


class DocumentationTests(unittest.TestCase):
    def test_local_links_in_project_documents_resolve(self):
        documents = sorted(DOCUMENTS)
        self.assertTrue(documents, "repository should contain Markdown files")

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
