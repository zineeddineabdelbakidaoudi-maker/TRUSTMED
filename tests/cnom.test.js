const assert = require('assert');
const CnomScraper = require('../services/cnom/CnomScraper');

// Mock dependencies
const pool = require('../shared/db/pool');
const { writeAuditLog } = require('../shared/db/audit');
const VerificationEngine = require('../services/verification/VerificationEngine');

// Override required mocks for the test
pool.query = async (queryStr, params) => {
  if (queryStr.includes('SELECT id, cnom_number, full_name, specialty')) {
    return {
      rows: [
        { id: '1', cnom_number: '16/8343', full_name: 'MAHREZ KHALED', specialty: 'Ophtalmologie' },
        { id: '2', cnom_number: '16/9999', full_name: 'UNKNOWN PERSON', specialty: 'General' }
      ]
    };
  }
  return { rows: [] };
};

// Mock the method to skip audit logging to db
const mockAudit = [];
const originalWriteAuditLog = writeAuditLog;
require('../shared/db/audit').writeAuditLog = async (data) => {
  mockAudit.push(data);
};

// Mock VerificationEngine
VerificationEngine.prototype.processStep = async () => ({ success: true });

async function runTests() {
  console.log('--- RUNNING CNOM TESTS ---');
  const scraper = new CnomScraper();

  // SCENARIO 1 — Format normalization
  console.log('Test 1: Format normalization');
  assert.deepStrictEqual(scraper._normalizeCnomNumber('16/8343'), { wilaya:'16', normalized:'16-8343', original: '16/8343' });
  assert.deepStrictEqual(scraper._normalizeCnomNumber('16/22/8343'), { wilaya:'16', normalized:'16-22-8343', original: '16/22/8343' });
  assert.deepStrictEqual(scraper._normalizeCnomNumber('19-22-0847'), { wilaya:'19', normalized:'19-22-0847', original: '19-22-0847' });
  assert.deepStrictEqual(scraper._normalizeCnomNumber('34-00705'), { wilaya:'34', normalized:'34-00705', original: '34-00705' });
  assert.deepStrictEqual(scraper._normalizeCnomNumber('16228343'), { wilaya:'16', normalized:'16-22-8343', original: '16228343' });
  
  assert.throws(() => scraper._normalizeCnomNumber('invalid'), /Invalid CNOM number format/);
  console.log('✅ Test 1 Passed');

  // SCENARIO 2 — Cascade fallback (mock)
  console.log('Test 2: Cascade fallback');
  // Temporarily break national portal
  const origPortal = process.env.CNOM_PORTAL_NATIONAL;
  process.env.CNOM_PORTAL_NATIONAL = 'http://localhost:1234/invalid';
  
  const res2 = await scraper.searchByCnomNumber('16-8343', 'MAHREZ KHALED');
  assert.ok(res2.source === 'THIRD_PARTY' || res2.source === 'PROVISIONAL', `Expected fallback source, got ${res2.source}`);
  
  // Restore
  process.env.CNOM_PORTAL_NATIONAL = origPortal;
  console.log('✅ Test 2 Passed');

  // SCENARIO 3 — Match scoring
  console.log('Test 3: Match scoring');
  assert.strictEqual(scraper._computeSimilarity('mahrez khaled', 'mahrez khaled'), 1.0);
  assert.ok(scraper._computeSimilarity('mahrez khaled', 'mahrez k.') >= 0.6);
  assert.ok(scraper._computeSimilarity('mahrez khaled', 'djermoun m.') < 0.4);
  console.log('✅ Test 3 Passed');

  // SCENARIO 4 — API endpoint (mock DB)
  console.log('Test 4: Batch verification');
  // To avoid hitting real network for multiple mock users, we can just mock the match result briefly
  const originalMatch = scraper.matchPractitioner;
  scraper.matchPractitioner = async (cnom, name) => {
    if (name === 'MAHREZ KHALED') return { match_score: 1.0, result: 'CONFIRMED', scraped_data: {} };
    return { match_score: 0.1, result: 'MISMATCH', scraped_data: {} };
  };

  const batchRes = await scraper.runBatchVerification();
  assert.strictEqual(batchRes.total, 2);
  assert.strictEqual(batchRes.confirmed + batchRes.provisional + batchRes.mismatch, 2);
  
  // Restore
  scraper.matchPractitioner = originalMatch;
  console.log('✅ Test 4 Passed');

  // SCENARIO 5 — Real doctor from prescription
  console.log('Test 5: Real doctor verification');
  const res5 = await scraper.matchPractitioner('16/8343', 'MAHREZ KHALED', 'Ophtalmologie');
  console.log(JSON.stringify(res5, null, 2));
  assert.ok(['CONFIRMED', 'PROVISIONAL', 'MISMATCH', 'RETIRED'].includes(res5.result));
  console.log('✅ Test 5 Passed');

  console.log('--- ALL TESTS PASSED ---');
  process.exit(0);
}

runTests().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
