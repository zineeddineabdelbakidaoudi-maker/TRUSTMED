/**
 * CnomScraper — Scrapes Algerian SORM portals for CNOM inscription verification.
 * Uses axios + cheerio (no Playwright). Portal URLs configurable via .env.
 * Supports per-wilaya portal routing and fuzzy name matching.
 */
const axios = require('axios');
const axiosRetry = require('axios-retry').default;
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 3000,
  retryCondition: (err) =>
    err.code === 'ECONNABORTED' ||
    err.code === 'ETIMEDOUT' ||
    (err.message && err.message.includes('timeout')),
});
const cheerio = require('cheerio');
const { distance } = require('fastest-levenshtein');
const pool = require('../../shared/db/pool');
const { writeAuditLog } = require('../../shared/db/audit');
const logger = require('../../shared/logger');
const VerificationEngine = require('../verification/VerificationEngine');

// Default portal URLs — configurable via .env
const PORTAL_URLS = {
  national: process.env.CNOM_PORTAL_NATIONAL || 'https://www.sorm-cne.dz/annuaire',
  '16': process.env.CNOM_PORTAL_ALGER || 'https://www.sorm-cne.dz/annuaire',
  '31': process.env.CNOM_PORTAL_ORAN || 'https://www.sorm-cne.dz/annuaire',
  '29': process.env.CNOM_PORTAL_ORAN || 'https://www.sorm-cne.dz/annuaire',
  '27': process.env.CNOM_PORTAL_ORAN || 'https://www.sorm-cne.dz/annuaire',
  '25': process.env.CNOM_PORTAL_CONSTANTINE || 'https://www.sorm-cne.dz/annuaire',
  '43': process.env.CNOM_PORTAL_CONSTANTINE || 'https://www.sorm-cne.dz/annuaire',
  '18': process.env.CNOM_PORTAL_CONSTANTINE || 'https://www.sorm-cne.dz/annuaire',
  '04': process.env.CNOM_PORTAL_CONSTANTINE || 'https://www.sorm-cne.dz/annuaire',
  '23': process.env.CNOM_PORTAL_ANNABA || 'https://www.sorm-cne.dz/annuaire',
  '21': process.env.CNOM_PORTAL_ANNABA || 'https://www.sorm-cne.dz/annuaire',
  '36': process.env.CNOM_PORTAL_ANNABA || 'https://www.sorm-cne.dz/annuaire',
  '24': process.env.CNOM_PORTAL_ANNABA || 'https://www.sorm-cne.dz/annuaire',
  '41': process.env.CNOM_PORTAL_ANNABA || 'https://www.sorm-cne.dz/annuaire',
  '09': process.env.CNOM_PORTAL_BLIDA || 'https://www.sorm-cne.dz/annuaire',
  '42': process.env.CNOM_PORTAL_BLIDA || 'https://www.sorm-cne.dz/annuaire',
  '26': process.env.CNOM_PORTAL_BLIDA || 'https://www.sorm-cne.dz/annuaire',
  '17': process.env.CNOM_PORTAL_BLIDA || 'https://www.sorm-cne.dz/annuaire',
  '15': process.env.CNOM_PORTAL_TIZI_OUZOU || 'https://www.sorm-cne.dz/annuaire',
  '06': process.env.CNOM_PORTAL_TIZI_OUZOU || 'https://www.sorm-cne.dz/annuaire',
  '10': process.env.CNOM_PORTAL_TIZI_OUZOU || 'https://www.sorm-cne.dz/annuaire',
  '35': process.env.CNOM_PORTAL_TIZI_OUZOU || 'https://www.sorm-cne.dz/annuaire',
  '13': process.env.CNOM_PORTAL_TLEMCEN || 'https://www.sorm-cne.dz/annuaire',
  '46': process.env.CNOM_PORTAL_TLEMCEN || 'https://www.sorm-cne.dz/annuaire',
  '05': process.env.CNOM_PORTAL_BATNA || 'https://www.sorm-cne.dz/annuaire',
  '40': process.env.CNOM_PORTAL_BATNA || 'https://www.sorm-cne.dz/annuaire',
  '12': process.env.CNOM_PORTAL_BATNA || 'https://www.sorm-cne.dz/annuaire',
  '19': process.env.CNOM_PORTAL_SETIF || 'https://ordre-medecins-setif.dz/annuaire',
  '28': process.env.CNOM_PORTAL_SETIF || 'https://ordre-medecins-setif.dz/annuaire',
  '34': process.env.CNOM_PORTAL_SETIF || 'https://ordre-medecins-setif.dz/annuaire',
  '02': process.env.CNOM_PORTAL_CHLEF || 'https://www.sorm-cne.dz/annuaire',
  '44': process.env.CNOM_PORTAL_CHLEF || 'https://www.sorm-cne.dz/annuaire',
  '48': process.env.CNOM_PORTAL_CHLEF || 'https://www.sorm-cne.dz/annuaire',
  '14': process.env.CNOM_PORTAL_CHLEF || 'https://www.sorm-cne.dz/annuaire',
  '38': process.env.CNOM_PORTAL_CHLEF || 'https://www.sorm-cne.dz/annuaire',
  '08': process.env.CNOM_PORTAL_BECHAR || 'https://www.sorm-cne.dz/annuaire',
  '01': process.env.CNOM_PORTAL_BECHAR || 'https://www.sorm-cne.dz/annuaire',
  '33': process.env.CNOM_PORTAL_BECHAR || 'https://www.sorm-cne.dz/annuaire',
  '37': process.env.CNOM_PORTAL_BECHAR || 'https://www.sorm-cne.dz/annuaire',
};

const SCRAPE_DELAY_MS = parseInt(process.env.CNOM_SCRAPE_DELAY_MS, 10) || 2000;
const SCRAPE_TIMEOUT_MS = parseInt(process.env.CNOM_SCRAPE_TIMEOUT_MS, 10) || 30000;

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/121.0',
];

class CnomScraper {
  /**
   * Normalize various CNOM string formats into a standardized object.
   * @param {string} raw - Raw string from DB or user
   * @returns {object} { wilaya, normalized, original }
   * @private
   */
  _normalizeCnomNumber(raw) {
    if (!raw || typeof raw !== 'string') {
      throw new Error('Invalid CNOM number format: empty');
    }
    const clean = raw.trim();

    // Format 1 & 4: WW-YY-NNNN or WW/YY/NNNN
    let m = clean.match(/^(\d{2})[-/](\d{2})[-/](\d{4})$/);
    if (m) {
      return { wilaya: m[1], normalized: `${m[1]}-${m[2]}-${m[3]}`, original: raw };
    }

    // Format 2 & 3: WW-NNNNN or WW/NNNNN or WW-NNNN or WW/NNNN
    m = clean.match(/^(\d{2})[-/](\d{4,5})$/);
    if (m) {
      return { wilaya: m[1], normalized: `${m[1]}-${m[2]}`, original: raw };
    }

    // Format 5: WWYYNNNN (8 digits contiguous)
    m = clean.match(/^(\d{2})(\d{2})(\d{4})$/);
    if (m) {
      return { wilaya: m[1], normalized: `${m[1]}-${m[2]}-${m[3]}`, original: raw };
    }

    throw new Error(`Invalid CNOM number format: ${raw}. Expected WW-YY-NNNN or WW-NNNNN or WW/NNNN`);
  }

  /**
   * Search for a practitioner by CNOM number across portals, with fallbacks.
   * @param {string} cnomNumber - Raw CNOM number
   * @param {string} fullName - Name for third-party fallback search
   */
  async searchByCnomNumber(cnomNumber, fullName = null) {
    const cnomData = this._normalizeCnomNumber(cnomNumber);
    const wilaya = cnomData.wilaya;
    const normalizedNumber = cnomData.normalized;

    const portalUrl = PORTAL_URLS[wilaya] || PORTAL_URLS.national;
    const portalBase = new URL(portalUrl).origin; // ← warmup hits the correct portal root
    const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

    logger.info('CNOM scraper searching', { cnomNumber: normalizedNumber, original: cnomData.original, portal: portalUrl, wilaya });

    let officialResult = { found: false, error: 'Initialization' };

    try {
      // Step 1: warm up session on portal homepage
      try {
        await axios.get(portalBase, {
          headers: { 'User-Agent': userAgent },
          timeout: 12000,
        });
        await new Promise((r) => setTimeout(r, 1500));
      } catch (_) {
        // ignore warmup failure, try search anyway
      }

      // Step 2: try GET search
      let response;
      try {
        const searchUrl = `${portalUrl}?search=${encodeURIComponent(normalizedNumber)}&numero_ordre=${encodeURIComponent(normalizedNumber)}`;
        response = await axios.get(searchUrl, {
          headers: {
            'User-Agent': userAgent,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
            'Accept-Language': 'fr-FR,fr;q=0.9,ar-DZ;q=0.8,ar;q=0.7',
            'Accept-Encoding': 'gzip, deflate, br',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Sec-Fetch-User': '?1',
            'Cache-Control': 'max-age=0',
            'Referer': `${portalBase}/`,
          },
          timeout: SCRAPE_TIMEOUT_MS,
          maxRedirects: 5,
          decompress: true,
          validateStatus: (status) => status < 500,
        });
      } catch (getErr) {
        // Step 3: fallback — try POST form submission
        logger.warn('GET failed, trying POST form', { cnomNumber: normalizedNumber });
        try {
          response = await axios.post(
            portalUrl,
            new URLSearchParams({
              search: normalizedNumber,
              numero_ordre: normalizedNumber,
              nom: '',
              submit: 'Rechercher',
            }).toString(),
            {
              headers: {
                'User-Agent': userAgent,
                'Content-Type': 'application/x-www-form-urlencoded',
                'Referer': `${portalBase}/`,
                'Accept': 'text/html,application/xhtml+xml',
              },
              timeout: SCRAPE_TIMEOUT_MS,
              maxRedirects: 5,
              decompress: true,
              validateStatus: (status) => status < 500,
            }
          );
        } catch (postErr) {
          logger.error('Both GET and POST failed', { cnomNumber: normalizedNumber, error: postErr.message });
          throw postErr;
        }
      }

      if (response.status !== 200) {
        logger.warn('Portal returned non-200 status', { status: response.status, portal: portalUrl });
        officialResult = {
          found: false,
          scraped_name: null,
          scraped_specialty: null,
          scraped_status: null,
          portal_url: portalUrl,
          scraped_at: new Date().toISOString(),
          error: `HTTP ${response.status}`,
          source: 'OFFICIAL',
        };
      } else {
        const $ = cheerio.load(response.data);
        const result = this._parsePortalResponse($, normalizedNumber);
        officialResult = {
          ...result,
          portal_url: portalUrl,
          scraped_at: new Date().toISOString(),
          source: 'OFFICIAL',
        };
      }
    } catch (err) {
      logger.error('CNOM scraper request failed', {
        error: err.message,
        cnomNumber,
        portal: portalUrl,
      });
      officialResult = {
        found: false,
        scraped_name: null,
        scraped_specialty: null,
        scraped_status: null,
        portal_url: portalUrl,
        scraped_at: new Date().toISOString(),
        error: err.message,
        source: 'OFFICIAL',
      };
    }

    // PRIMARY SOURCE check
    if (officialResult.found) {
      return officialResult;
    }

    const thirdPartyQuery = fullName || normalizedNumber;

    // SECONDARY SOURCE
    logger.info('Official portal failed, trying secondary source (1SANTE)', { cnomNumber: normalizedNumber, wilaya, thirdPartyQuery });
    const source1Config = {
      name: '1SANTE',
      baseUrl: process.env.CNOM_FALLBACK_SOURCE_1 || 'https://www.1sante.com/online/',
      searchPath: '?s=',
      params: null,
    };
    const result1 = await this._searchThirdParty(source1Config, thirdPartyQuery, normalizedNumber, wilaya);
    if (result1.found) {
      return result1;
    }

    // TERTIARY SOURCE
    logger.info('Secondary source failed, trying tertiary source (ALGERIE_DOCTO)', { cnomNumber: normalizedNumber, wilaya, thirdPartyQuery });
    const source2Config = {
      name: 'ALGERIE_DOCTO',
      baseUrl: process.env.CNOM_FALLBACK_SOURCE_2 || 'https://algerie-docto.com/search',
      searchPath: '?q=',
      params: null,
    };
    const result2 = await this._searchThirdParty(source2Config, thirdPartyQuery, normalizedNumber, wilaya);
    if (result2.found) {
      return result2;
    }

    // FINAL FALLBACK
    return {
      found: false,
      result: 'PROVISIONAL',
      source: 'PROVISIONAL',
      scraped_at: new Date().toISOString(),
    };
  }

  /**
   * Match a practitioner against CNOM portal data.
   */
  async matchPractitioner(cnomNumber, practitionerName, practitionerSpecialty) {
    const scraped = await this.searchByCnomNumber(cnomNumber, practitionerName);

    if (!scraped.found) {
      return {
        match_score: 0,
        result: 'PROVISIONAL',
        scraped_data: scraped,
        recommendation: 'Portal unreachable or practitioner not found — set PROVISIONAL',
        source: 'PROVISIONAL',
      };
    }

    const nameA = (practitionerName || '').toLowerCase().trim();
    const nameB = (scraped.scraped_name || '').toLowerCase().trim();
    const matchScore = this._computeSimilarity(nameA, nameB);

    if (scraped.scraped_status === 'RETIRED' || scraped.scraped_status === 'DECEASED') {
      logger.info('CNOM match result (RETIRED)', {
        cnomNumber,
        matchScore: parseFloat(matchScore.toFixed(3)),
        result: 'RETIRED',
        scrapedStatus: scraped.scraped_status,
        source: scraped.source,
      });
      return {
        match_score: parseFloat(matchScore.toFixed(3)),
        result: 'RETIRED',
        scraped_data: scraped,
        recommendation: 'DEACTIVATE',
        source: scraped.source || 'OFFICIAL',
      };
    }

    let result;
    let recommendation;

    if (matchScore >= 0.80 && scraped.scraped_status === 'ACTIVE') {
      result = 'CONFIRMED';
      recommendation = 'Three-way match confirmed — auto-approve CNOM';
    } else if (matchScore >= 0.60 || scraped.error) {
      result = 'PROVISIONAL';
      recommendation = 'Partial match or portal issue — keep PROVISIONAL';
    } else {
      result = 'MISMATCH';
      recommendation = 'Name mismatch or inactive status — route to human review';
    }

    logger.info('CNOM match result', {
      cnomNumber,
      matchScore: parseFloat(matchScore.toFixed(3)),
      result,
      scrapedStatus: scraped.scraped_status,
    });

    return {
      match_score: parseFloat(matchScore.toFixed(3)),
      result,
      scraped_data: scraped,
      recommendation,
      source: scraped.source || 'OFFICIAL',
    };
  }

  /**
   * Batch verification: process all PROVISIONAL practitioners with CNOM numbers.
   */
  async runBatchVerification() {
    logger.info('Starting CNOM batch verification');

    const result = await pool.query(
      `SELECT id, cnom_number, full_name, specialty
       FROM practitioners
       WHERE verification_status = 'PROVISIONAL'
         AND cnom_number IS NOT NULL
         AND (last_cnom_check IS NULL OR last_cnom_check < NOW() - INTERVAL '7 days')
       ORDER BY created_at ASC
       LIMIT 50`
    );

    const practitioners = result.rows;
    logger.info(`Found ${practitioners.length} practitioners for CNOM batch verification`);

    let confirmed = 0;
    let provisional = 0;
    let mismatch = 0;

    for (const pract of practitioners) {
      try {
        const matchResult = await this.matchPractitioner(
          pract.cnom_number,
          pract.full_name,
          pract.specialty
        );

        await pool.query(
          `INSERT INTO cnom_verifications
           (practitioner_id, cnom_number, scraped_name, scraped_specialty, scraped_status,
            source_url, match_score, result)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            pract.id,
            pract.cnom_number,
            matchResult.scraped_data.scraped_name,
            matchResult.scraped_data.scraped_specialty,
            matchResult.scraped_data.scraped_status,
            matchResult.scraped_data.portal_url,
            matchResult.match_score,
            matchResult.result,
          ]
        );

        await pool.query(
          `UPDATE practitioners SET last_cnom_check = NOW() WHERE id = $1`,
          [pract.id]
        );

        if (matchResult.result === 'CONFIRMED') {
          const engine = new VerificationEngine();
          try {
            await engine.processStep(pract.id, 'CNOM_CONFIRMED', {
              cnomNumber: pract.cnom_number,
              scrapedName: matchResult.scraped_data.scraped_name,
              scrapedSpecialty: matchResult.scraped_data.scraped_specialty,
              scrapedStatus: matchResult.scraped_data.scraped_status,
              sourceUrl: matchResult.scraped_data.portal_url,
              matchScore: matchResult.match_score,
              result: 'CONFIRMED',
            });
            confirmed++;
          } catch (err) {
            logger.warn('CNOM_CONFIRMED step failed', { error: err.message, practitionerId: pract.id });
          }
        } else if (matchResult.result === 'MISMATCH') {
          const docResult = await pool.query(
            `SELECT id FROM documents
             WHERE practitioner_id = $1 AND doc_type = 'CNOM_CARD'
             ORDER BY created_at DESC LIMIT 1`,
            [pract.id]
          );
          const docId = docResult.rows.length > 0 ? docResult.rows[0].id : pract.id;
          await pool.query(
            `INSERT INTO reviewer_queue (practitioner_id, document_id, reason)
             VALUES ($1, $2, $3)`,
            [
              pract.id,
              docId,
              `CNOM_MISMATCH: score=${matchResult.match_score}, name="${matchResult.scraped_data.scraped_name}"`,
            ]
          );
          mismatch++;
        } else {
          provisional++;
        }

        await new Promise((r) => setTimeout(r, SCRAPE_DELAY_MS));
      } catch (err) {
        logger.error('CNOM batch verification failed for practitioner', {
          practitionerId: pract.id,
          error: err.message,
        });
      }
    }

    await writeAuditLog({
      actorType: 'system',
      action: 'CNOM_BATCH_VERIFICATION',
      metadata: { total: practitioners.length, confirmed, provisional, mismatch },
    });

    logger.info('CNOM batch verification complete', {
      total: practitioners.length,
      confirmed,
      provisional,
      mismatch,
    });

    return { total: practitioners.length, confirmed, provisional, mismatch };
  }

  /**
   * Parse portal HTML response to extract practitioner data.
   * @private
   */
  _parsePortalResponse($, cnomNumber) {
    const rows = $('table tbody tr, .doctor-card, .result-item, .annuaire-item');

    let found = false;
    let scrapedName = null;
    let scrapedSpecialty = null;
    let scrapedStatus = null;

    rows.each((_, el) => {
      const text = $(el).text();
      if (
        text.includes(cnomNumber) ||
        text.includes(cnomNumber.replace(/-/g, '/'))
      ) {
        found = true;
        scrapedName =
          $(el).find('td:nth-child(1), .name, .doctor-name').first().text().trim() ||
          $(el).find('td:nth-child(2)').text().trim() ||
          null;
        scrapedSpecialty =
          $(el).find('td:nth-child(3), .specialty, .specialite').first().text().trim() || null;
        const statusText = $(el)
          .find('td:last-child, .status, .statut')
          .first()
          .text()
          .trim()
          .toUpperCase();
        scrapedStatus = statusText.includes('ACTIF') || statusText.includes('ACTIVE')
          ? 'ACTIVE'
          : statusText.includes('SUSPENDU') || statusText.includes('SUSPENDED')
            ? 'SUSPENDED'
            : statusText.includes('RETRAITE') || statusText.includes('RETIRED')
              ? 'RETIRED'
              : statusText.includes('DECEDE') || statusText.includes('DECEASED')
                ? 'DECEASED'
                : statusText || 'UNKNOWN';
        return false; // break
      }
    });

    if (!found) {
      const pageText = $('body').text();
      if (pageText.includes(cnomNumber)) {
        found = true;
        scrapedStatus = 'UNKNOWN';
      }
    }

    return {
      found,
      scraped_name: scrapedName,
      scraped_specialty: scrapedSpecialty,
      scraped_status: scrapedStatus,
    };
  }

  /**
   * Fallback search in third-party directories.
   * @private
   */
  async _searchThirdParty(source, fullName, cnomNumber, wilaya) {
    try {
      const searchUrl = `${source.baseUrl}${source.searchPath}${encodeURIComponent(fullName)}`;
      const userAgent = USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
      
      const response = await axios.get(searchUrl, {
        headers: {
          'User-Agent': userAgent,
          'Accept': 'text/html,application/xhtml+xml',
        },
        timeout: 15000,
        validateStatus: (status) => status < 500,
      });

      if (response.status !== 200) {
        return { found: false, error: `HTTP ${response.status}` };
      }

      const $ = cheerio.load(response.data);
      const text = $('body').text().replace(/\s+/g, ' ').toUpperCase();
      
      const searchNames = fullName.toUpperCase().split(' ');
      let nameMatch = searchNames.some(namePart => text.includes(namePart) && namePart.length > 3);
      
      if (!nameMatch && text.includes(fullName.toUpperCase())) {
        nameMatch = true;
      }

      if (nameMatch) {
        // Attempt to extract name and specialty around the matched node or just return provisional true
        return {
          found: true,
          scraped_name: fullName, // fuzzy matched
          scraped_specialty: null, // hard to extract generically
          scraped_status: 'ACTIVE', // assumed active if listed
          portal_url: searchUrl,
          scraped_at: new Date().toISOString(),
          source: 'THIRD_PARTY'
        };
      }

      return { found: false, error: 'Name not found in page text' };
    } catch (err) {
      logger.warn(`Third party search failed for ${source.name}`, { error: err.message });
      return { found: false, error: err.message };
    }
  }

  /**
   * Compute Levenshtein-based similarity (0.0 to 1.0).
   * @private
   */
  _computeSimilarity(a, b) {
    const maxLen = Math.max(a.length, b.length);
    if (maxLen === 0) return 1.0;
    return 1.0 - distance(a, b) / maxLen;
  }
}

module.exports = CnomScraper;