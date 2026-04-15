---
hidden: true
name: cnx-research
description: |
  Horizontal-Vertical (HV) Analysis deep research skill. A systematic framework for researching products, companies, concepts, technologies, or people.
  Core approach: dual-axis analysis — the vertical axis traces the complete lifecycle from origin to present (as a narrative), the horizontal axis performs systematic comparison with competitors/peers at the current point in time, then cross-axis insights emerge from combining both perspectives. Final output is a professionally formatted PDF research report.
  Trigger phrases include: deep research, research this, analyze this, competitive analysis, help me understand, what's the deal with, help me figure out, do a deep dive, HV analysis.
  Even if the user just says "help me look into XX" or "what's the story behind XX", as long as the context implies a need for systematic deep research (not a simple definition), this skill should be triggered.
  Do not use for: simple definitions (user just asks "what is XX"), short-form content writing, or pure title/summary generation.
---

# Deep Research (HV Analysis)

> Follows the Architecture Constraints, Development Discipline, and Engineering Common Sense defined in the project AGENTS.md.

> **Methodology**
> The Horizontal-Vertical (HV) Analysis framework combines diachronic-synchronic analysis (Saussure), longitudinal-cross-sectional research design from social sciences, business school case study methods, and competitive strategy analysis into a universal research framework applicable to products, companies, concepts, and people. Core principle: the vertical axis traces depth through time, the horizontal axis traces breadth across peers, and the intersection produces judgment.

You are executing an HV Analysis deep research session. The final deliverable is a **professionally formatted PDF research report**.

## Prerequisites

### Environment Setup

1. **Confirm PDF conversion script is available**: This skill includes `scripts/md_to_pdf.py` (based on WeasyPrint) for converting the final Markdown report into a well-formatted PDF. Ensure dependencies are installed: `pip install weasyprint markdown --break-system-packages`.
2. **Writing style**: This skill includes a complete writing style guide (see "Writing Style" section below).

### Define the Research Subject

After receiving user input, confirm the following. If the user has already been specific enough (e.g., "do a deep research on Hermes Agent"), start directly without asking:

1. **Research subject**: Specific product name / company name / concept name / person name
2. **Type**: Product, company, concept, person, or other?
3. **Research motivation** (optional): Why research this? What recently happened?
4. **Special focus** (optional): Any particular direction to dive deeper into?

---

## Step 1: Online Information Gathering

The quality of this methodology depends entirely on the richness and accuracy of the information collected. **Online search is mandatory** — do not rely solely on existing knowledge. The value of a research report lies in its depth and completeness, so gather more rather than less during this phase.

### Parallel Search Strategy

Use sub-agents to search in parallel for efficiency. Suggested division of labor:

- **Sub-Agent 1 — Vertical info**: Origin of the research subject, founder background, development history, key events, version iterations, funding, strategic pivots, crises
- **Sub-Agent 2 — Horizontal info**: Competitor identification, each competitor's characteristics and user reputation, industry comparison reviews, market share
- **Sub-Agent 3** (only for complex subjects): Supplementary info such as founder deep background, industry environment changes, user community discussions (GitHub issues, Reddit, Twitter/X, HackerNews, etc.)

**Sub-Agent web tool usage guide** (include directly in each sub-agent's prompt):

Each sub-agent's prompt must include the following web access instructions:

> You need to gather information from the web. Use the following tools:
> - **WebSearch**: For discovering information sources, getting summaries and keyword results
> - **WebFetch**: When a specific URL is known, for targeted content extraction from pages
> - Search strategy: First use WebSearch to discover sources and leads, then use WebFetch to extract details from specific URLs
> - Multiple searches with multiple keyword combinations — don't give up after one search
> - Primary sources over secondary: official blogs > authoritative original media reports > reposts/aggregators
> - **Academic subjects must check arXiv**: If the subject involves academic concepts, algorithms, AI models, or technical paradigms, query arXiv API for relevant papers: `curl -s "https://export.arxiv.org/api/query?search_query=all:keyword1+AND+all:keyword2&max_results=10"`, or use WebFetch on the same URL. Returns XML with titles, authors, abstracts, dates, PDF links. After finding key papers, use WebFetch on `https://arxiv.org/abs/PAPER_ID` for more details.

Prompt descriptions should use goal-oriented verbs ("gather", "investigate", "understand"), not method-specific verbs ("search", "crawl"), letting sub-agents determine the best approach.

### Source Priority

Primary sources over secondary — multiple outlets citing the same error creates a false corroboration illusion:

| Information Type | Primary Sources |
|-----------------|----------------|
| Product updates / technical decisions | Official blog, GitHub Release Notes, founder tweets |
| Funding / business data | Official company announcements, SEC/regulatory filings |
| User reputation | GitHub Issues, Reddit discussions, Twitter/X, HackerNews |
| Industry analysis | Authoritative original media reports (not reposts) |
| Academic / technical principles | arXiv papers (`export.arxiv.org/api/query`), Google Scholar, conference proceedings |

### Information Sufficiency Self-Check

After searching, verify:
- Vertical: Can you tell a complete story? Are there obvious information gaps?
- Horizontal: Is the competitor list complete? Are any major players missing? Is there enough info on each competitor for comparison?
- Sources: Are key facts supported by reliable sources? Are any judgments based on a single source?

If information is insufficient, search more. Don't settle.

---

## Step 2: Vertical Analysis (Diachronic / Longitudinal)

Trace the complete timeline, fully reconstructing the research subject's journey from birth to present. This is the main body of the report and should be the longest section.

### Content Requirements

**Origin tracing**: What was the background when it was born? What technology/philosophy/need was it based on? Who were the founding team or core drivers? What had these people done before, and why were they the ones to do this? What was the industry environment like? Was there a key event or inspiration that directly prompted its creation?

**Birth node**: Exact first release/founding/proposal date, initial form and positioning, how it differs from today.

**Evolution trajectory**: From birth to present, organize all key milestones chronologically. Including but not limited to: major version updates, funding events, team changes, strategic pivots, technical architecture changes, user scale milestones, major partnerships or acquisitions, PR crises or controversies.

**Decision logic**: At each key node, reconstruct the reasoning behind decisions as much as possible. Why choose A over B? What were the constraints at the time? Which early decisions "locked in" later development directions and became irreversible? What mechanisms deepened the path (network effects, ecosystem lock-in, tech stack choices, etc.)?

**Phase segmentation**: Naturally divide the entire journey into phases (inception, rapid growth, transformation, etc.), each with core characteristics and core tensions.

### Length

6,000–15,000 words. Subjects with longer histories and more milestones should be near the upper limit; newer subjects near the lower. The core principle is to tell the story completely and thoroughly — every key milestone deserves expansion. Don't skip important details for brevity. Better to write long and detailed than to skim the surface.

---

## Step 3: Horizontal Analysis (Synchronic / Cross-sectional)

Using the current point in time as the cross-section, comprehensively compare the research subject with competitors/peers in the same space.

### First, Assess the Competitive Landscape

Handle three scenarios:

**Scenario A: No direct competitors.** If the subject is an entirely new category or an extremely dominant field, skip individual comparisons. Instead analyze: Why are there no competitors? Is the category too new, barriers too high, or market too small? Where are competitors most likely to emerge from? Are there indirect alternatives or previous-generation solutions for reference?

**Scenario B: Few competitors (1–2).** Deep-dive comparison of each, with detailed analysis per competitor.

**Scenario C: Sufficient competitors (3+).** Select the 3–5 most representative for comparison, briefly mention the rest.

### Comparison Dimensions

Flexibly adjust based on the research subject's type, but cover at least:

**Core difference comparison**: Technical approach / core methodology / underlying logic, product form / business model / organizational structure, target users / audience / applicable scenarios, core strengths and obvious weaknesses, pricing strategy / resource investment / scale.

**User perspective**: What is each competitor's real user reputation? What are the most frequently mentioned pros and cons in community reviews and usage experience? Is there a gap between how users actually use it and the official positioning? Don't write comparisons as a text version of a spec sheet — explain what each competitor "actually became" and the real reasons users choose it.

**Ecosystem niche analysis**: In the overall landscape, what position does the research subject occupy? What gap does it fill, or whom is it competing head-to-head with? Is the current landscape a hundred flowers blooming, a duopoly, or a monopoly?

**Trend judgment**: Based on horizontal comparison, what is the research subject's trajectory in the competitive landscape? What are the opportunities and risks?

### Length

3,000–10,000 words. Scenario A should be around 3,000 words. Scenario C requires at least 1,500 words of independent analysis per major competitor — don't brush over them.

---

## Step 4: Cross-Axis Insights

This is the crown jewel of the entire report. Combine the vertical development trajectory and horizontal competitive landscape to produce comprehensive, new judgments. Do not write this as an abbreviated version of the previous sections.

Core questions to answer:

1. **How history shaped the current competitive position**: Which decisions and events from the vertical trajectory determined where it stands in today's horizontal comparison?
2. **Longitudinal comparison of competitors**: If major competitors are also placed on the timeline, how do their origins and evolution paths differ? How did these differences lead to their current characteristics?
3. **Historical roots of current advantages**: Each core advantage today — which historical node or decision can it be traced back to?
4. **Historical roots of current disadvantages**: Each core weakness today — which historical decision can it be traced back to? Did any "good decisions" from the past become today's burden?
5. **Future projection**: Based on vertical trends and horizontal competitive landscape, provide three scenarios — most likely, most dangerous, most optimistic — each with logical support.

### Length

1,500–3,000 words.

---

## Writing Style

This is not a cold consulting report, but a deep research piece that people can read from start to finish. The writing style needs to balance "research report rigor" with "readability and narrative engagement."

### Core Style Elements

**Rhythm**: Vary sentence lengths, with natural jumps between paragraphs. Don't make every paragraph the same length. A single sentence forming its own paragraph creates weight. Good rhythm is like a wave — each time it drifts slightly from the main thread, then a "hook-back sentence" pulls it back.

**Narrative-driven, not list-driven**: The vertical section should have a story arc with setup, development, twist, and resolution. For example, why a product suddenly exploded at a certain point — what was the groundwork, what was the turning point. Don't write "in January 2023 they released A, in March 2023 they released B" — that's a timeline, not a story.

**Knowledge emerges naturally**: Weave background knowledge into the narrative naturally, don't announce "now let me explain this concept."

**Bold judgments**: Offer opinions and insights, but every opinion must be backed by facts. Present facts first, then judgment. Mark speculation explicitly. Use "I believe" or "my assessment is" — acknowledging subjectivity rather than delivering pronouncements from on high.

**Layered revelation**: Don't jump to conclusions. Use the pattern: phenomenon → surface explanation → deeper questioning → core insight. Let the reader participate in the thinking process.

**Cultural elevation**: In the cross-axis insights section, connect to larger cultural/philosophical/historical reference points. Not forced elevation, but "naturally came to mind while discussing."

**Callback structure**: Details and hooks planted in the opening or vertical section should callback in the cross-axis insights or conclusion. This sense of causal closure is what transforms a report from an "information stream" into a "work."

### Absolute Prohibitions

These AI-flavor markers must be avoided regardless of format:
- Cliches: "First... Second... Finally", "In summary", "It's worth noting", "It's not hard to see"
- Empty adjectives: "empower", "leverage", "build a closed loop"
- Textbook openings: "In today's era of rapid AI development", "As technology continues to advance"
- Generic tool names: don't say "an AI tool" or "a certain model" — use specific names
- Fabricated scenarios: If information can't be found, honestly mark "information unavailable" — never fabricate

### Write Like a Human

Avoid consulting-firm-style cliches and empty generalizations. Replace summary statements with specific details and examples. Don't write "the company achieved rapid growth during this period" — write "from $10M ARR in mid-2024 to $1B by end of 2025, the growth curve was nearly vertical."

---

## Step 5: Generate PDF Report

After the report is complete, use this skill's included `scripts/md_to_pdf.py` to convert Markdown to a professionally formatted PDF.

### Conversion Process

1. **Complete the Markdown draft first**: Write the full report in standard Markdown, save as `{subject}_research_report.md`
2. **Install dependencies** (if not installed): `pip install weasyprint markdown --break-system-packages`
3. **Run the conversion script**:
   ```bash
   python [skill_directory]/scripts/md_to_pdf.py input.md output.pdf --title "Subject Name" --author "cybernetix"
   ```
4. The script automatically generates an intermediate HTML file (for debugging) and the final PDF

### Built-in Layout Specifications

`md_to_pdf.py` includes a complete CSS layout — no manual adjustment needed:

- **Page**: A4, margins top 25mm / left-right 20mm / bottom 20mm
- **Cover page**: Auto-generated with title (28pt dark blue), subtitle "Let's roll", author info, decorative divider
- **Colors**: H1=#1a5276 dark blue, H2=#1e8449 green, H3=#2e86c1 light blue, H4=#5b2c6f purple, body=#2c3e50 dark gray
- **Fonts**: CSS fallback chain `"Droid Sans Fallback", Helvetica, Arial, sans-serif`, handles mixed-language text
- **Body**: 10.5pt, line-height 1.75, justified, orphan/widow control
- **Blockquotes**: 3pt dark blue left border + light gray background
- **Tables**: Full width, dark blue header with white text, zebra-striped rows
- **Header**: "{Report Title} | Deep Research Report" (not on first page)
- **Footer**: "Page X" (not on first page)
- The first H1 in Markdown is auto-extracted as the cover title and not repeated in the body

### Markdown Writing Notes

For the script to parse correctly and produce optimal PDF output:

- Use `# Title` on the first line as the report title (auto-used for cover)
- Immediately after the title, optionally use `> Research date: ... | Field: ... | Subject type: ...` for metadata (extracted to cover)
- Use `##` for main chapter headings (Vertical Analysis, Horizontal Analysis, Cross-Axis Insights, etc.)
- Use `###` and `####` for subchapters
- Tables use standard Markdown table syntax
- Quotes use `>` syntax
- Bold uses `**text**`

### Closing Content

At the end of the Markdown draft, include:
- **Sources**: List of all cited sources with URLs and access dates
- **Methodology note**: Brief note on the HV Analysis framework (1–2 sentences)

### Report Structure Template

```
Cover Page

Table of Contents

I. One-Sentence Definition
[Clearly define what this thing is in one sentence]

II. Vertical Analysis: From Origin to Present
[Complete vertical narrative, 6,000–15,000 words]

III. Horizontal Analysis: Competitive Landscape
[Horizontal comparison analysis, 3,000–10,000 words]

IV. Cross-Axis Insights
[Cross analysis and future projection, 1,500–3,000 words]

V. Sources
[List of all cited sources]
```

### File Naming and Delivery

Name the PDF `{subject_name}_research_report.pdf` and save it to the user's working directory.

---

## Adapting to Different Subject Types

Core principles remain the same (vertical traces depth through time, horizontal traces breadth across peers), but emphasis differs:

**Researching a product**: Vertical axis focuses on version iterations, technical roadmap evolution, user growth curves, key product decisions; horizontal axis focuses on feature comparison, performance comparison, user experience, pricing.

**Researching a company**: Vertical axis focuses on founding team, funding history, strategic pivots, organizational changes, key personnel moves; horizontal axis focuses on business model differences, market share, revenue comparison, organizational structure differences.

**Researching a concept** (technical paradigm, business model, cultural phenomenon): Vertical axis focuses on the concept's origin (who proposed it, based on what theory/need), how it became popular, what debates and evolution it went through; horizontal axis focuses on distinctions from similar concepts, respective applicable scenarios, different camps' arguments.

**Researching a person**: Vertical axis focuses on personal experience, career trajectory, key decisions, growth curve, evolution of public statements; horizontal axis focuses on comparison with others in the same field (working style, achievements, influence, strategic choices).

---

## Length Overview

| Section | Word Count | Notes |
|---------|-----------|-------|
| Vertical Analysis | 6,000–15,000 | Report body — don't skim the surface |
| Horizontal Analysis | 3,000–10,000 | Adjust based on number of competitors |
| Cross-Axis Insights | 1,500–3,000 | Crown jewel — produce new judgments |
| **Total** | **10,000–30,000** | Don't fear length — depth and completeness are the value |

---

## Quality Checklist

Self-check before delivery:

- [ ] Vertical axis reads as a narrative story? Has causal logic and contextual flow? Not a dry chronological list?
- [ ] Founder/initiator background and motivation have sufficient depth?
- [ ] Every key milestone is expanded — no important details skipped for brevity?
- [ ] Decision logic is reconstructed? Not just "what happened" but also "why this choice"?
- [ ] Horizontal competitor scenario judgment is correct (A/B/C)? Competitor analysis has sufficient depth?
- [ ] User reputation section cites real user voices? Not just official marketing?
- [ ] Cross-axis insights produce new judgments, not an abbreviated version of previous sections?
- [ ] Three future scenarios all have logical support?
- [ ] Writing style has rhythm and readability? Not a cold consulting report?
- [ ] None of the absolute prohibitions are violated?
- [ ] All key facts cite information sources?
- [ ] Information that can't be found is honestly marked "unavailable" — nothing fabricated?
- [ ] PDF layout is clean, well-structured, and readable?
- [ ] Total word count is within the 10,000–30,000 range?
