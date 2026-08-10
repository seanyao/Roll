/* global React, useT, SectionLabel, Badge, Logo, Icon, ThemeToggle, LangToggle, InstallSnippet, Terminal, FeatureCard */
const { useState } = React;

// ─────────────────────────────────────────────────────────────────────────────
// Header (sticky, top of page)
// ─────────────────────────────────────────────────────────────────────────────
function Header({ theme, onThemeChange, lang, onLangChange }) {
  const t = useT();
  return (
    <header className="r-header">
      <div className="r-header-inner">
        <a className="r-brand" href="#top" aria-label="Roll home">
          <Logo />
          <span className="r-brand-name">roll</span>
          <span className="r-brand-ver">{t.HERO.version}</span>
        </a>
        <nav className="r-nav" aria-label="Primary">
          {t.UI.nav.map((n) => (
            <a key={n.id} href={`#${n.id}`}>{n.label}</a>
          ))}
          <a className="r-nav-ext" href="https://github.com/seanyao/roll" target="_blank" rel="noreferrer">
            {t.UI.githubLabel} <Icon name="ext" size={12} />
          </a>
        </nav>
        <div className="r-header-right">
          <LangToggle lang={lang} onChange={onLangChange} />
          <ThemeToggle theme={theme} onChange={onThemeChange} />
        </div>
      </div>
    </header>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Hero
// ─────────────────────────────────────────────────────────────────────────────
function Hero({ animate = true }) {
  const t = useT();
  const h = t.HERO;
  return (
    <section className="r-hero" id="top">
      <div className="r-container r-hero-grid">
        <div className="r-hero-left">
          <div className="r-hero-status">
            <span className="r-pulse" />
            <span>{t.UI.cycleStatus}</span>
          </div>
          <h1 className="r-display">
            <span className="r-display-1">{h.tagline}</span>
            <span className="r-display-2">{h.sub2}</span>
          </h1>
          <p className="r-lede">{h.sub}</p>
          <div className="r-hero-cta">
            <InstallSnippet command={h.install} />
            <div className="r-hero-cta-row">
              {h.ctas.map((c) => (
                <a key={c.label} className={`r-btn${c.primary ? " r-btn-primary" : ""}`} href={c.href} target={c.external ? "_blank" : undefined} rel={c.external ? "noreferrer" : undefined}>
                  <span>{c.label}</span>
                  <Icon name={c.external ? "ext" : "arrow"} size={13} />
                </a>
              ))}
            </div>
          </div>
          <ul className="r-hero-meta">
            {h.meta.map((m) => <li key={m}>{m}</li>)}
          </ul>
        </div>
        <div className="r-hero-right">
          <Terminal lines={t.TERMINAL} animate={animate} />
          <div className="r-hero-caption">
            <span className="r-mono r-mute">~/projects/roll</span>
            <span className="r-mute"> · {t.UI.heroCaption}</span>
          </div>
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Why Roll
// ─────────────────────────────────────────────────────────────────────────────
function Why() {
  const t = useT();
  const w = t.WHY;
  return (
    <section className="r-section" id="why">
      <div className="r-container">
        <SectionLabel n="01">{w.label}</SectionLabel>
        <h2 className="r-h2">{w.title}</h2>
        <p className="r-section-lede">{w.sub}</p>
        <div className="r-why-grid">
          {w.cards.map((c) => (
            <article key={c.title} className="r-card r-why-card">
              <h3 className="r-h3">{c.title}</h3>
              <p className="r-body">{c.body}</p>
            </article>
          ))}
        </div>
        <blockquote className="r-quote">
          <span className="r-quote-mark">“</span>
          <span className="r-quote-text">{w.quote}</span>
        </blockquote>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// How It Works — three layers
// ─────────────────────────────────────────────────────────────────────────────
function How() {
  const t = useT();
  const h = t.HOW;
  return (
    <section className="r-section" id="how">
      <div className="r-container">
        <SectionLabel n="02">{h.label}</SectionLabel>
        <h2 className="r-h2 r-h2-pre">{h.title}</h2>
        <p className="r-section-lede">{h.sub}</p>
        <div className="r-layers">
          {h.layers.map((l, i) => (
            <article key={l.name} className="r-card r-layer">
              <div className="r-layer-head">
                <span className="r-layer-glyph"><Icon name={l.glyph} size={18} /></span>
                <span className="r-layer-num">L{i + 1}</span>
              </div>
              <div className="r-layer-name">{l.name}</div>
              <div className="r-layer-sub">{l.sub}</div>
              <p className="r-body">{l.body}</p>
              <ul className="r-layer-owns">
                {l.owns.map((o) => <li key={o}><span className="r-dot" />{o}</li>)}
              </ul>
            </article>
          ))}
        </div>
        <aside className="r-analogy">
          <span className="r-analogy-label">{h.analogy.label}</span>
          <p>{h.analogy.body}</p>
        </aside>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Features — grouped grid with sticky group nav
// ─────────────────────────────────────────────────────────────────────────────
function Features() {
  const t = useT();
  const head = t.FEATURES_HEADING;
  const groups = t.FEATURE_GROUPS;
  const [active, setActive] = useState(groups[0].id);
  const onJump = (id) => {
    setActive(id);
    const el = document.getElementById(`fg-${id}`);
    if (el) {
      const offset = 92;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - offset, behavior: "smooth" });
    }
  };
  return (
    <section className="r-section" id="features">
      <div className="r-container">
        <SectionLabel n="03">{head.label}</SectionLabel>
        <h2 className="r-h2">{head.title}</h2>
        <p className="r-section-lede">
          {head.sub}{" "}
          <span style={{ opacity: 0.7 }}>· {t.UI.tagsLegend}:</span>{" "}
          <Badge kind="core" />{" "}<Badge kind="highlight" />{" "}<Badge kind="new" />
        </p>

        <nav className="r-fg-nav" aria-label={t.UI.featureGroupsLabel}>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`r-fg-tab${active === g.id ? " is-active" : ""}`}
              onClick={() => onJump(g.id)}
            >
              {g.title}
              <span className="r-fg-count">{g.features.length}</span>
            </button>
          ))}
        </nav>

        <div className="r-fg-list">
          {groups.map((g) => (
            <div key={g.id} id={`fg-${g.id}`} className="r-fg">
              <div className="r-fg-head">
                <h3 className="r-fg-title">{g.title}</h3>
                <span className="r-fg-rule" />
                <span className="r-fg-blurb">{g.blurb}</span>
              </div>
              <div className="r-fg-grid">
                {g.features.map((f) => (
                  <FeatureCard key={f.name} feature={f} domain={g.title} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Skills — specialized workflow diagrams
// ─────────────────────────────────────────────────────────────────────────────
function Skills() {
  const t = useT();
  const head = t.SKILLS_HEADING;
  const groups = t.SKILL_GROUPS;
  const [active, setActive] = useState(groups[0].id);
  const onJump = (id) => {
    setActive(id);
    const el = document.getElementById(`sg-${id}`);
    if (el) {
      const offset = 92;
      window.scrollTo({ top: el.getBoundingClientRect().top + window.pageYOffset - offset, behavior: "smooth" });
    }
  };
  return (
    <section className="r-section r-section-tinted" id="skills">
      <div className="r-container">
        <SectionLabel n="04">{head.label}</SectionLabel>
        <div className="r-section-title-row">
          <div>
            <h2 className="r-h2">{head.title}</h2>
            <p className="r-section-lede">{head.sub}</p>
          </div>
          <a className="r-btn r-btn-primary r-section-action" href={head.overviewHref} target="_blank" rel="noreferrer">
            <span>{head.overviewLabel}</span>
            <Icon name="ext" size={13} />
          </a>
        </div>

        <nav className="r-fg-nav" aria-label={t.UI.skillGroupsLabel}>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className={`r-fg-tab${active === g.id ? " is-active" : ""}`}
              onClick={() => onJump(g.id)}
            >
              {g.title}
              <span className="r-fg-count">{g.features.length}</span>
            </button>
          ))}
        </nav>

        <div className="r-fg-list">
          {groups.map((g) => (
            <div key={g.id} id={`sg-${g.id}`} className="r-fg">
              <div className="r-fg-head">
                <h3 className="r-fg-title">{g.title}</h3>
                <span className="r-fg-rule" />
                <span className="r-fg-blurb">{g.blurb}</span>
              </div>
              <div className="r-fg-grid">
                {g.features.map((f) => (
                  <FeatureCard key={f.name} feature={f} domain={g.title} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Journey — six-step timeline
// ─────────────────────────────────────────────────────────────────────────────
function Journey() {
  const t = useT();
  const j = t.JOURNEY;
  return (
    <section className="r-section r-section-tinted" id="journey">
      <div className="r-container">
        <SectionLabel n="05">{j.label}</SectionLabel>
        <h2 className="r-h2">{j.title}</h2>
        <p className="r-section-lede">{j.sub}</p>
        <ol className="r-journey">
          {j.steps.map((s, i) => (
            <li key={s.time} className="r-journey-step">
              <div className="r-journey-time">
                <span className="r-journey-time-val">{s.time}</span>
                <span className="r-journey-tag">{s.tag}</span>
              </div>
              <div className="r-journey-node">
                <span className="r-journey-bullet" />
                {i < j.steps.length - 1 && <span className="r-journey-line" />}
              </div>
              <div className="r-journey-body">
                <h4 className="r-journey-title">{s.title}</h4>
                <p>{s.body}</p>
              </div>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Numbers
// ─────────────────────────────────────────────────────────────────────────────
function Numbers() {
  const t = useT();
  const n = t.NUMBERS;
  return (
    <section className="r-section r-section-numbers">
      <div className="r-container">
        <SectionLabel n="06">{n.label}</SectionLabel>
        <div className="r-numbers">
          {n.stats.map((s) => (
            <div key={s.label} className="r-stat">
              <div className="r-stat-value">{s.value}</div>
              <div className="r-stat-label">{s.label}</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Guides — doc tiles
// ─────────────────────────────────────────────────────────────────────────────
function Guides() {
  const t = useT();
  const g = t.GUIDES;
  const glyphs = ["book", "cycle", "moon", "swap", "list", "gear"];
  return (
    <section className="r-section" id="guides">
      <div className="r-container">
        <SectionLabel n="07">{g.label}</SectionLabel>
        <h2 className="r-h2">{g.title}</h2>
        <p className="r-section-lede">{g.sub}</p>
        <div className="r-guides">
          {g.tiles.map((tile, i) => (
            <a key={tile.name} className="r-card r-guide" href={`https://github.com/seanyao/roll/blob/main/${tile.path}`} target="_blank" rel="noreferrer">
              <span className="r-guide-glyph"><Icon name={glyphs[i]} size={16} /></span>
              <span className="r-guide-name">{tile.name}</span>
              <span className="r-guide-desc">{tile.desc}</span>
              <span className="r-guide-arrow"><Icon name="arrow" size={14} /></span>
            </a>
          ))}
        </div>
      </div>
    </section>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Footer
// ─────────────────────────────────────────────────────────────────────────────
function Footer() {
  const t = useT();
  return (
    <footer className="r-footer">
      <div className="r-container r-footer-inner">
        <div className="r-footer-left">
          <Logo size={18} />
          <span className="r-footer-tag">{t.UI.footerTag}</span>
        </div>
        <div className="r-footer-mid r-mono">
          <span>MIT</span>
          <span className="r-sep">·</span>
          <span>{t.HERO.version}</span>
          <span className="r-sep">·</span>
          <span>seanyao</span>
        </div>
        <div className="r-footer-right">
          <a href="https://github.com/seanyao/roll" target="_blank" rel="noreferrer" className="r-icon-link" aria-label="GitHub">
            <Icon name="github" size={16} />
          </a>
          <a href="https://www.npmjs.com/package/@seanyao/roll" target="_blank" rel="noreferrer" className="r-icon-link" aria-label="npm">
            <span className="r-mono r-mute" style={{ fontSize: 13 }}>npm</span>
          </a>
        </div>
      </div>
    </footer>
  );
}

Object.assign(window, { Header, Hero, Why, How, Features, Skills, Journey, Numbers, Guides, Footer });
