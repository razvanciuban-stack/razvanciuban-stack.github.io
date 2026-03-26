import * as cheerio from 'cheerio';
import { writeFileSync, existsSync, mkdirSync } from 'fs';

const BASE_URL = 'https://www.iabilet.ro';
const CITY_PATH = '/bilete-in-cluj-napoca/';
const MAX_PAGES = 20;
const REQUEST_DELAY = 500;
const USER_AGENT = 'ClujTonight/1.0 (event aggregator)';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchPage(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT }
  });
  if (res.status === 429) {
    console.warn(`Rate limited on ${url}, waiting 5s...`);
    await sleep(5000);
    const retry = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT }
    });
    if (!retry.ok) return null;
    return retry.text();
  }
  if (!res.ok) return null;
  return res.text();
}

async function getEventUrls() {
  const allUrls = new Set();
  let page = 1;

  while (page <= MAX_PAGES) {
    const url = `${BASE_URL}${CITY_PATH}?page=${page}`;
    console.log(`Fetching listing page ${page}...`);

    const html = await fetchPage(url);
    if (!html) break;

    const $ = cheerio.load(html);
    const links = [];

    $('a[href*="/bilete-"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href && href.startsWith('/bilete-') && !href.includes('bilete-in-') && !href.includes('bilete-la-')) {
        const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        links.push(fullUrl);
      }
    });

    if (links.length === 0) {
      console.log(`No event links on page ${page}, stopping.`);
      break;
    }

    const newUrls = links.filter(u => !allUrls.has(u));
    if (newUrls.length === 0) {
      console.log(`All duplicates on page ${page}, stopping.`);
      break;
    }

    newUrls.forEach(u => allUrls.add(u));
    console.log(`  Found ${newUrls.length} new event URLs (total: ${allUrls.size})`);

    page++;
    await sleep(REQUEST_DELAY);
  }

  return [...allUrls];
}

async function extractTimeFromPage($, eventUrl) {
  // Strategy 1: Try div.date text — look for "ora HH:MM" pattern
  const dateText = $('div.date').first().text();
  const oraMatch = dateText.match(/ora\s+(\d{1,2}:\d{2})/);
  if (oraMatch) {
    return oraMatch[1]; // e.g. "20:00"
  }

  // Strategy 2: If hallId links exist, fetch the first one and parse data-hall-config
  const hallIds = [];
  $('a[href*="hallId"]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      const url = new URL(href, BASE_URL);
      const hallId = url.searchParams.get('hallId');
      if (hallId && !hallIds.includes(hallId)) hallIds.push(hallId);
    } catch (e) {}
  });

  if (hallIds.length > 0) {
    const hallUrl = `${eventUrl}?hallId=${hallIds[0]}`;
    const hallHtml = await fetchPage(hallUrl);
    if (hallHtml) {
      const h$ = cheerio.load(hallHtml);
      const raw = h$('.hall-container').attr('data-hall-config');
      if (raw) {
        try {
          const config = JSON.parse(raw);
          const today = new Date().toISOString().split('T')[0];
          const upcoming = (config.timeslots || [])
            .filter(t => t.start_datetime && t.start_datetime >= today)
            .sort((a, b) => a.start_datetime.localeCompare(b.start_datetime));
          if (upcoming.length > 0) {
            // start_datetime is "2026-03-30 13:45:00" — extract time portion
            const timePart = upcoming[0].start_datetime.split(' ')[1];
            return timePart ? timePart.slice(0, 5) : null; // "13:45"
          }
        } catch (e) {
          // Malformed config, skip
        }
      }
    }
  }

  return null; // No time found
}

async function getEventDetails(eventUrl) {
  const html = await fetchPage(eventUrl);
  if (!html) return null;

  const $ = cheerio.load(html);
  let event = null;

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw = $(el).html().replace(/\/\*<!\[CDATA\[\*\//, '').replace(/\/\*\]\]>\*\//, '').trim();
      const data = JSON.parse(raw);
      if (data['@type'] === 'Event' || data['@type']?.includes?.('Event')) {
        const startDate = data.startDate;

        event = {
          name: data.name || null,
          date: startDate || null,
          venue: data.location?.name || null,
          price: data.offers?.price?.toString() || data.offers?.[0]?.price?.toString() || null,
          currency: data.offers?.priceCurrency || data.offers?.[0]?.priceCurrency || 'RON',
          url: eventUrl
        };
      }
    } catch (e) {
      // Malformed JSON-LD, skip
    }
  });

  if (event && event.date) {
    // Attempt to extract start time and combine into ISO datetime
    const time = await extractTimeFromPage($, eventUrl);
    if (time) {
      // date is "2026-03-27", time is "20:00" → "2026-03-27T20:00:00"
      event.date = `${event.date}T${time}:00`;
    }
  }

  return event;
}

async function scrape() {
  console.log('Starting scrape for Cluj-Napoca events...\n');

  const urls = await getEventUrls();
  console.log(`\nFound ${urls.length} event URLs. Fetching details...\n`);

  const events = [];

  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    console.log(`[${i + 1}/${urls.length}] ${url}`);

    try {
      const event = await getEventDetails(url);
      if (event && event.date) {
        events.push(event);
        console.log(`  ✓ ${event.name}`);
      } else {
        console.log(`  ✗ skipped (no valid data)`);
      }
    } catch (err) {
      console.warn(`  ✗ error fetching: ${err.message}`);
    }

    await sleep(REQUEST_DELAY);
  }

  // Deduplicate by URL
  const seen = new Set();
  const unique = events.filter(e => {
    if (seen.has(e.url)) return false;
    seen.add(e.url);
    return true;
  });

  console.log(`\nScraped ${unique.length} valid events.`);

  if (unique.length === 0) {
    console.error('ERROR: Zero events scraped. Not overwriting existing data.');
    process.exit(1);
  }

  if (!existsSync('data')) mkdirSync('data');
  writeFileSync('data/events.json', JSON.stringify(unique, null, 2));
  console.log('Written to data/events.json');
}

scrape().catch(err => {
  console.error('Scraper failed:', err);
  process.exit(1);
});
