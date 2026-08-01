/**
 * Curated category map for the Integrations directory.
 *
 * Composio exposes 500+ toolkits — far too many to browse. So we curate the
 * ones worth surfacing into packages, and everything else stays reachable via
 * live search. Slugs listed here that Composio doesn't recognise are simply
 * dropped at render time, so this list can be aspirational without breaking.
 */

export type Category = {
  id: string;
  label: string;
  blurb: string;
  /** Emoji glyph — keeps the bundle free of image assets. */
  glyph: string;
  slugs: string[];
};

export const CATEGORIES: Category[] = [
  {
    id: "google",
    label: "Google Suite",
    blurb: "Mail, calendar, docs and drive — the core of a working day.",
    glyph: "🅖",
    slugs: [
      "gmail",
      "googlecalendar",
      "googledrive",
      "googledocs",
      "googlesheets",
      "googleslides",
      "googlemeet",
      "googletasks",
      "googlephotos",
      "google_maps",
      "googlebigquery",
      "google_analytics",
      "youtube",
    ],
  },
  {
    id: "microsoft",
    label: "Microsoft Suite",
    blurb: "Outlook, Teams, OneDrive and the Office surface.",
    glyph: "🪟",
    slugs: [
      "outlook",
      "microsoft_teams",
      "one_drive",
      "sharepoint",
      "microsoft_excel",
      "onenote",
      "microsoft_todo",
      "azure",
      "dynamics365",
      "microsoft_clarity",
    ],
  },
  {
    id: "sales",
    label: "Sales Package",
    blurb: "CRM, prospecting, enrichment and call intelligence.",
    glyph: "📈",
    slugs: [
      "salesforce",
      "hubspot",
      "pipedrive",
      "apollo",
      "close",
      "attio",
      "outreach",
      "salesloft",
      "clay",
      "zoominfo",
      "gong",
      "fireflies",
      "granola_mcp",
      "lemlist",
      "instantly",
    ],
  },
  {
    id: "finance",
    label: "Finance Package",
    blurb: "Billing, ledgers, spend and payment rails.",
    glyph: "💳",
    slugs: [
      "stripe",
      "quickbooks",
      "xero",
      "chargebee",
      "brex",
      "ramp",
      "plaid",
      "netsuite",
      "bill",
      "recurly",
      "paypal",
      "wise",
    ],
  },
  {
    id: "marketing",
    label: "Marketing Package",
    blurb: "Campaigns, SEO, design and the content pipeline.",
    glyph: "📣",
    slugs: [
      "mailchimp",
      "klaviyo",
      "ahrefs",
      "semrush",
      "similarweb",
      "canva",
      "figma",
      "webflow",
      "wordpress",
      "buffer",
      "hootsuite",
      "sendgrid",
      "customerio",
      "braze",
      "supermetrics",
    ],
  },
  {
    id: "data",
    label: "Data Package",
    blurb: "Warehouses, databases and product analytics.",
    glyph: "🧮",
    slugs: [
      "snowflake",
      "databricks",
      "postgres",
      "mysql",
      "mongodb",
      "airtable",
      "supabase",
      "mixpanel",
      "amplitude",
      "posthog",
      "looker",
      "tableau",
      "metabase",
      "clickhouse",
    ],
  },
  {
    id: "developer",
    label: "Developer Package",
    blurb: "Source control, issues, deploys and observability.",
    glyph: "⌘",
    slugs: [
      "github",
      "gitlab",
      "bitbucket",
      "jira",
      "linear",
      "sentry",
      "pagerduty",
      "vercel",
      "netlify",
      "circleci",
      "docker",
      "cloudflare",
      "datadog",
      "heroku",
    ],
  },
  {
    id: "comms",
    label: "Communication",
    blurb: "Chat, meetings and messaging.",
    glyph: "💬",
    slugs: [
      "slack",
      "slackbot",
      "discord",
      "telegram",
      "zoom",
      "twilio",
      "whatsapp",
      "intercom",
      "front",
    ],
  },
  {
    id: "productivity",
    label: "Productivity & Docs",
    blurb: "Notes, tasks and project tracking.",
    glyph: "🗂",
    slugs: [
      "notion",
      "asana",
      "clickup",
      "monday",
      "trello",
      "todoist",
      "coda",
      "confluence",
      "evernote",
    ],
  },
  {
    id: "storage",
    label: "Storage & Files",
    blurb: "Cloud drives and document stores.",
    glyph: "📦",
    slugs: ["dropbox", "box", "egnyte", "s3"],
  },
  {
    id: "support",
    label: "Support & Success",
    blurb: "Tickets, helpdesks and the customer inbox.",
    glyph: "🛟",
    slugs: ["zendesk", "freshdesk", "helpscout", "jira_service_management"],
  },
  {
    id: "ai",
    label: "AI & Research",
    blurb: "Search, scraping and retrieval for live answers.",
    glyph: "🔎",
    slugs: ["composio_search", "exa", "perplexityai", "firecrawl", "tavily", "serpapi"],
  },
  {
    id: "hr",
    label: "People & Hiring",
    blurb: "Recruiting pipelines and HRIS.",
    glyph: "👥",
    slugs: ["greenhouse", "lever", "bamboohr", "workday", "rippling", "gusto"],
  },
  {
    id: "social",
    label: "Social & Content",
    blurb: "Publishing and audience surfaces.",
    glyph: "🌐",
    slugs: ["linkedin", "twitter", "reddit", "instagram", "facebook", "tiktok", "medium"],
  },
];

/** Slug to category id, for bucketing the live toolkit list. */
export function categoryIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const cat of CATEGORIES) {
    for (const slug of cat.slugs) {
      if (!index.has(slug)) index.set(slug, cat.id);
    }
  }
  return index;
}
