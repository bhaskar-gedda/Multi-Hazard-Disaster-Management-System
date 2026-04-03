(function () {
  const SUPPORTED = ["en", "hi", "te", "mr", "ta", "pa", "as"];
  const DEFAULT_LANG = "en";

  function getLang() {
    const saved = localStorage.getItem("lang");
    if (saved && SUPPORTED.includes(saved)) return saved;
    return DEFAULT_LANG;
  }

  function setLang(lang) {
    const safe = SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;
    localStorage.setItem("lang", safe);
    applyLang(safe);
  }

  function t(key, lang) {
    const l = lang || getLang();
    const dict = window.TRANSLATIONS?.[l];
    if (!dict) return key;

    const parts = key.split(".");
    let cur = dict;
    for (const p of parts) {
      if (cur && Object.prototype.hasOwnProperty.call(cur, p)) cur = cur[p];
      else return key;
    }
    return typeof cur === "string" ? cur : key;
  }

  function applyLang(lang) {
    const l = SUPPORTED.includes(lang) ? lang : DEFAULT_LANG;

    document.documentElement.lang = l;
    document.body.classList.remove("lang-en", "lang-hi", "lang-te", "lang-mr", "lang-ta", "lang-pa", "lang-as");
    document.body.classList.add(`lang-${l}`);

    // text nodes
    document.querySelectorAll("[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      el.textContent = t(key, l);
    });

    // placeholders
    document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
      const key = el.getAttribute("data-i18n-placeholder");
      el.setAttribute("placeholder", t(key, l));
    });

    // title
    document.querySelectorAll("title[data-i18n]").forEach((el) => {
      const key = el.getAttribute("data-i18n");
      document.title = t(key, l);
    });

    // language buttons state
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      const btnLang = btn.getAttribute("data-lang-btn");
      if (btnLang === l) btn.classList.add("active");
      else btn.classList.remove("active");
    });

    // Let pages update any dynamic text that isn't handled by data-i18n.
    document.dispatchEvent(new CustomEvent("langchange", { detail: { lang: l } }));
  }

  function bindLangButtons() {
    document.querySelectorAll("[data-lang-btn]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const lang = btn.getAttribute("data-lang-btn");
        setLang(lang);
      });
    });
  }

  window.I18N = { getLang, setLang, t, applyLang };

  // Global function for dropdown language change
  window.changeLanguage = function(lang) {
    setLang(lang);
  };

  document.addEventListener("DOMContentLoaded", () => {
    bindLangButtons();
    applyLang(getLang());
    
    // Sync all dropdown values with saved language
    const savedLang = getLang();
    const dropdowns = [
      "langSelect", "langSelectMobile", 
      "langSelectHome", "langSelectHomeMobile"
    ];
    dropdowns.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = savedLang;
    });
  });
})();
