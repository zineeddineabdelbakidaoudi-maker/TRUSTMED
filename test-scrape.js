require('dotenv').config();
const CnomScraper = require('./services/cnom/CnomScraper');

async function test() {
  const scraper = new CnomScraper();
  console.log('Testing CNOM 34/05660...');
  
  try {
    const result = await scraper.searchByCnomNumber('34/05660');
    console.log('\n--- SCRAPE RESULT ---');
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
