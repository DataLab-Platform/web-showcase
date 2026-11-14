/**
 * Translations of the showcase captions (English is the key, French in
 * ``./locales/fr.json``) and the DataLab Web labels the scenarios look for.
 */

import fr from "./locales/fr.json";
import type { Locale } from "./options";

export type TranslationVars = Record<string, string | number>;

const CATALOGS: Record<Locale, Record<string, string>> = { en: {}, fr };

const PLACEHOLDER = /\{(\w+)\}/g;

let active: Locale = "en";

export function setLocale(locale: Locale): void {
  active = locale;
  document.documentElement.setAttribute("lang", locale);
}

export function getLocale(): Locale {
  return active;
}

function interpolate(text: string, vars?: TranslationVars): string {
  if (!vars) return text;
  return text.replace(PLACEHOLDER, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

/** Translate ``key`` (an English caption) to the active language. */
export function t(key: string, vars?: TranslationVars): string {
  return interpolate(CATALOGS[active][key] ?? key, vars);
}

/** Format ``value`` for a caption, in the active language. */
export function formatNumber(value: number, digits = 1): string {
  return new Intl.NumberFormat(active, {
    maximumFractionDigits: digits,
  }).format(value);
}

/**
 * French translations of the DataLab Web labels that the scenarios match
 * (buttons, tabs, statuses). The scenarios accept the English label and
 * its French translation, so they work whatever the language of DataLab
 * Web (kept in sync with DataLab Web's ``src/locales/fr.json``).
 */
const APP_FR: Record<string, string> = {
  OK: "OK",
  Cancel: "Annuler",
  Close: "Fermer",
  Continue: "Continuer",
  Create: "Créer",
  "Cross profiles": "Profils croisés",
  "Preview up to date": "Aperçu à jour",
  "○ Kernel idle": "○ Noyau inactif",
  "Run active cell (Ctrl+Enter)": "Exécuter la cellule active (Ctrl+Entrée)",
  "Insert code cell below": "Insérer une cellule de code en dessous",
  "Convert active cell between code and markdown":
    "Convertir la cellule active entre code et markdown",
  Intact: "Intacte",
  Exact: "Exact",
  consistent: "cohérent",
  "Cited reports: {count}": "Rapports cités : {count}",
  Stop: "Arrêter",
  Send: "Envoyer",
  "New conversation": "Nouvelle conversation",
  "New workspace": "Nouvel espace de travail",
  Approve: "Approuver",
  "Minimise AI Assistant": "Réduire l'assistant IA",
  "Hide AI Assistant": "Masquer l'assistant IA",
  Results: "Résultats",
  "Open example": "Ouvrir l'exemple",
  "Created {count} objects": "{count} objets créés",
  Error: "Erreur",
  Signals: "Signaux",
  Images: "Images",
  Plot: "Graphique",
  Macros: "Macros",
  Notebooks: "Notebooks",
  Properties: "Propriétés",
  Provenance: "Provenance",
  Inspect: "Inspecter",
  "Local replay": "Rejeu local",
};

/** A DataLab Web label in English and in French (``vars`` interpolated). */
export function appLabels(key: string, vars?: TranslationVars): string[] {
  const labels = [interpolate(key, vars)];
  const translated = APP_FR[key];
  if (translated !== undefined) {
    const value = interpolate(translated, vars);
    if (!labels.includes(value)) labels.push(value);
  }
  return labels;
}

/** Whether ``text`` (trimmed) is the DataLab Web label ``key``. */
export function isAppLabel(
  text: string | null | undefined,
  key: string,
  vars?: TranslationVars,
): boolean {
  return appLabels(key, vars).includes((text ?? "").trim());
}
