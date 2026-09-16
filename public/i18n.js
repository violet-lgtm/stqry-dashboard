/**
 * Translations and locale-aware formatting.
 *
 * Dutch is the default; English is available from the header. The choice is
 * remembered per browser.
 *
 * Server messages are never translated on the server — the API returns a
 * stable `code` (and any values to interpolate), and the codes are translated
 * here alongside everything else. That keeps the API language-neutral and
 * means an error reads in the same language as the page around it.
 */

const STORAGE_KEY = 'dashboard-language';
export const DEFAULT_LANGUAGE = 'nl';
export const LANGUAGES = ['nl', 'en'];

/** Intl locale per language — drives number, date and time formatting. */
const LOCALES = { nl: 'nl-NL', en: 'en-GB' };

const STRINGS = {
  nl: {
    'app.title': 'Statistieken',
    'app.documentTitle': 'Statistieken-dashboard',
    'app.loading': 'Laden…',
    'app.subtitle': '{count} bezoekers · {range}',

    'language.switchTo': 'English',
    'language.label': 'Taal',
    'theme.toDark': 'Donkere modus',
    'theme.toLight': 'Lichte modus',

    'notice.sample': 'Voorbeeldgegevens. ',
    'notice.error': 'Kan gegevens niet laden. ',

    'headline.heading': 'Totaal aantal bezoekers',
    'headline.weekly': 'Deze week',
    'headline.monthly': 'Deze maand',
    'headline.yearly': 'Dit jaar',
    'headline.versus': 't.o.v. {period}',
    'headline.noComparison': '{range} · geen vergelijking beschikbaar',
    'headline.unavailable': 'Kon niet worden geladen.',

    'filter.label': 'Periode',
    'range.weekly': 'Afgelopen 7 dagen',
    'range.monthly': 'Afgelopen 30 dagen',
    'range.yearly': 'Afgelopen 12 maanden',
    'comparison.weekly': 'vorige 7 dagen',
    'comparison.monthly': 'vorige 30 dagen',
    'comparison.yearly': 'zelfde periode vorig jaar',

    'trend.heading': 'Bezoekersverloop',
    'trend.subtitle': 'Bezoekers per {granularity}, vergeleken met {comparison}',
    'trend.footnote':
      'De laatste {granularity} loopt nog en ligt daardoor lager dan een volledige {granularity}.',
    'trend.ariaLabel':
      'Bezoekers per {granularity} over {range}, vergeleken met {comparison}.',
    'trend.ariaKeys': 'Bezoekersverloop. Gebruik de pijltjestoetsen links en rechts om elk punt te lezen.',

    'pages.heading': "Meest bezochte pagina's",
    'pages.subtitle': 'Op paginaweergaven · {window}',
    'pages.ariaLabel': "De {count} meest bezochte pagina's op paginaweergaven.",
    'pages.rowLabel': '{path}: {views} paginaweergaven, {visitors} bezoekers.',
    'pages.empty': 'Geen paginagegevens voor deze periode.',

    'metric.visitors': 'bezoekers',
    'metric.pageViews': 'paginaweergaven',
    'metric.engagement': 'gem. betrokkenheid',

    'table.toggle': 'Tabelweergave',
    'table.day': 'Dag',
    'table.month': 'Maand',
    'table.visitors': 'Bezoekers',
    'table.pageViews': 'Paginaweergaven',
    'table.page': 'Pagina',
    'table.title': 'Titel',
    'table.engagement': 'Gem. betrokkenheid',
    'table.inProgress': '{label} (loopt nog)',
    'table.none': 'Geen gegevens om te tonen.',

    'panel.unavailable': 'Dit paneel kon niet worden geladen.',
    'tooltip.inProgress': 'Deze periode loopt nog.',

    'granularity.day': 'dag',
    'granularity.month': 'maand',

    'footer.sample': 'Voorbeeldgegevens',
    'footer.live': 'Google Analytics 4',
    'footer.line': '{source} · tijden in {timeZone} · bijgewerkt {time}{cadence}',
    'footer.cadence': ' · ververst elke {minutes} min zolang de pagina open is',

    'error.PERMISSION_DENIED':
      'Google Analytics geeft geen toegang tot deze property. Voeg het e-mailadres van het serviceaccount toe als Lezer bij Beheer → Toegangsbeheer voor property.',
    'error.UNAUTHENTICATED':
      'Google Analytics accepteert de inloggegevens niet. Controleer GA_CLIENT_EMAIL en GA_PRIVATE_KEY, en of de Google Analytics Data API is ingeschakeld voor het project.',
    'error.NOT_FOUND':
      'Geen GA4-property met ID {propertyId}. Gebruik het numerieke property-ID uit Beheer → Property-details, niet het "G-" meet-ID.',
    'error.INVALID_ARGUMENT': 'Google Analytics heeft de opdracht geweigerd: {detail}',
    'error.RESOURCE_EXHAUSTED':
      'Deze GA4-property heeft de limiet van de Data API bereikt. Probeer het zo meteen opnieuw.',
    'error.BAD_PRIVATE_KEY':
      'De privésleutel van het serviceaccount kon niet worden gelezen. Staat GA_PRIVATE_KEY op één regel, dan moeten de regeleindes als \\n geschreven zijn en moet de waarde de BEGIN/END PRIVATE KEY-regels bevatten.',
    'error.UNKNOWN': 'Het verzoek aan de Google Analytics API is mislukt.',
    'error.NETWORK': 'Het dashboard kan de server niet bereiken.',

    'mock.FORCED': 'GA_USE_MOCK staat aan, dus het dashboard toont gegenereerde voorbeeldgegevens.',
    'mock.NO_PROPERTY':
      'GA_PROPERTY_ID is niet ingesteld, dus het dashboard toont gegenereerde voorbeeldgegevens.',
    'mock.NO_CREDENTIALS':
      'Er zijn geen gegevens van een Google-serviceaccount gevonden, dus het dashboard toont gegenereerde voorbeeldgegevens.',
  },

  en: {
    'app.title': 'Analytics',
    'app.documentTitle': 'Analytics dashboard',
    'app.loading': 'Loading…',
    'app.subtitle': '{count} visitors · {range}',

    'language.switchTo': 'Nederlands',
    'language.label': 'Language',
    'theme.toDark': 'Dark mode',
    'theme.toLight': 'Light mode',

    'notice.sample': 'Sample data. ',
    'notice.error': 'Could not load data. ',

    'headline.heading': 'Total visitors',
    'headline.weekly': 'This week',
    'headline.monthly': 'This month',
    'headline.yearly': 'This year',
    'headline.versus': 'vs {period}',
    'headline.noComparison': '{range} · no comparison available',
    'headline.unavailable': 'Could not be loaded.',

    'filter.label': 'Date range',
    'range.weekly': 'Last 7 days',
    'range.monthly': 'Last 30 days',
    'range.yearly': 'Last 12 months',
    'comparison.weekly': 'previous 7 days',
    'comparison.monthly': 'previous 30 days',
    'comparison.yearly': 'same period last year',

    'trend.heading': 'Visitors over time',
    'trend.subtitle': 'Visitors per {granularity}, against {comparison}',
    'trend.footnote':
      'The final {granularity} is still in progress, so it reads lower than a complete {granularity}.',
    'trend.ariaLabel': 'Visitors per {granularity} for {range}, compared with {comparison}.',
    'trend.ariaKeys': 'Visitor trend. Use the left and right arrow keys to read each point.',

    'pages.heading': 'Most visited pages',
    'pages.subtitle': 'By page views · {window}',
    'pages.ariaLabel': 'The {count} most visited pages by page views.',
    'pages.rowLabel': '{path}: {views} page views, {visitors} visitors.',
    'pages.empty': 'No page data for this period.',

    'metric.visitors': 'visitors',
    'metric.pageViews': 'page views',
    'metric.engagement': 'avg. engagement',

    'table.toggle': 'Table view',
    'table.day': 'Day',
    'table.month': 'Month',
    'table.visitors': 'Visitors',
    'table.pageViews': 'Page views',
    'table.page': 'Page',
    'table.title': 'Title',
    'table.engagement': 'Avg. engagement',
    'table.inProgress': '{label} (in progress)',
    'table.none': 'No data to show.',

    'panel.unavailable': 'This panel could not be loaded.',
    'tooltip.inProgress': 'This period is still in progress.',

    'granularity.day': 'day',
    'granularity.month': 'month',

    'footer.sample': 'Sample data',
    'footer.live': 'Google Analytics 4',
    'footer.line': '{source} · times in {timeZone} · updated {time}{cadence}',
    'footer.cadence': ' · refreshes every {minutes} min while open',

    'error.PERMISSION_DENIED':
      'Google Analytics denied access to this property. Add the service-account email as a Viewer on the GA4 property under Admin → Property access management.',
    'error.UNAUTHENTICATED':
      'Google Analytics rejected the credentials. Check GA_CLIENT_EMAIL and GA_PRIVATE_KEY, and that the Google Analytics Data API is enabled for the project.',
    'error.NOT_FOUND':
      'No GA4 property with ID {propertyId}. Use the numeric property ID from Admin → Property details, not the "G-" measurement ID.',
    'error.INVALID_ARGUMENT': 'Google Analytics rejected the query: {detail}',
    'error.RESOURCE_EXHAUSTED': 'This GA4 property has hit its Data API quota. Try again shortly.',
    'error.BAD_PRIVATE_KEY':
      'The service-account private key could not be read. If GA_PRIVATE_KEY is on a single line, its newlines must be written as \\n, and the value must include the BEGIN/END PRIVATE KEY lines.',
    'error.UNKNOWN': 'The Google Analytics API request failed.',
    'error.NETWORK': 'The dashboard cannot reach its server.',

    'mock.FORCED': 'GA_USE_MOCK is set, so the dashboard is showing generated sample data.',
    'mock.NO_PROPERTY': 'GA_PROPERTY_ID is not set, so the dashboard is showing generated sample data.',
    'mock.NO_CREDENTIALS':
      'No Google service-account credentials were found, so the dashboard is showing generated sample data.',
  },
};

let current = DEFAULT_LANGUAGE;

export function getLanguage() {
  return current;
}

export function setLanguage(language) {
  current = LANGUAGES.includes(language) ? language : DEFAULT_LANGUAGE;
  try {
    localStorage.setItem(STORAGE_KEY, current);
  } catch {
    // Private browsing or blocked storage: the choice just won't be remembered.
  }
  document.documentElement.lang = current;
  return current;
}

/** The remembered choice, else Dutch. */
export function loadLanguage() {
  let stored = null;
  try {
    stored = localStorage.getItem(STORAGE_KEY);
  } catch {
    stored = null;
  }
  current = LANGUAGES.includes(stored) ? stored : DEFAULT_LANGUAGE;
  document.documentElement.lang = current;
  return current;
}

export const locale = () => LOCALES[current];

/**
 * Look up a key and fill in `{placeholders}`.
 * An unknown key returns itself, which makes a missing translation obvious on
 * screen rather than rendering as a blank.
 */
export function t(key, params = {}) {
  const template = STRINGS[current][key] ?? STRINGS[DEFAULT_LANGUAGE][key] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

/**
 * Translate a server-reported failure. The API sends a stable code plus any
 * values to interpolate; `fallback` is its English message, used only for a
 * code this build doesn't know.
 */
export function translateCode(prefix, code, params = {}, fallback = '') {
  const key = `${prefix}.${code}`;
  const known = STRINGS[current][key] ?? STRINGS[DEFAULT_LANGUAGE][key];
  return known ? t(key, params) : fallback || t(`${prefix}.UNKNOWN`);
}

/** Exposed for the tests, which check the two dictionaries stay in step. */
export const __strings = STRINGS;
