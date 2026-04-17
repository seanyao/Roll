#!/usr/bin/env python3
"""
Deep Research Report: Markdown to PDF converter (WeasyPrint)
Usage: python md_to_pdf.py input.md output.pdf [--title "Report Title"] [--author "Author"]

Dependencies: pip install weasyprint markdown --break-system-packages
"""

import sys
import os
import re
import argparse
import markdown

# ── CSS Styles ──
CSS_TEMPLATE = """
@page {
    size: A4;
    margin: 25mm 20mm 20mm 20mm;

    @top-center {
        content: "HEADER_TEXT";
        font-family: "Droid Sans Fallback", Helvetica, Arial, sans-serif;
        font-size: 8pt;
        color: #95a5a6;
        border-bottom: 0.5pt solid #ecf0f1;
        padding-bottom: 3mm;
    }

    @bottom-center {
        content: "Page " counter(page);
        font-family: "Droid Sans Fallback", Helvetica, Arial, sans-serif;
        font-size: 8pt;
        color: #95a5a6;
        border-top: 0.8pt solid #1a5276;
        padding-top: 2mm;
    }
}

@page :first {
    @top-center { content: none; }
    @bottom-center { content: none; }
}

body {
    font-family: "Droid Sans Fallback", Helvetica, Arial, sans-serif;
    font-size: 10.5pt;
    line-height: 1.75;
    color: #2c3e50;
    text-align: justify;
}

/* Cover page */
.cover {
    page-break-after: always;
    text-align: center;
    padding-top: 45%;
}
.cover h1 {
    font-size: 28pt;
    color: #1a5276;
    margin-bottom: 8mm;
    font-weight: bold;
    letter-spacing: 2pt;
}
.cover .subtitle {
    font-size: 14pt;
    color: #95a5a6;
    margin-bottom: 6mm;
}
.cover .meta {
    font-size: 11pt;
    color: #95a5a6;
    margin-bottom: 4mm;
}
.cover .divider {
    width: 60%;
    margin: 8mm auto;
    border: none;
    border-top: 1.5pt solid #1a5276;
}

/* H1 */
h1 {
    font-size: 20pt;
    color: #1a5276;
    margin-top: 16mm;
    margin-bottom: 6mm;
    padding-bottom: 3mm;
    border-bottom: 2pt solid #1a5276;
    page-break-before: always;
    font-weight: bold;
}

/* H2 */
h2 {
    font-size: 14pt;
    color: #1e8449;
    margin-top: 10mm;
    margin-bottom: 5mm;
    font-weight: bold;
}

/* H3 */
h3 {
    font-size: 12pt;
    color: #2e86c1;
    margin-top: 6mm;
    margin-bottom: 3mm;
    font-weight: bold;
}

h4 {
    font-size: 11pt;
    color: #5b2c6f;
    margin-top: 5mm;
    margin-bottom: 2mm;
    font-weight: bold;
}

/* Paragraphs */
p {
    margin-top: 1.5mm;
    margin-bottom: 1.5mm;
    orphans: 3;
    widows: 3;
}

/* Blockquotes */
blockquote {
    margin: 4mm 0;
    padding: 4mm 4mm 4mm 10mm;
    background: #f8f9fa;
    border-left: 3pt solid #1a5276;
    color: #5d6d7e;
    font-size: 10pt;
}
blockquote p {
    margin: 1mm 0;
}

/* Bold */
strong, b {
    font-weight: bold;
    color: #1a252f;
}

/* Inline code */
code {
    font-family: "Courier New", Courier, monospace;
    background: #fdf2e9;
    color: #c0392b;
    padding: 0.5mm 1.5mm;
    border-radius: 2pt;
    font-size: 9.5pt;
}

/* Tables */
table {
    width: 100%;
    border-collapse: collapse;
    margin: 4mm 0;
    font-size: 9.5pt;
}
thead th {
    background: #1a5276;
    color: white;
    padding: 3mm;
    text-align: left;
    font-weight: bold;
}
tbody td {
    padding: 2.5mm 3mm;
    border-bottom: 0.5pt solid #bdc3c7;
}
tbody tr:nth-child(even) {
    background: #f8f9fa;
}

/* Horizontal rule */
hr {
    border: none;
    border-top: 0.5pt solid #bdc3c7;
    margin: 4mm 0;
}

/* Lists */
ul, ol {
    margin: 2mm 0;
    padding-left: 8mm;
}
li {
    margin-bottom: 1mm;
}

/* Links */
a {
    color: #2e86c1;
    text-decoration: none;
}
"""


def md_to_html(md_text, title="Deep Research Report", subtitle="Let's roll",
               meta_line="", author="roll"):
    """Convert Markdown to HTML with cover page"""

    # Convert body with markdown library
    html_body = markdown.markdown(
        md_text,
        extensions=['tables', 'fenced_code', 'nl2br'],
        output_format='html5'
    )

    # Extract first H1 for cover (remove from body)
    first_h1_match = re.search(r'<h1>(.*?)</h1>', html_body)
    if first_h1_match:
        extracted_title = first_h1_match.group(1)
        if not title or title == "Deep Research Report":
            title = extracted_title
        html_body = html_body.replace(first_h1_match.group(0), '', 1)

    # Replace header placeholder in CSS
    css = CSS_TEMPLATE.replace("HEADER_TEXT", f"{title}  |  Deep Research Report")

    # Build cover page
    cover_html = f"""
    <div class="cover">
        <h1 style="page-break-before: avoid; border: none;">{title}</h1>
        <div class="subtitle">{subtitle}</div>
        {"<div class='meta'>" + meta_line + "</div>" if meta_line else ""}
        <hr class="divider">
        <div class="meta">Author: {author}</div>
    </div>
    """

    full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <style>{css}</style>
</head>
<body>
{cover_html}
{html_body}
</body>
</html>"""

    return full_html


def main():
    parser = argparse.ArgumentParser(description="Deep Research Report: Markdown to PDF")
    parser.add_argument("input", help="Input Markdown file path")
    parser.add_argument("output", help="Output PDF file path")
    parser.add_argument("--title", default=None, help="Report title")
    parser.add_argument("--author", default="roll", help="Author name")
    parser.add_argument("--subtitle", default="Let's roll", help="Report subtitle")
    args = parser.parse_args()

    with open(args.input, "r", encoding="utf-8") as f:
        md_text = f.read()

    # Extract metadata line
    meta_line = ""
    for line in md_text.split("\n"):
        stripped = line.strip().lstrip(">").strip()
        if "research date" in stripped.lower() or "field:" in stripped.lower() or "subject type" in stripped.lower():
            meta_line = stripped
            break

    html = md_to_html(md_text, title=args.title or "Deep Research Report",
                      subtitle=args.subtitle, meta_line=meta_line, author=args.author)

    # Save intermediate HTML (for debugging)
    html_path = args.output.replace('.pdf', '.html')
    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f"[OK] HTML generated: {html_path}")

    # Convert to PDF
    from weasyprint import HTML
    HTML(string=html).write_pdf(args.output)
    size_kb = os.path.getsize(args.output) / 1024
    print(f"[OK] PDF generated: {args.output} ({size_kb:.1f} KB)")


if __name__ == "__main__":
    main()
