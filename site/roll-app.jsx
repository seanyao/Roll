/* global React, ReactDOM, RollI18n, Header, Hero, Why, How, QuickStart, Commands, Guides, Footer,
          useTweaks, TweaksPanel, TweakSection, TweakRadio, TweakSelect */
const { useEffect } = React;

// US-I18N-005: detect browser language on first visit.
// Priority: localStorage > navigator.language > 'EN'.
function detectLang() {
  try {
    const stored = localStorage.getItem('roll-lang');
    if (stored === 'ZH' || stored === 'EN') return stored;
  } catch (e) { /* localStorage unavailable */ }
  if (typeof navigator !== 'undefined' && navigator.language) {
    return navigator.language.startsWith('zh') ? 'ZH' : 'EN';
  }
  return 'EN';
}

// US-I18N-005: persist lang choice to localStorage.
function persistLang(lang) {
  try { localStorage.setItem('roll-lang', lang); } catch (e) { /* noop */ }
}

// Tweak defaults — host re-writes the JSON in-place between the markers.
const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "theme": "dark",
  "lang": "EN",
  "accent": "Electric Blue",
  "density": "regular",
  "terminalAnim": "animated"
}/*EDITMODE-END*/;

// Override lang default with detected language (only on first load).
if (TWEAK_DEFAULTS.lang === 'EN') {
  TWEAK_DEFAULTS.lang = detectLang();
}

const ACCENT_HUES = {
  "Electric Blue": 226,
  "Lime":           80,
  "Coral":           8,
  "Violet":        262,
};

function App() {
  const [tweaks, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const lang = (tweaks.lang === "ZH") ? "ZH" : "EN";
  const t = window.RollData[lang];

  // Mirror tweak state onto the document root for CSS variables.
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", tweaks.theme);
    document.documentElement.setAttribute("data-density", tweaks.density);
    document.documentElement.setAttribute("data-lang", lang);
    document.documentElement.style.setProperty("--accent-h", ACCENT_HUES[tweaks.accent] ?? 226);
    document.documentElement.lang = lang === "ZH" ? "zh-CN" : "en";
    persistLang(lang);
  }, [tweaks.theme, tweaks.density, tweaks.accent, lang]);

  // Re-mount the terminal when animation mode, language or accent toggles so it replays cleanly.
  const heroKey = `${tweaks.terminalAnim}-${lang}-${tweaks.accent}`;

  return (
    <RollI18n.Provider value={t}>
      <div className="r-app">
        <Header
          theme={tweaks.theme}
          onThemeChange={(v) => setTweak("theme", v)}
          lang={lang}
          onLangChange={(v) => setTweak("lang", v)}
        />
        <main>
          <Hero key={heroKey} animate={tweaks.terminalAnim === "animated"} />
          <Why />
          <How />
          <QuickStart />
          <Commands />
          <Guides />
        </main>
        <Footer />

        <TweaksPanel title="Tweaks">
          <TweakSection label="Language & theme">
            <TweakRadio
              label="Language"
              value={lang}
              options={["EN", "ZH"]}
              onChange={(v) => setTweak("lang", v)}
            />
            <TweakRadio
              label="Mode"
              value={tweaks.theme}
              options={["light", "dark"]}
              onChange={(v) => setTweak("theme", v)}
            />
            <TweakSelect
              label="Accent"
              value={tweaks.accent}
              options={Object.keys(ACCENT_HUES)}
              onChange={(v) => setTweak("accent", v)}
            />
          </TweakSection>
          <TweakSection label="Layout">
            <TweakRadio
              label="Density"
              value={tweaks.density}
              options={["regular", "compact"]}
              onChange={(v) => setTweak("density", v)}
            />
          </TweakSection>
          <TweakSection label="Hero">
            <TweakRadio
              label="Terminal"
              value={tweaks.terminalAnim}
              options={["animated", "static"]}
              onChange={(v) => setTweak("terminalAnim", v)}
            />
          </TweakSection>
        </TweaksPanel>
      </div>
    </RollI18n.Provider>
  );
}

window.RollApp = App;
