"""Keep links between repository documents valid as plans evolve."""

from pathlib import Path
import re
import unittest
from urllib.parse import unquote


ROOT = Path(__file__).resolve().parents[1]
DOCUMENTS = [ROOT / "PRODUCT_DESIGN.md", ROOT / "README.md", *(ROOT / "docs").rglob("*.md")]
MARKDOWN_LINK = re.compile(r"(?<!!)\[[^]]+\]\(([^)]+)\)")
MARKDOWN_HEADING = re.compile(r"^(#{1,6})\s+\S", re.MULTILINE)


class DocumentationTests(unittest.TestCase):
    def test_next_release_features_are_covered_by_technical_plan(self):
        product = (ROOT / "PRODUCT_DESIGN.md").read_text(encoding="utf-8")
        plan = (ROOT / "docs" / "TECHNICAL_PLAN.md").read_text(encoding="utf-8")
        product_section = product.split("## 下一小版本：", 1)[1].split("\n## ", 1)[0]
        plan_section = plan.split("## 下一小版本实施顺序", 1)[1].split("\n## ", 1)[0]
        features = re.findall(r"^\d+\. \*\*(.+?)\*\*", product_section, re.MULTILINE)
        self.assertTrue(features, "product roadmap should list next-release features")
        for feature in features:
            with self.subTest(feature=feature):
                self.assertIn(feature, plan_section)

    def test_project_documents_have_clear_heading_hierarchy(self):
        for document in sorted(DOCUMENTS):
            levels = [len(markers) for markers in MARKDOWN_HEADING.findall(
                document.read_text(encoding="utf-8")
            )]
            with self.subTest(document=document.relative_to(ROOT)):
                self.assertEqual(levels.count(1), 1, "document needs exactly one title")
                self.assertEqual(levels[0], 1, "title must be the first heading")
                self.assertTrue(all(next_level <= level + 1 for level, next_level in zip(levels, levels[1:])),
                                "heading levels must not skip")

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
